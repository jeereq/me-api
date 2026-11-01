import { randomBytes } from 'node:crypto';

import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';
import { abonnementsActifs, etatAbonnement, finEssaiEffective, FONCTIONS_PRO, OFFRES, prolonger, VERSION_CGV, type Periode } from './abonnements/offres.js';
import { ErreurFlexpaie, Flexpaie, flexpaieConfigure, normaliserTelephone, type EtatCommande } from './abonnements/flexpaie.js';
import { NotificationService } from './NotificationService.js';

/** Statuts encore revérifiables chez FlexPaie : un paiement validé en retard ouvre quand même Pro. */
const REVERIFIABLES = ['en_attente', 'expire', 'abandonne'];
/** Sans réponse de FlexPaie après ce délai, un paiement en attente passe en `expire`. */
const ATTENTE_MS = 86400000;
/** Un paiement expiré ou abandonné est revérifié une fois par heure pendant 7 jours. */
const RATTRAPAGE_MS = 7 * 86400000;
const RATTRAPAGE_PAS_MS = 3600000;
let dernierRattrapageLong = 0;

const CHAMPS = { id: true, role: true, essaiJusqua: true, abonnementPeriode: true, abonnementFinLe: true } as const;
const VUE_PAIEMENT = { reference: true, periode: true, montant: true, devise: true, statut: true, message: true, payeLe: true, createdAt: true } as const;
type APayer = { id: string; commande: string | null; statut: string; montant: number; devise: string };

