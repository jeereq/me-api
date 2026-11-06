import { randomBytes } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import { libellePeriode, montantCotisation, numeroMasque, periodeDuJour, periodesDepuis, premierePeriodeDue, prenomDe, type RythmeCotisation } from '../../commun/cotisations.js';
import { enCoffre, horsCoffre } from '../../utils/coffre.js';
import { HttpError } from '../../utils/http.js';
import { ErreurFlexpaie, normaliserTelephone, type EtatCommande } from '../abonnements/flexpaie.js';
import { local } from '../integrations/http.js';

/** Encore revérifiables chez FlexPaie : un paiement validé en retard compte quand même. */
const REVERIFIABLES = ['en_attente', 'expire', 'abandonne'];
const ATTENTE_MS = 86400000;
const RATTRAPAGE_MS = 7 * 86400000;
const RATTRAPAGE_PAS_MS = 3600000;
/** Un numéro ne reçoit pas plus de demandes par jour, même si le lien circule. */
const DEMANDES_PAR_JOUR = 5;
const MAX_COTISATIONS = 30;
const MAX_MEMBRES = 200;

type Contact = { nom: string; telephone: string };
type Avis = { cle: string; titre: string; corps: string; parEmail: boolean };
export type DepsCotisations = {
  db: Pick<PrismaClient, 'cotisation' | 'cotisationMembre' | 'paiementCotisation'>;
  flexpaie: {
    demander(p: { telephone: string; reference: string; montant: number; devise: string; retour: string }): Promise<{ commande: string }>;
    verifier(commande: string): Promise<{ etat: EtatCommande; transaction: { amount?: string; currency?: string } | null; message: string }>;
  };
  /** Le paiement en ligne est-il ouvert (accord FlexPaie, COTISATIONS_PAIEMENT) ? */
  enLigne(): boolean;
  /** Les identifiants FlexPaie sont-ils là ? Ce qui est déjà parti reste vérifié, même si le paiement en ligne est refermé. */
  flexpaiePret(): boolean;
  adresseServeur(): string;
  adresseApp(): string | null;
  exigerNumero(telephone: string): Promise<void>;
  prevenir(userId: string, avis: Avis): Promise<void>;
  maintenant?: () => number;
};

const AVEC_TOUT = { user: { select: { nom: true, fuseau: true } }, membres: { orderBy: { createdAt: 'asc' }, include: { paiements: true } }, paiements: { where: { mode: 'mobile', statut: 'paye' }, select: { montant: true } } } satisfies Prisma.CotisationInclude;
type CotisationComplete = Prisma.CotisationGetPayload<{ include: typeof AVEC_TOUT }>;
type APayer = { id: string; commande: string | null; statut: string; montant: number; devise: string; reference: string };

const reference = (prefixe: string) => `${prefixe}${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`;
const estDoublon = (e: unknown) => (e as { code?: string })?.code === 'P2002';

