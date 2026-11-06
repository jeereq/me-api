import type { Prisma, PrismaClient } from '@prisma/client';

import { montantCotisation, periodeDuJour, periodesDepuis, prenomDe, type RythmeCotisation } from '../../commun/cotisations.js';
import { horsCoffre } from '../../utils/coffre.js';
import { HttpError } from '../../utils/http.js';
import type { EtatCommande } from '../abonnements/flexpaie.js';
import { local } from '../integrations/http.js';

/**
 * Anciennes collectes, remplacées par les groupes de cotisation. On ne peut plus en créer ni y payer : elles restent en lecture,
 * leur organisateur peut effacer leurs données, et un paiement déjà parti reste vérifié et compté.
 */

const REVERIFIABLES = ['en_attente', 'expire', 'abandonne'];
const ATTENTE_MS = 86400000;
const RATTRAPAGE_MS = 7 * 86400000;
const RATTRAPAGE_PAS_MS = 3600000;

type Contact = { nom: string; telephone: string };
type Avis = { cle: string; titre: string; corps: string; parEmail: boolean };
export type DepsCotisations = {
  db: Pick<PrismaClient, 'cotisation' | 'cotisationMembre' | 'paiementCotisation'>;
  flexpaie: {
    verifier(commande: string): Promise<{ etat: EtatCommande; transaction: { amount?: string; currency?: string } | null; message: string }>;
  };
  flexpaiePret(): boolean;
  prevenir(userId: string, avis: Avis): Promise<void>;
  maintenant?: () => number;
};

const AVEC_TOUT = { user: { select: { nom: true, fuseau: true } }, membres: { orderBy: { createdAt: 'asc' }, include: { paiements: true } }, paiements: { where: { mode: 'mobile', statut: 'paye' }, select: { montant: true } } } satisfies Prisma.CotisationInclude;
type CotisationComplete = Prisma.CotisationGetPayload<{ include: typeof AVEC_TOUT }>;
type APayer = { id: string; commande: string | null; statut: string; montant: number; devise: string; reference: string };