const adresseServeur = () => (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

function pretPourPayer() {
  if (!abonnementsActifs()) throw new HttpError(503, 'Les abonnements ne sont pas activés sur ce serveur.');
  if (!flexpaieConfigure()) throw new HttpError(503, "Le paiement n'est pas encore configuré sur le serveur. Réessaie plus tard.");
  if (!adresseServeur().startsWith('https://')) throw new HttpError(503, "L'adresse publique du serveur (PUBLIC_URL, en https) n'est pas configurée : FlexPaie ne pourrait pas confirmer le paiement.");
}

/**
 * Applique le résultat vérifié d'une commande. Le passage à « payé » se fait une seule fois (mise à jour
 * conditionnelle), même si le retour de FlexPaie, l'app et la tâche planifiée vérifient en même temps.
 * Un paiement expiré ou abandonné qui s'avère payé ouvre Pro aussi : la personne en est prévenue.
 */
async function conclure(id: string, etat: EtatCommande, message = '') {
  if (etat === 'en_attente') return;
  const tardif = await prisma.$transaction(async (tx) => {
    const avant = await tx.paiement.findUniqueOrThrow({ where: { id }, select: { statut: true } });
    const fait = await tx.paiement.updateMany({ where: { id, statut: { in: REVERIFIABLES } }, data: { statut: etat, message: message || null, ...(etat === 'paye' ? { payeLe: new Date() } : {}) } });
    if (!fait.count || etat !== 'paye') return null;
    const p = await tx.paiement.findUniqueOrThrow({ where: { id }, select: { userId: true, periode: true, reference: true } });
    // Compte supprimé entre-temps : le paiement reste noté, il n'y a plus d'abonnement à ouvrir.
    if (!p.userId) return null;
    const u = await tx.user.findUniqueOrThrow({ where: { id: p.userId }, select: { abonnementFinLe: true, essaiJusqua: true } });
    const periode = p.periode as Periode;
    const fin = prolonger(u.abonnementFinLe, periode, new Date(), finEssaiEffective(u.essaiJusqua));
    await tx.user.update({ where: { id: p.userId }, data: { abonnementPeriode: periode, abonnementFinLe: fin } });
    return avant.statut === 'en_attente' ? null : { userId: p.userId, reference: p.reference, fin };
  });
  if (tardif) {
    const jour = tardif.fin.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    await NotificationService.avisCompte(tardif.userId, {
      cle: `abonnement:paiement:${tardif.reference}`,
      titre: 'Ton paiement est arrivé : Pro est ouvert',
      corps: `Ton opérateur a confirmé le paiement ${tardif.reference} avec du retard. Pro est ouvert jusqu'au ${jour}.`,
      parEmail: true,
    }).catch((e) => console.error('Avis de paiement tardif', e));
  }
}

/** Revérifie chez FlexPaie un paiement pas encore conclu, et l'applique s'il l'est. */
async function verifier(p: APayer) {
  if (!REVERIFIABLES.includes(p.statut) || !p.commande || !flexpaieConfigure()) return;
  try {
    const r = await Flexpaie.verifier(p.commande);
    if (r.etat === 'paye') {
      const montant = r.transaction?.amount;
      // Sans montant confirmé, on n'ouvre rien : le paiement reste à revérifier (et visible pour l'admin).
      if (!montant) {
        console.error(`FlexPaie : paiement sans montant pour la commande ${p.commande}`, r.transaction);
        return;
      }
      // Un montant ou une devise différents de la commande : on ne l'accepte pas.
      if (Math.round(Number(montant) * 100) !== p.montant || (r.transaction?.currency && r.transaction.currency !== p.devise)) {
        console.error(`FlexPaie : montant inattendu pour la commande ${p.commande}`, r.transaction);
        await conclure(p.id, 'echoue', 'Montant reçu différent du prix : contacte-nous.');
        return;
      }
    }
    // Un paiement expiré ou abandonné qui reste « en attente » ou « échoué » chez FlexPaie garde son statut.
    if (r.etat === 'echoue' && p.statut !== 'en_attente') return;
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
    // Tant qu'un paiement attend la validation, on n'en lance pas un autre : l'app propose de l'abandonner d'abord.
    const enCours = await prisma.paiement.findFirst({ where: { userId, statut: 'en_attente' } });
    if (enCours) {
      throw new HttpError(409, 'Un paiement est déjà en attente : valide-le sur ton téléphone, ou abandonne cette demande avant d’en faire une autre.', 'PAIEMENT_EN_COURS');
    }

    const offre = OFFRES.pro[periode];
    const p = await prisma.paiement.create({
      data: {
        userId, periode, montant: offre.prix, devise: OFFRES.devise, telephone, cgvVersion: VERSION_CGV, accesImmediat: true,
        reference: `ME${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`,
      },
    });
    try {
      const r = await Flexpaie.demander({ telephone, reference: p.reference, montant: p.montant, devise: p.devise, retour: `${adresseServeur()}/api/abonnement/flexpaie/retour` });
      await prisma.paiement.update({ where: { id: p.id }, data: { commande: r.commande } });
      // Dernières CGV acceptées, gardées aussi sur le compte (la preuve de chaque période est sur son paiement).
      await prisma.user.update({ where: { id: userId }, data: { cgvAccepteesLe: new Date(), cgvVersion: VERSION_CGV } });
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

  /**
   * Le client renonce à un paiement en attente (demande jamais reçue, mauvais numéro) pour pouvoir en refaire un.
   * Le paiement reste revérifié : s'il est validé quand même, il compte.
   */
  async abandonner(userId: string, reference: string) {
    const p = await prisma.paiement.findFirst({ where: { userId, reference } });
    if (!p) throw new HttpError(404, 'Paiement introuvable.');
    // Dernière vérification : s'il vient d'être validé, on l'applique au lieu de l'abandonner.
    await verifier(p);
    await prisma.paiement.updateMany({ where: { id: p.id, statut: 'en_attente' }, data: { statut: 'abandonne', message: 'Demande abandonnée.' } });
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

  /**
   * Tâche planifiée (toutes les 5 minutes). Les paiements en attente (retour de FlexPaie perdu) sont revérifiés à
   * chaque passage pendant 24 h, puis passent en `expire`. Les paiements expirés ou abandonnés sont revérifiés une
   * fois par heure pendant 7 jours : un paiement validé en retard ouvre quand même Pro.
   */
  async rattraper(maintenant = Date.now()) {
    const attente = await prisma.paiement.findMany({ where: { statut: 'en_attente', commande: { not: null }, createdAt: { gt: new Date(maintenant - ATTENTE_MS) } }, take: 50 });
    for (const p of attente) await verifier(p);
    await prisma.paiement.updateMany({
      where: { statut: 'en_attente', createdAt: { lte: new Date(maintenant - ATTENTE_MS) } },
      data: { statut: 'expire', message: 'Paiement non validé à temps. Si ton opérateur le confirme plus tard, Pro s’ouvrira.' },
    });
    if (maintenant - dernierRattrapageLong < RATTRAPAGE_PAS_MS) return;
    dernierRattrapageLong = maintenant;
    const tardifs = await prisma.paiement.findMany({ where: { statut: { in: ['expire', 'abandonne'] }, commande: { not: null }, createdAt: { gt: new Date(maintenant - RATTRAPAGE_MS) } }, take: 200 });
    for (const p of tardifs) await verifier(p);
  },
};