export function creerCotisations(d: DepsCotisations) {
  const maintenant = () => d.maintenant?.() ?? Date.now();
  const jourDe = (fuseau: string, instant: Date = new Date(maintenant())) => local(instant, fuseau).date;
  let dernierRattrapageLong = 0;

  const lienDe = (jeton: string) => {
    const app = d.adresseApp();
    return d.enLigne() && app ? `${app}/c/${jeton}` : null;
  };

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
            telephone: contact.telephone,
            lien: lienDe(m.jeton),
            // Un membre arrivé en cours de route ne doit pas les périodes d'avant.
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
    if (!c) throw new HttpError(404, 'Cotisation introuvable.');
    return c;
  }
  const relire = async (userId: string, id: string) => ({ cotisation: vue(await complete(userId, id)) });

  async function membreDe(userId: string, membreId: string) {
    const m = await d.db.cotisationMembre.findFirst({ where: { id: membreId, cotisation: { userId } }, include: { cotisation: { include: { user: { select: { fuseau: true } } } }, paiements: true } });
    if (!m) throw new HttpError(404, 'Membre introuvable.');
    return m;
  }

  /** Numéro valable et pas déjà dans ce groupe. */
  async function numeroPour(cotisationId: string, brut: string, sauf?: string) {
    const telephone = normaliserTelephone(brut);
    if (!telephone) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
    await d.exigerNumero(telephone);
    const autres = await d.db.cotisationMembre.findMany({ where: { cotisationId }, select: { id: true, contact: true } });
    if (autres.some((a) => a.id !== sauf && horsCoffre<Contact>(a.contact)?.telephone === telephone)) throw new HttpError(409, 'Ce numéro est déjà dans le groupe.');
    return telephone;
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
      .prevenir(trace.cotisation.userId, { cle: `cotisation:paiement:${p.reference}`, titre: `${nom || 'Un membre'} a payé ${montantCotisation(p.montant, p.devise)}`, corps: `Cotisation « ${trace.cotisation.titre} ».`, parEmail: false })
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

  const membreParJeton = async (jeton: string) => {
    const m = await d.db.cotisationMembre.findUnique({ where: { jeton }, include: { cotisation: { include: { user: { select: { nom: true, fuseau: true } } } }, paiements: { orderBy: { createdAt: 'desc' } } } });
    if (!m) throw new HttpError(404, 'Ce lien n’est plus valable.');
    return m;
  };
  type MembrePublic = Awaited<ReturnType<typeof membreParJeton>>;

  /** Ce qu'il reste à payer pour ce membre, de la période la plus ancienne à la plus récente. */
  function periodesDues(m: MembrePublic) {
    const c = m.cotisation;
    const rythme = c.rythme as RythmeCotisation;
    const entree = jourDe(c.user.fuseau, m.createdAt);
    const periodes = periodesDepuis(rythme, c.debut > entree ? c.debut : entree, jourDe(c.user.fuseau));
    const payees = m.paiements.filter((p) => p.statut === 'paye').map((p) => p.periode);
    return periodes.filter((p) => !payees.includes(p));
  }

  function pagePublique(m: MembrePublic) {
    const c = m.cotisation;
    const contact = horsCoffre<Contact>(m.contact);
    if (!contact) throw new HttpError(404, 'Ce lien n’est plus valable.');
    const dues = periodesDues(m);
    const attente = m.paiements.find((p) => p.statut === 'en_attente');
    const periode = attente?.periode ?? premierePeriodeDue(dues, []);
    return {
      titre: c.titre,
      organisateur: prenomDe(c.user.nom ?? ''),
      nom: prenomDe(contact.nom),
      montant: attente?.montant ?? c.montant,
      devise: attente?.devise ?? c.devise,
      periode: periode ? libellePeriode(periode) : '',
      restantes: dues.length,
      telephone: numeroMasque(contact.telephone),
      enLigne: d.enLigne(),
      etat: attente ? ('en_attente' as const) : c.archive ? ('terminee' as const) : periode ? ('a_payer' as const) : ('a_jour' as const),
      refus: m.paiements[0]?.statut === 'echoue',
    };
  }

  return {
    async liste(userId: string) {
      const cotisations = await d.db.cotisation.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, include: AVEC_TOUT });
      return { enLigne: d.enLigne(), cotisations: cotisations.map(vue) };
    },

    async creer(userId: string, corps: { titre: string; montant: number; devise: string; rythme: RythmeCotisation }, fuseau: string) {
      if ((await d.db.cotisation.count({ where: { userId, archive: false } })) >= MAX_COTISATIONS) throw new HttpError(409, `${MAX_COTISATIONS} cotisations en cours au maximum.`);
      const c = await d.db.cotisation.create({ data: { userId, ...corps, debut: jourDe(fuseau) } });
      return relire(userId, c.id);
    },

    async modifier(userId: string, id: string, corps: { titre?: string; montant?: number; archive?: boolean }) {
      await complete(userId, id);
      await d.db.cotisation.update({ where: { id }, data: corps });
      return relire(userId, id);
    },

    /** L'argent déjà encaissé doit rester visible : cette cotisation-là se termine, elle ne s'efface pas. */
    async supprimer(userId: string, id: string) {
      await complete(userId, id);
      const argent = await d.db.paiementCotisation.count({ where: { cotisationId: id, mode: 'mobile', statut: { in: ['paye', 'en_attente'] } } });
      if (argent) throw new HttpError(409, 'Des paiements en ligne existent : termine cette cotisation plutôt que de la supprimer.');
      await d.db.paiementCotisation.deleteMany({ where: { cotisationId: id, mode: 'main' } });
      await d.db.cotisation.delete({ where: { id } });
      return { ok: true };
    },

    async ajouterMembre(userId: string, id: string, corps: Contact) {
      await complete(userId, id);
      if ((await d.db.cotisationMembre.count({ where: { cotisationId: id } })) >= MAX_MEMBRES) throw new HttpError(409, `${MAX_MEMBRES} membres au maximum.`);
      const telephone = await numeroPour(id, corps.telephone);
      await d.db.cotisationMembre.create({ data: { cotisationId: id, contact: enCoffre({ nom: corps.nom, telephone }), jeton: randomBytes(12).toString('base64url') } });
      return relire(userId, id);
    },

    async modifierMembre(userId: string, membreId: string, corps: Contact) {
      const m = await membreDe(userId, membreId);
      if (m.paiements.some((p) => p.statut === 'en_attente')) throw new HttpError(409, 'Un paiement est en cours pour ce membre.');
      const telephone = await numeroPour(m.cotisationId, corps.telephone, m.id);
      await d.db.cotisationMembre.update({ where: { id: m.id }, data: { contact: enCoffre({ nom: corps.nom, telephone }) } });
      return relire(userId, m.cotisationId);
    },

    async retirerMembre(userId: string, membreId: string) {
      const m = await membreDe(userId, membreId);
      if (m.paiements.some((p) => p.statut === 'en_attente')) throw new HttpError(409, 'Un paiement est en cours pour ce membre.');
      await d.db.paiementCotisation.deleteMany({ where: { membreId: m.id, mode: 'main' } });
      await d.db.cotisationMembre.delete({ where: { id: m.id } });
      return relire(userId, m.cotisationId);
    },

    /** L'organisateur vient d'ouvrir WhatsApp ou le SMS : « Demandé » s'affiche pour cette période. */
    async noterDemande(userId: string, membreId: string, periode: string) {
      const m = await membreDe(userId, membreId);
      await d.db.cotisationMembre.update({ where: { id: m.id }, data: { demandeLe: new Date(maintenant()), demandePeriode: periode } });
      return relire(userId, m.cotisationId);
    },

    /** Paiement reçu hors de Me (espèces, autre compte). */
    async marquer(userId: string, membreId: string, periode: string, paye: boolean) {
      const m = await membreDe(userId, membreId);
      const c = m.cotisation;
      if (!periodesDepuis(c.rythme as RythmeCotisation, c.debut, jourDe(c.user.fuseau)).includes(periode)) throw new HttpError(400, 'Période invalide.');
      const dela = m.paiements.filter((p) => p.periode === periode);
      if (paye) {
        if (dela.some((p) => p.statut === 'en_attente')) throw new HttpError(409, 'Un paiement est en cours pour ce membre.');
        if (!dela.some((p) => p.statut === 'paye')) {
          await d.db.paiementCotisation.create({ data: { reference: reference('CM'), cotisationId: c.id, membreId: m.id, periode, montant: c.montant, devise: c.devise, mode: 'main', statut: 'paye', payeLe: new Date(maintenant()) } });
        }
      } else {
        if (dela.some((p) => p.mode === 'mobile' && p.statut === 'paye')) throw new HttpError(409, 'Ce paiement a été fait en ligne.');
        await d.db.paiementCotisation.deleteMany({ where: { membreId: m.id, periode, mode: 'main' } });
      }
      return relire(userId, c.id);
    },

    /** La page ouverte depuis le message. Sans compte : le jeton du lien suffit, et ne montre que ce qui concerne ce membre. */
    async page(jeton: string) {
      const m = await membreParJeton(jeton);
      const attente = m.paiements.find((p) => p.statut === 'en_attente');
      if (!attente) return pagePublique(m);
      await verifier(attente);
      return pagePublique(await membreParJeton(jeton));
    },

    /** Le membre a appuyé sur « Payer » : la demande part vers SON numéro, jamais vers un numéro saisi sur la page. */
    async payer(jeton: string) {
      if (!d.enLigne()) throw new HttpError(503, 'Le paiement en ligne n’est pas encore ouvert.');
      if (!d.adresseServeur().startsWith('https://')) throw new HttpError(503, 'Le paiement en ligne est momentanément indisponible.');
      const m = await membreParJeton(jeton);
      const c = m.cotisation;
      if (c.archive) throw new HttpError(410, 'Cette cotisation est terminée.');
      const contact = horsCoffre<Contact>(m.contact);
      if (!contact) throw new HttpError(404, 'Ce lien n’est plus valable.');
      if (m.paiements.some((p) => p.statut === 'en_attente')) return pagePublique(m);
      await d.exigerNumero(contact.telephone);
      if (m.paiements.filter((p) => p.mode === 'mobile' && p.createdAt.getTime() > maintenant() - 86400000).length >= DEMANDES_PAR_JOUR) {
        throw new HttpError(429, 'Trop de demandes aujourd’hui. Réessaie demain.');
      }

      // Une demande abandonnée a pu être validée entre-temps : ne pas faire payer deux fois.
      const anciennes = m.paiements.filter((p) => p.mode === 'mobile' && REVERIFIABLES.includes(p.statut)).slice(0, 3);
      for (const p of anciennes) await verifier(p);
      const frais = anciennes.length ? await membreParJeton(jeton) : m;
      const periode = premierePeriodeDue(periodesDues(frais), []);
      if (!periode) return pagePublique(frais);

      let p;
      try {
        p = await d.db.paiementCotisation.create({
          data: { reference: reference('CO'), cotisationId: c.id, membreId: m.id, periode, montant: c.montant, devise: c.devise, mode: 'mobile', statut: 'en_attente', telephone: numeroMasque(contact.telephone) },
        });
      } catch (e) {
        if (estDoublon(e)) return pagePublique(await membreParJeton(jeton));
        throw e;
      }
      try {
        const r = await d.flexpaie.demander({ telephone: contact.telephone, reference: p.reference, montant: p.montant, devise: p.devise, retour: `${d.adresseServeur()}/api/cotisations/flexpaie/retour` });
        await d.db.paiementCotisation.update({ where: { id: p.id }, data: { commande: r.commande } });
      } catch (e) {
        const config = e instanceof ErreurFlexpaie && e.configuration;
        await d.db.paiementCotisation.update({ where: { id: p.id }, data: { statut: 'echoue', message: config ? 'Paiement mobile money indisponible.' : (e as Error).message } });
        if (e instanceof ErreurFlexpaie) {
          console.error('FlexPaie', e.message);
          if (config) throw new HttpError(503, 'Le paiement mobile money est momentanément indisponible.');
          throw new HttpError(502, 'La demande n’a pas pu partir. Réessaie.');
        }
        throw e;
      }
      return pagePublique(await membreParJeton(jeton));
    },

    /** « Je n'ai rien reçu » : on peut redemander. La demande reste revérifiée : validée quand même, elle compte. */
    async abandonner(jeton: string) {
      const m = await membreParJeton(jeton);
      const attente = m.paiements.find((p) => p.statut === 'en_attente');
      if (attente) {
        await verifier(attente);
        await d.db.paiementCotisation.updateMany({ where: { id: attente.id, statut: 'en_attente' }, data: { statut: 'abandonne', message: 'Demande abandonnée par le membre.' } });
      }
      return pagePublique(await membreParJeton(jeton));
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