export function creerCotisations(d: DepsCotisations) {
  const maintenant = () => d.maintenant?.() ?? Date.now();
  const jourDe = (fuseau: string, instant: Date = new Date(maintenant())) => local(instant, fuseau).date;
  let dernierRattrapageLong = 0;

  function vue(c: CotisationComplete) {
    const jour = jourDe(c.user.fuseau);
    const rythme = c.rythme as RythmeCotisation;
    return {
      id: c.id,
      titre: c.titre,
      montant: c.montant,
      devise: c.devise,
      rythme,
      archive: c.archive,
      periode: periodeDuJour(rythme, jour),
      periodes: periodesDepuis(rythme, c.debut, jour).slice(-12),
      encaisse: c.paiements.reduce((s, p) => s + p.montant, 0),
      membres: c.membres.flatMap((m) => {
        const contact = horsCoffre<Contact>(m.contact);
        if (!contact) return [];
        return [
          {
            id: m.id,
            nom: contact.nom,
            depuis: periodeDuJour(rythme, jourDe(c.user.fuseau, m.createdAt)),
            demandePeriode: m.demandePeriode,
            paiements: m.paiements.filter((p) => p.statut === 'paye' || p.statut === 'en_attente').map((p) => ({ periode: p.periode, statut: p.statut, mode: p.mode, montant: p.montant })),
          },
        ];
      }),
    };
  }

  async function complete(userId: string, id: string) {
    const c = await d.db.cotisation.findFirst({ where: { id, userId }, include: AVEC_TOUT });
    if (!c) throw new HttpError(404, 'Collecte introuvable.');
    return c;
  }
  async function conclure(p: APayer, etat: EtatCommande, message = '') {
    if (etat === 'en_attente') return;
    const fait = await d.db.paiementCotisation.updateMany({
      where: { id: p.id, statut: { in: REVERIFIABLES } },
      data: { statut: etat, message: message || null, ...(etat === 'paye' ? { payeLe: new Date(maintenant()) } : {}) },
    });
    if (!fait.count || etat !== 'paye') return;
    const trace = await d.db.paiementCotisation.findUnique({ where: { id: p.id }, select: { membre: { select: { contact: true } }, cotisation: { select: { userId: true, titre: true } } } });
    if (!trace?.cotisation) return;
    const nom = trace.membre ? prenomDe(horsCoffre<Contact>(trace.membre.contact)?.nom ?? '') : '';
    await d
      .prevenir(trace.cotisation.userId, { cle: `cotisation:paiement:${p.reference}`, titre: `${nom || 'Un membre'} a payé ${montantCotisation(p.montant, p.devise)}`, corps: `Collecte « ${trace.cotisation.titre} ».`, parEmail: false })
      .catch((e) => console.error('Avis de cotisation', e));
  }

  /** Rien n'est cru sur parole : l'état, le montant et la devise viennent de FlexPaie. */
  async function verifier(p: APayer) {
    if (!REVERIFIABLES.includes(p.statut) || !p.commande || !d.flexpaiePret()) return;
    try {
      const r = await d.flexpaie.verifier(p.commande);
      if (r.etat === 'paye') {
        const montant = r.transaction?.amount;
        if (!montant) {
          console.error(`FlexPaie : paiement sans montant pour la commande ${p.commande}`);
          return;
        }
        if (Math.round(Number(montant) * 100) !== p.montant || (r.transaction?.currency && r.transaction.currency !== p.devise)) {
          console.error(`FlexPaie : montant inattendu pour la commande ${p.commande}`);
          await conclure(p, 'echoue', 'Montant reçu différent du montant demandé.');
          return;
        }
      }
      if (r.etat === 'echoue' && p.statut !== 'en_attente') return;
      await conclure(p, r.etat, r.etat === 'echoue' ? r.message || 'Paiement refusé ou annulé.' : '');
    } catch (e) {
      console.error('FlexPaie : vérification impossible', e);
    }
  }

  return {
    async liste(userId: string) {
      const cotisations = await d.db.cotisation.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, include: AVEC_TOUT });
      return { cotisations: cotisations.map(vue) };
    },

    /** Efface les noms et les numéros. L'argent déjà encaissé doit rester visible : cette collecte-là n'est pas supprimée. */
    async supprimer(userId: string, id: string) {
      await complete(userId, id);
      const argent = await d.db.paiementCotisation.count({ where: { cotisationId: id, mode: 'mobile', statut: { in: ['paye', 'en_attente'] } } });
      if (argent) throw new HttpError(409, 'Des paiements en ligne existent : cette collecte ne peut pas être supprimée.');
      await d.db.paiementCotisation.deleteMany({ where: { cotisationId: id, mode: 'main' } });
      await d.db.cotisation.delete({ where: { id } });
      return { ok: true };
    },

    /** Une personne demande à sortir : son nom et son numéro sont effacés, les traces d'argent restent. */
    async retirerMembre(userId: string, membreId: string) {
      const m = await d.db.cotisationMembre.findFirst({ where: { id: membreId, cotisation: { userId } }, include: { paiements: true } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      if (m.paiements.some((p) => p.statut === 'en_attente')) throw new HttpError(409, 'Un paiement est en cours pour ce membre.');
      await d.db.paiementCotisation.deleteMany({ where: { membreId: m.id, mode: 'main' } });
      await d.db.cotisationMembre.delete({ where: { id: m.id } });
      return { cotisation: vue(await complete(userId, m.cotisationId)) };
    },

    /** Appelée par FlexPaie : seule la référence sert, le paiement est revérifié chez eux. */
    async retour(corps: Record<string, unknown>) {
      const commande = typeof corps.orderNumber === 'string' ? corps.orderNumber : null;
      const ref = typeof corps.reference === 'string' ? corps.reference : null;
      if (!commande && !ref) return { ok: true };
      const p = await d.db.paiementCotisation.findFirst({ where: { mode: 'mobile', OR: [...(commande ? [{ commande }] : []), ...(ref ? [{ reference: ref }] : [])] } });
      if (p) await verifier(p);
      return { ok: true };
    },

    /** Toutes les 5 minutes : mêmes délais que les abonnements (24 h en attente, puis une fois par heure pendant 7 jours). */
    async rattraper(instant = maintenant()) {
      const attente = await d.db.paiementCotisation.findMany({ where: { statut: 'en_attente', commande: { not: null }, createdAt: { gt: new Date(instant - ATTENTE_MS) } } });
      for (const p of attente) await verifier(p);
      await d.db.paiementCotisation.updateMany({ where: { statut: 'en_attente', createdAt: { lte: new Date(instant - ATTENTE_MS) } }, data: { statut: 'expire', message: 'Paiement non validé à temps.' } });
      if (instant - dernierRattrapageLong < RATTRAPAGE_PAS_MS) return;
      dernierRattrapageLong = instant;
      const tardifs = await d.db.paiementCotisation.findMany({ where: { statut: { in: ['expire', 'abandonne'] }, commande: { not: null }, createdAt: { gt: new Date(instant - RATTRAPAGE_MS) } } });
      for (const p of tardifs) await verifier(p);
    },
  };
}
