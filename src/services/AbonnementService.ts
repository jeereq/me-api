import { randomBytes } from 'node:crypto';

import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';
import { abonnementsActifs, etatAbonnement, FONCTIONS_PRO, OFFRES, prolonger, VERSION_CGV, type Periode } from './abonnements/offres.js';
import { ErreurFlexpaie, Flexpaie, flexpaieConfigure, normaliserTelephone, type EtatCommande } from './abonnements/flexpaie.js';

const CHAMPS = { id: true, role: true, essaiJusqua: true, abonnementPeriode: true, abonnementFinLe: true } as const;
const VUE_PAIEMENT = { reference: true, periode: true, montant: true, devise: true, statut: true, message: true, payeLe: true, createdAt: true } as const;

const adresseServeur = () => (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

function pretPourPayer() {
  if (!abonnementsActifs()) throw new HttpError(503, 'Les abonnements ne sont pas activés sur ce serveur.');
  if (!flexpaieConfigure()) throw new HttpError(503, "Le paiement n'est pas encore configuré sur le serveur. Réessaie plus tard.");
  if (!adresseServeur().startsWith('https://')) throw new HttpError(503, "L'adresse publique du serveur (PUBLIC_URL, en https) n'est pas configurée : FlexPaie ne pourrait pas confirmer le paiement.");
}

/**
 * Applique le résultat vérifié d'une commande. Le passage « en attente → payé » se fait une seule fois
 * (mise à jour conditionnelle), même si le retour de FlexPaie et l'app vérifient en même temps.
 */
async function conclure(id: string, etat: EtatCommande, message = '') {
  if (etat === 'en_attente') return;
  await prisma.$transaction(async (tx) => {
    const fait = await tx.paiement.updateMany({ where: { id, statut: 'en_attente' }, data: { statut: etat, message: message || null, ...(etat === 'paye' ? { payeLe: new Date() } : {}) } });
    if (!fait.count || etat !== 'paye') return;
    const p = await tx.paiement.findUniqueOrThrow({ where: { id }, select: { userId: true, periode: true } });
    const u = await tx.user.findUniqueOrThrow({ where: { id: p.userId }, select: { abonnementFinLe: true } });
    const periode = p.periode as Periode;
    await tx.user.update({ where: { id: p.userId }, data: { abonnementPeriode: periode, abonnementFinLe: prolonger(u.abonnementFinLe, periode) } });
  });
}

/** Revérifie chez FlexPaie un paiement encore en attente, et l'applique s'il est conclu. */
async function verifier(p: { id: string; commande: string | null; statut: string; montant: number; devise: string }) {
  if (p.statut !== 'en_attente' || !p.commande || !flexpaieConfigure()) return;
  try {
    const r = await Flexpaie.verifier(p.commande);
    // Un montant ou une devise différents de la commande : on ne l'accepte pas.
    if (r.etat === 'paye' && r.transaction?.amount && (Math.round(Number(r.transaction.amount) * 100) !== p.montant || (r.transaction.currency && r.transaction.currency !== p.devise))) {
      console.error(`FlexPaie : montant inattendu pour la commande ${p.commande}`, r.transaction);
      await conclure(p.id, 'echoue', 'Montant reçu différent du prix : contacte-nous.');
      return;
    }
    await conclure(p.id, r.etat, r.etat === 'echoue' ? r.message || 'Paiement refusé ou annulé.' : '');
  } catch (e) {
    console.error('FlexPaie : vérification impossible', e);
  }
}

export const AbonnementService = {
  /** Catalogue public : prix, essai et ce que Pro débloque. */
  offres() {
    return { actif: abonnementsActifs(), paiement: abonnementsActifs() && flexpaieConfigure(), versionCgv: VERSION_CGV, ...OFFRES, fonctions: FONCTIONS_PRO };
  },

  async etat(userId: string) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: CHAMPS });
    const paiements = await prisma.paiement.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10, select: VUE_PAIEMENT });
    return { abonnement: etatAbonnement(u), paiements };
  },

  /**
   * Demande un paiement mobile money pour une période Pro. Le compte a accepté les CGV et demandé l'accès immédiat
   * (noté avec la version des CGV). Le client valide ensuite sur son téléphone.
   */
  async payer(userId: string, periode: Periode, telephoneBrut: string) {
    pretPourPayer();
    const telephone = normaliserTelephone(telephoneBrut);
    if (!telephone) throw new HttpError(400, 'Numéro de téléphone invalide. Écris-le avec l’indicatif, par exemple 243 81 234 5678.');
    const enCours = await prisma.paiement.findFirst({ where: { userId, statut: 'en_attente', createdAt: { gt: new Date(Date.now() - 10 * 60000) } } });
    if (enCours) throw new HttpError(409, 'Un paiement est déjà en attente : valide-le sur ton téléphone, ou réessaie dans quelques minutes.', 'PAIEMENT_EN_COURS');

    await prisma.user.update({ where: { id: userId }, data: { cgvAccepteesLe: new Date(), cgvVersion: VERSION_CGV } });
    const offre = OFFRES.pro[periode];
    const p = await prisma.paiement.create({
      data: { userId, periode, montant: offre.prix, devise: OFFRES.devise, telephone, reference: `ME${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}` },
    });
    try {
      const r = await Flexpaie.demander({ telephone, reference: p.reference, montant: p.montant, devise: p.devise, retour: `${adresseServeur()}/api/abonnement/flexpaie/retour` });
      await prisma.paiement.update({ where: { id: p.id }, data: { commande: r.commande } });
    } catch (e) {
      await prisma.paiement.update({ where: { id: p.id }, data: { statut: 'echoue', message: (e as Error).message } });
      if (e instanceof ErreurFlexpaie) {
        console.error('FlexPaie', e.message);
        throw new HttpError(502, "La demande de paiement n'a pas pu partir. Vérifie le numéro et réessaie.");
      }
      throw e;
    }
    return { paiement: await prisma.paiement.findUniqueOrThrow({ where: { id: p.id }, select: VUE_PAIEMENT }) };
  },

  /** Où en est un paiement : l'app interroge pendant que le client valide sur son téléphone. */
  async suivre(userId: string, reference: string) {
    const p = await prisma.paiement.findFirst({ where: { userId, reference } });
    if (!p) throw new HttpError(404, 'Paiement introuvable.');
    await verifier(p);
    return { paiement: await prisma.paiement.findUniqueOrThrow({ where: { id: p.id }, select: VUE_PAIEMENT }), ...(await this.etat(userId)) };
  },

  /** Retour de FlexPaie après le paiement. Son contenu sert seulement à retrouver la commande, revérifiée chez FlexPaie. */
  async retour(corps: Record<string, unknown>) {
    const commande = typeof corps.orderNumber === 'string' ? corps.orderNumber : null;
    const reference = typeof corps.reference === 'string' ? corps.reference : null;
    if (!commande && !reference) return { ok: true };
    const p = await prisma.paiement.findFirst({ where: { OR: [...(commande ? [{ commande }] : []), ...(reference ? [{ reference }] : [])] } });
    if (p) await verifier(p);
    return { ok: true };
  },

  /** Paiements restés en attente (retour de FlexPaie perdu) : revérifiés pendant 24 h par la tâche planifiée. */
  async rattraper() {
    const attente = await prisma.paiement.findMany({ where: { statut: 'en_attente', commande: { not: null }, createdAt: { gt: new Date(Date.now() - 86400000) } }, take: 50 });
    for (const p of attente) await verifier(p);
    await prisma.paiement.updateMany({ where: { statut: 'en_attente', createdAt: { lte: new Date(Date.now() - 86400000) } }, data: { statut: 'echoue', message: 'Paiement non validé à temps.' } });
  },
};
