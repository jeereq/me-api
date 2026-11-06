import { randomBytes, randomInt } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import { COMMISSION_BPS, echeancesTontine, montantCotisation, numeroMasque, prenomDe, repartitionCagnotte, type RythmeTontine } from '../../commun/cotisations.js';
import { enCoffre, horsCoffre } from '../../utils/coffre.js';
import { HttpError } from '../../utils/http.js';
import { ErreurFlexpaie, normaliserTelephone, type EtatCommande } from '../abonnements/flexpaie.js';
import { local } from '../integrations/http.js';
import type { AvisGroupe } from './envois.js';

/** À changer avec la section « Tontines » de cgv.html. */
export const VERSION_CONDITIONS_TONTINE = '2026-11-06';
const REVERIFIABLES = ['en_attente', 'expire', 'abandonne'];
const ENTREES = ['caution', 'cotisation'];
const ATTENTE_MS = 86400000;
const RATTRAPAGE_MS = 7 * 86400000;
const RATTRAPAGE_PAS_MS = 3600000;
/** Un numéro ne reçoit pas plus de demandes par jour. */
const DEMANDES_PAR_JOUR = 5;
const MAX_GROUPES = 20;

type Contact = { nom: string; telephone: string };
export type DepsTontines = {
  db: Pick<PrismaClient, 'tontine' | 'tontineMembre' | 'tontineTour' | 'tontineMouvement'>;
  flexpaie: {
    demander(p: { telephone: string; reference: string; montant: number; devise: string; retour: string }): Promise<{ commande: string }>;
    verser(p: { telephone: string; reference: string; montant: number; devise: string; retour: string }): Promise<{ commande: string }>;
    verifier(commande: string): Promise<{ etat: EtatCommande; transaction: { amount?: string; currency?: string } | null; message: string }>;
  };
  /** Paiements ouverts pour un groupe, selon le rôle de son organisateur (TONTINES_PAIEMENT). */
  paiementOuvert(roleOrganisateur: string | null): boolean;
  versementApi(): boolean;
  flexpaiePret(): boolean;
  adresseServeur(): string;
  exigerNumero(telephone: string): Promise<void>;
  avertir(userId: string, telephone: string | null, avis: AvisGroupe, seulementApp?: boolean): Promise<{ nouveau: boolean; mail: boolean; sms: boolean }>;
  maintenant?: () => number;
  /** Pour les tests : le tirage au sort. */
  tirer?: (max: number) => number;
};

const INCLUS = { organisateur: { select: { nom: true, role: true } }, membres: { orderBy: { createdAt: 'asc' } }, tours: { orderBy: { numero: 'asc' } } } satisfies Prisma.TontineInclude;
type TontineComplete = Prisma.TontineGetPayload<{ include: typeof INCLUS }>;
type Membre = TontineComplete['membres'][number];
type Mouvement = Prisma.TontineMouvementGetPayload<object>;

const reference = () => `TO${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`;
const estDoublon = (e: unknown) => (e as { code?: string })?.code === 'P2002';
const contactDe = (m: { contact: unknown }) => horsCoffre<Contact>(m.contact) ?? { nom: 'Ancien membre', telephone: '' };
const jourPlus = (jour: string, n: number) => new Date(new Date(`${jour}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

export function creerTontines(d: DepsTontines) {
  const maintenant = () => d.maintenant?.() ?? Date.now();
  const jourDe = (t: { fuseau: string }) => local(new Date(maintenant()), t.fuseau).date;
  let dernierRattrapageLong = 0;

  async function charger(id: string) {
    const t = await d.db.tontine.findUnique({ where: { id }, include: INCLUS });
    if (!t) throw new HttpError(404, 'Groupe introuvable.');
    return t;
  }
  const estOrganisateur = (t: TontineComplete, userId: string) => t.organisateurId === userId;
  function exigerOrganisateur(t: TontineComplete, userId: string) {
    if (!estOrganisateur(t, userId)) throw new HttpError(403, 'Réservé à l’organisateur du groupe.');
  }
  const acceptes = (t: TontineComplete) => t.membres.filter((m) => m.etat === 'accepte');
  const ouvertPour = (t: TontineComplete) => d.paiementOuvert(t.organisateur?.role ?? null);
  const tourActuel = (t: TontineComplete) => t.tours.find((x) => x.numero === t.tourCourant) ?? null;
  const mouvementsDe = (tontineId: string) => d.db.tontineMouvement.findMany({ where: { tontineId } });
  const aCotise = (mvts: Mouvement[], membreId: string, tourId: string) => mvts.some((x) => x.membreId === membreId && x.tourId === tourId && x.statut === 'paye' && (x.genre === 'cotisation' || x.genre === 'caution_utilisee'));

  /** Ce que ce membre doit payer maintenant : d'abord le tour, puis la caution. */
  function aPayer(t: TontineComplete, m: Membre, mvts: Mouvement[]) {
    if (m.etat !== 'accepte' || t.etat === 'annule' || t.etat === 'termine') return null;
    const tour = t.etat === 'en_cours' ? tourActuel(t) : null;
    if (tour?.etat === 'collecte' && !aCotise(mvts, m.id, tour.id)) return { genre: 'cotisation' as const, montant: t.montant, tourId: tour.id };
    if (m.cautionStatut === 'due' || m.cautionStatut === 'utilisee') return { genre: 'caution' as const, montant: t.montant, tourId: null };
    return null;
  }

  const carte = (t: TontineComplete, userId: string) => ({
    id: t.id,
    nom: t.nom,
    description: t.description,
    montant: t.montant,
    devise: t.devise,
    rythme: t.rythme as RythmeTontine,
    places: t.places,
    inscrits: acceptes(t).length,
    etat: t.etat,
    organisateur: prenomDe(t.organisateur?.nom ?? ''),
    ...repartitionCagnotte(t.montant, t.places, t.commissionBps),
    monEtat: t.membres.find((m) => m.userId === userId)?.etat ?? null,
  });

  function vue(t: TontineComplete, userId: string, mvts: Mouvement[]) {
    const moi = t.membres.find((m) => m.userId === userId);
    const orga = estOrganisateur(t, userId);
    const tour = tourActuel(t);
    const estAccepte = moi?.etat === 'accepte';
    const parMembre = new Map(t.membres.map((m) => [m.id, contactDe(m)]));
    const du = moi ? aPayer(t, moi, mvts) : null;
    const dernier = moi ? mvts.filter((x) => x.membreId === moi.id && ENTREES.includes(x.genre)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] : undefined;
    return {
      ...carte(t, userId),
      paiementOuvert: ouvertPour(t),
      suisOrganisateur: orga,
      tourCourant: t.tourCourant,
      jour: jourDe(t),
      moi: moi ? { id: moi.id, etat: moi.etat, rang: moi.rang, cautionStatut: moi.cautionStatut, telephone: numeroMasque(contactDe(moi).telephone) } : null,
      aPayer: du ? { genre: du.genre, montant: du.montant } : null,
      enAttente: !!dernier && dernier.statut === 'en_attente',
      refus: dernier?.statut === 'echoue',
      // Seuls les membres acceptés voient le groupe en détail, et jamais les numéros des autres.
      membres: orga || estAccepte
        ? acceptes(t).map((m) => ({
            id: m.id,
            nom: contactDe(m).nom,
            rang: m.rang,
            cautionPayee: m.cautionStatut !== 'due',
            cautionStatut: orga ? m.cautionStatut : null,
            aCotise: tour ? aCotise(mvts, m.id, tour.id) : false,
          }))
        : [],
      demandes: orga ? t.membres.filter((m) => m.etat === 'demande').map((m) => ({ id: m.id, nom: contactDe(m).nom })) : [],
      tours: orga || estAccepte ? t.tours.map((x) => ({ numero: x.numero, beneficiaire: x.beneficiaireId ? (parMembre.get(x.beneficiaireId)?.nom ?? '') : '', pourMoi: x.beneficiaireId === moi?.id, echeance: x.echeance, etat: x.etat, net: x.net })) : [],
    };
  }

  const relire = async (id: string, userId: string) => {
    const t = await charger(id);
    return { groupe: vue(t, userId, await mouvementsDe(id)) };
  };

  const prevenirTous = (t: TontineComplete, cle: string, avis: Omit<AvisGroupe, 'cle'>, sauf?: string) =>
    Promise.all(acceptes(t).filter((m) => m.userId && m.id !== sauf).map((m) => d.avertir(m.userId!, contactDe(m).telephone, { cle: `${cle}:${m.id}`, ...avis }).catch((e) => console.error('Avis de tontine', e))));
  const prevenirOrganisateur = (t: TontineComplete, cle: string, avis: Omit<AvisGroupe, 'cle'>, seulementApp = true) =>
    t.organisateurId ? d.avertir(t.organisateurId, null, { cle, ...avis }, seulementApp).catch((e) => console.error('Avis de tontine', e)) : Promise.resolve();

  /** Tous ont cotisé : le versement attend la validation de l'admin. */
  async function fermerCollecte(tontineId: string, tourId: string) {
    const t = await charger(tontineId);
    const tour = t.tours.find((x) => x.id === tourId);
    if (!tour || tour.etat !== 'collecte') return;
    const mvts = await mouvementsDe(tontineId);
    if (!acceptes(t).every((m) => aCotise(mvts, m.id, tourId))) return;
    const fait = await d.db.tontineTour.updateMany({ where: { id: tourId, etat: 'collecte' }, data: { etat: 'a_verser' } });
    if (!fait.count) return;
    const b = t.membres.find((m) => m.id === tour.beneficiaireId);
    if (b?.userId) await d.avertir(b.userId, contactDe(b).telephone, { cle: `tontine:complet:${tourId}`, titre: 'Ta cagnotte est complète', corps: `« ${t.nom} » : ${montantCotisation(tour.net, t.devise)} en cours de validation.` }).catch((e) => console.error('Avis de tontine', e));
  }

  /** Argent reçu et vérifié. */
  async function apresEntree(m: Mouvement) {
    if (!m.membreId || !m.tontineId) return;
    const t = await charger(m.tontineId);
    const membre = t.membres.find((x) => x.id === m.membreId);
    if (m.genre === 'caution') {
      // Parti ou groupe annulé pendant la validation : la caution est à rendre.
      const garder = membre?.etat === 'accepte' && t.etat !== 'annule';
      await d.db.tontineMembre.updateMany({ where: { id: m.membreId, cautionStatut: { in: ['due', 'utilisee', 'a_rendre'] } }, data: { cautionStatut: garder ? 'payee' : 'a_rendre' } });
      const apres = await charger(m.tontineId);
      if (apres.etat === 'ouvert' && acceptes(apres).length === apres.places && acceptes(apres).every((x) => x.cautionStatut === 'payee')) {
        await prevenirOrganisateur(apres, `tontine:pret:${apres.id}`, { titre: 'Ton groupe est prêt', corps: `« ${apres.nom} » : tout le monde a payé sa caution. Tu peux démarrer.` }, false);
      }
    }
    if (m.genre === 'cotisation' && m.tourId) await fermerCollecte(m.tontineId, m.tourId);
  }

  /** Le tour est versé : le suivant s'ouvre, ou le groupe se termine et les cautions sont à rendre. */
  async function apresVersement(tourId: string) {
    const fait = await d.db.tontineTour.updateMany({ where: { id: tourId, etat: 'a_verser' }, data: { etat: 'verse' } });
    if (!fait.count) return;
    const tour = await d.db.tontineTour.findUniqueOrThrow({ where: { id: tourId } });
    const t = await charger(tour.tontineId);
    const b = t.membres.find((m) => m.id === tour.beneficiaireId);
    if (b?.userId) await d.avertir(b.userId, contactDe(b).telephone, { cle: `tontine:verse:${tourId}`, titre: 'Ta cagnotte est versée', corps: `« ${t.nom} » : ${montantCotisation(tour.net, t.devise)}.` }).catch((e) => console.error('Avis de tontine', e));
    const suivant = t.tours.find((x) => x.numero === tour.numero + 1);
    if (!suivant) {
      await d.db.tontine.update({ where: { id: t.id }, data: { etat: 'termine' } });
      await d.db.tontineMembre.updateMany({ where: { tontineId: t.id, cautionStatut: 'payee' }, data: { cautionStatut: 'a_rendre' } });
      await prevenirTous(t, `tontine:fin:${t.id}`, { titre: 'Tontine terminée', corps: `« ${t.nom} » : tout le monde a reçu sa cagnotte. Ta caution te sera rendue.` });
      return;
    }
    await d.db.tontineTour.update({ where: { id: suivant.id }, data: { etat: 'collecte' } });
    await d.db.tontine.update({ where: { id: t.id }, data: { tourCourant: suivant.numero } });
    const nom = suivant.beneficiaireId ? prenomDe(contactDe(t.membres.find((m) => m.id === suivant.beneficiaireId) ?? { contact: null }).nom) : '';
    await prevenirTous(t, `tontine:tour:${suivant.id}`, { titre: `Cotisation à payer : ${montantCotisation(t.montant, t.devise)}`, corps: `« ${t.nom} », tour ${suivant.numero} sur ${t.places}, pour ${nom}.` });
  }

  async function apresSortie(m: Mouvement) {
    if (m.genre === 'versement' && m.tourId) await apresVersement(m.tourId);
    if (m.genre === 'caution_rendue' && m.membreId) {
      await d.db.tontineMembre.updateMany({ where: { id: m.membreId, cautionStatut: 'a_rendre' }, data: { cautionStatut: 'rendue' } });
    }
  }

  async function conclure(m: Mouvement, etat: EtatCommande, message = '') {
    if (etat === 'en_attente') return;
    const fait = await d.db.tontineMouvement.updateMany({ where: { id: m.id, statut: { in: REVERIFIABLES } }, data: { statut: etat, message: message || null, ...(etat === 'paye' ? { payeLe: new Date(maintenant()) } : {}) } });
    if (!fait.count || etat !== 'paye') return;
    if (ENTREES.includes(m.genre)) await apresEntree(m);
    else await apresSortie(m);
  }

  /** Rien n'est cru sur parole : état, montant et devise viennent de FlexPaie. */
  async function verifier(m: Mouvement) {
    if (!REVERIFIABLES.includes(m.statut) || !m.commande || !d.flexpaiePret()) return;
    try {
      const r = await d.flexpaie.verifier(m.commande);
      if (r.etat === 'paye') {
        const montant = r.transaction?.amount;
        if (!montant) {
          console.error(`FlexPaie : mouvement sans montant pour la commande ${m.commande}`);
          return;
        }
        if (Math.round(Number(montant) * 100) !== m.montant || (r.transaction?.currency && r.transaction.currency !== m.devise)) {
          console.error(`FlexPaie : montant inattendu pour la commande ${m.commande}`);
          await conclure(m, 'echoue', 'Montant reçu différent du montant demandé.');
          return;
        }
      }
      if (r.etat === 'echoue' && m.statut !== 'en_attente') return;
      await conclure(m, r.etat, r.etat === 'echoue' ? r.message || 'Paiement refusé ou annulé.' : '');
    } catch (e) {
      console.error('FlexPaie : vérification impossible', e);
    }
  }

  const retourUrl = () => `${d.adresseServeur()}/api/tontines/flexpaie/retour`;

  /** Une sortie d'argent après validation de l'admin : API FlexPaie si elle est ouverte, sinon preuve d'un versement fait hors de Me. */
  async function sortie(c: { genre: 'versement' | 'caution_rendue'; tontineId: string; membreId: string | null; tourId: string | null; montant: number; devise: string; telephone: string; preuve?: string }) {
    const base = { reference: reference(), tontineId: c.tontineId, membreId: c.membreId, tourId: c.tourId, genre: c.genre, montant: c.montant, devise: c.devise, telephone: numeroMasque(c.telephone) };
    if (!d.versementApi()) {
      if (!c.preuve) throw new HttpError(400, 'Indique la référence du versement.');
      try {
        const m = await d.db.tontineMouvement.create({ data: { ...base, mode: 'main', statut: 'paye', message: c.preuve, payeLe: new Date(maintenant()) } });
        await apresSortie(m);
      } catch (e) {
        if (estDoublon(e)) throw new HttpError(409, 'Déjà versé.');
        throw e;
      }
      return;
    }
    let m: Mouvement;
    try {
      m = await d.db.tontineMouvement.create({ data: { ...base, mode: 'mobile', statut: 'en_attente' } });
    } catch (e) {
      if (estDoublon(e)) throw new HttpError(409, 'Un versement est déjà en cours.');
      throw e;
    }
    try {
      const r = await d.flexpaie.verser({ telephone: c.telephone, reference: m.reference, montant: m.montant, devise: m.devise, retour: retourUrl() });
      await d.db.tontineMouvement.update({ where: { id: m.id }, data: { commande: r.commande } });
    } catch (e) {
      await d.db.tontineMouvement.update({ where: { id: m.id }, data: { statut: 'echoue', message: (e as Error).message } });
      if (e instanceof ErreurFlexpaie) {
        console.error('FlexPaie', e.message);
        throw new HttpError(502, 'Le versement n’a pas pu partir.');
      }
      throw e;
    }
  }

  /** Pour l'admin : ce qui attend sa validation, et l'argent par devise. */
  async function resumeAdmin() {
    const [tours, cautions, mouvements, verses] = await Promise.all([
      d.db.tontineTour.findMany({ where: { etat: 'a_verser' }, orderBy: { createdAt: 'asc' } }),
      d.db.tontineMembre.findMany({ where: { cautionStatut: 'a_rendre' } }),
      d.db.tontineMouvement.findMany({ where: { statut: 'paye', mode: { in: ['mobile', 'main'] } }, select: { genre: true, montant: true, devise: true } }),
      d.db.tontineTour.findMany({ where: { etat: 'verse' }, include: { tontine: { select: { devise: true } } } }),
    ]);
    const parDevise = new Map<string, { detenu: number; commission: number }>();
    const ligne = (devise: string) => {
      if (!parDevise.has(devise)) parDevise.set(devise, { detenu: 0, commission: 0 });
      return parDevise.get(devise)!;
    };
    for (const m of mouvements) ligne(m.devise).detenu += ENTREES.includes(m.genre) ? m.montant : -m.montant;
    for (const x of verses) ligne(x.tontine.devise).commission += x.commission;
    const groupes = new Map<string, TontineComplete>();
    for (const id of new Set([...tours.map((x) => x.tontineId), ...cautions.map((m) => m.tontineId)])) groupes.set(id, await charger(id));
    return {
      versementApi: d.versementApi(),
      totaux: [...parDevise].map(([devise, v]) => ({ devise, ...v })),
      versements: tours.map((x) => {
        const t = groupes.get(x.tontineId)!;
        const b = t.membres.find((m) => m.id === x.beneficiaireId);
        const contact = b ? contactDe(b) : null;
        return { tourId: x.id, groupe: t.nom, numero: x.numero, places: t.places, beneficiaire: contact?.nom ?? '', telephone: contact?.telephone ?? '', brut: x.brut, commission: x.commission, net: x.net, devise: t.devise };
      }),
      cautions: cautions.map((m) => {
        const t = groupes.get(m.tontineId)!;
        const contact = contactDe(m);
        return { membreId: m.id, groupe: t.nom, nom: contact.nom, telephone: contact.telephone, montant: t.montant, devise: t.devise };
      }),
    };
    }

  return {
    /** Les groupes qui cherchent des membres. */
    async annuaire(userId: string, q?: string) {
      const groupes = await d.db.tontine.findMany({ where: { etat: 'ouvert' }, orderBy: { createdAt: 'desc' }, take: 100, include: INCLUS });
      const mot = q?.trim().toLowerCase();
      return { groupes: groupes.filter((t) => acceptes(t).length < t.places).filter((t) => !mot || t.nom.toLowerCase().includes(mot)).map((t) => carte(t, userId)) };
    },

    async mesGroupes(userId: string) {
      const liens = await d.db.tontineMembre.findMany({ where: { userId, etat: { in: ['demande', 'accepte'] } }, select: { tontineId: true } });
      const groupes = await Promise.all(liens.map(async (l) => vue(await charger(l.tontineId), userId, await mouvementsDe(l.tontineId))));
      return { groupes: groupes.sort((a, b) => a.nom.localeCompare(b.nom)), versementApi: d.versementApi() };
    },

    /** Ouvrir un groupe revérifie mes paiements en attente : c'est ce que l'app interroge pendant la validation. */
    async detail(userId: string, id: string) {
      const t = await charger(id);
      const moi = t.membres.find((m) => m.userId === userId);
      if (moi) for (const m of (await mouvementsDe(id)).filter((x) => x.membreId === moi.id && x.statut === 'en_attente' && ENTREES.includes(x.genre))) await verifier(m);
      return relire(id, userId);
    },

    async creer(u: { id: string; nom: string; fuseau: string }, c: { nom: string; description?: string; montant: number; devise: string; rythme: RythmeTontine; places: number; telephone: string }) {
      if ((await d.db.tontineMembre.count({ where: { userId: u.id, etat: { in: ['demande', 'accepte'] } } })) >= MAX_GROUPES) throw new HttpError(409, `${MAX_GROUPES} groupes en cours au maximum.`);
      const telephone = normaliserTelephone(c.telephone);
      if (!telephone) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
      await d.exigerNumero(telephone);
      const t = await d.db.tontine.create({ data: { organisateurId: u.id, nom: c.nom, description: c.description || null, montant: c.montant, devise: c.devise, rythme: c.rythme, places: c.places, commissionBps: COMMISSION_BPS, fuseau: u.fuseau } });
      await d.db.tontineMembre.create({ data: { tontineId: t.id, userId: u.id, etat: 'accepte', contact: enCoffre({ nom: u.nom, telephone }), conditionsVersion: VERSION_CONDITIONS_TONTINE } });
      return relire(t.id, u.id);
    },

    async adherer(u: { id: string; nom: string }, id: string, brut: string) {
      const t = await charger(id);
      if (t.etat !== 'ouvert') throw new HttpError(409, 'Ce groupe n’accepte plus de membres.');
      if (acceptes(t).length >= t.places) throw new HttpError(409, 'Ce groupe est complet.');
      const deja = t.membres.find((m) => m.userId === u.id);
      if (deja && ['demande', 'accepte'].includes(deja.etat)) return relire(id, u.id);
      if (deja?.etat === 'refuse') throw new HttpError(409, 'L’organisateur a refusé ta demande.');
      if (deja?.cautionStatut === 'a_rendre') throw new HttpError(409, 'Ta caution est en cours de remboursement.');
      if ((await d.db.tontineMembre.count({ where: { userId: u.id, etat: { in: ['demande', 'accepte'] } } })) >= MAX_GROUPES) throw new HttpError(409, `${MAX_GROUPES} groupes en cours au maximum.`);
      const telephone = normaliserTelephone(brut);
      if (!telephone) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
      await d.exigerNumero(telephone);
      const donnees = { contact: enCoffre({ nom: u.nom, telephone }), etat: 'demande', cautionStatut: 'due', conditionsVersion: VERSION_CONDITIONS_TONTINE };
      if (deja) await d.db.tontineMembre.update({ where: { id: deja.id }, data: donnees });
      else await d.db.tontineMembre.create({ data: { tontineId: id, userId: u.id, ...donnees } });
      await prevenirOrganisateur(t, `tontine:demande:${id}:${u.id}`, { titre: 'Nouvelle demande', corps: `${prenomDe(u.nom)} veut rejoindre « ${t.nom} ».` });
      return relire(id, u.id);
    },

    async decider(userId: string, membreId: string, accepte: boolean) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Demande introuvable.');
      const t = await charger(m.tontineId);
      exigerOrganisateur(t, userId);
      if (t.etat !== 'ouvert' || m.etat !== 'demande') throw new HttpError(409, 'Cette demande n’est plus ouverte.');
      if (accepte && acceptes(t).length >= t.places) throw new HttpError(409, 'Le groupe est complet.');
      await d.db.tontineMembre.update({ where: { id: m.id }, data: { etat: accepte ? 'accepte' : 'refuse' } });
      if (m.userId) await d.avertir(m.userId, contactDe(m).telephone, accepte ? { cle: `tontine:accepte:${m.id}`, titre: 'Demande acceptée', corps: `« ${t.nom} » : paie ta caution de ${montantCotisation(t.montant, t.devise)}.` } : { cle: `tontine:refuse:${m.id}`, titre: 'Demande refusée', corps: `« ${t.nom} ».` }).catch((e) => console.error('Avis de tontine', e));
      return relire(t.id, userId);
    },

    /** Avant le démarrage seulement. Une fois le tirage fait, le groupe compte sur chaque membre. */
    async quitter(userId: string, id: string) {
      const t = await charger(id);
      const moi = t.membres.find((m) => m.userId === userId);
      if (!moi || !['demande', 'accepte'].includes(moi.etat)) throw new HttpError(404, 'Tu n’es pas dans ce groupe.');
      if (t.etat !== 'ouvert') throw new HttpError(409, 'Le groupe a démarré : tu ne peux plus le quitter.');
      if (estOrganisateur(t, userId)) throw new HttpError(409, 'Annule le groupe plutôt que de le quitter.');
      if ((await mouvementsDe(id)).some((x) => x.membreId === moi.id && x.statut === 'en_attente')) throw new HttpError(409, 'Un paiement est en cours.');
      await d.db.tontineMembre.update({ where: { id: moi.id }, data: { etat: 'parti', cautionStatut: moi.cautionStatut === 'payee' ? 'a_rendre' : moi.cautionStatut } });
      return relire(id, userId);
    },

    async annuler(userId: string, id: string) {
      const t = await charger(id);
      exigerOrganisateur(t, userId);
      if (t.etat !== 'ouvert') throw new HttpError(409, 'Le groupe a démarré : il ne peut plus être annulé.');
      await d.db.tontine.update({ where: { id }, data: { etat: 'annule' } });
      await d.db.tontineMembre.updateMany({ where: { tontineId: id, cautionStatut: 'payee' }, data: { cautionStatut: 'a_rendre' } });
      await prevenirTous(t, `tontine:annule:${id}`, { titre: 'Groupe annulé', corps: `« ${t.nom} » : une caution payée te sera rendue.` }, t.membres.find((m) => m.userId === userId)?.id);
      return relire(id, userId);
    },

    /** Groupe complet et cautions payées : tirage au sort de l'ordre, puis premier tour. */
    async demarrer(userId: string, id: string) {
      const t = await charger(id);
      exigerOrganisateur(t, userId);
      if (t.etat !== 'ouvert') throw new HttpError(409, 'Ce groupe a déjà démarré.');
      if (!ouvertPour(t)) throw new HttpError(503, 'Le paiement n’est pas encore ouvert.');
      const liste = acceptes(t);
      if (liste.length !== t.places) throw new HttpError(409, 'Le groupe n’est pas complet.');
      if (!liste.every((m) => m.cautionStatut === 'payee')) throw new HttpError(409, 'Toutes les cautions ne sont pas payées.');
      const fait = await d.db.tontine.updateMany({ where: { id, etat: 'ouvert' }, data: { etat: 'en_cours', tourCourant: 1 } });
      if (!fait.count) return relire(id, userId);
      const tirer = d.tirer ?? ((max: number) => randomInt(max));
      const ordre = [...liste];
      for (let i = ordre.length - 1; i > 0; i--) {
        const j = tirer(i + 1);
        [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
      }
      const part = repartitionCagnotte(t.montant, t.places, t.commissionBps);
      const dates = echeancesTontine(t.rythme as RythmeTontine, jourDe(t), t.places);
      for (const [i, m] of ordre.entries()) {
        await d.db.tontineMembre.update({ where: { id: m.id }, data: { rang: i + 1 } });
        await d.db.tontineTour.create({ data: { tontineId: id, numero: i + 1, beneficiaireId: m.id, echeance: dates[i], etat: i === 0 ? 'collecte' : 'a_venir', ...part } });
      }
      const nom = prenomDe(contactDe(ordre[0]).nom);
      await prevenirTous(t, `tontine:depart:${id}`, { titre: `Cotisation à payer : ${montantCotisation(t.montant, t.devise)}`, corps: `« ${t.nom} » a démarré. Tour 1 sur ${t.places}, pour ${nom}.` });
      return relire(id, userId);
    },

    /** Le membre paie lui-même : la demande part vers son numéro, enregistré à l'adhésion. */
    async payer(userId: string, id: string, genre: 'caution' | 'cotisation') {
      const t = await charger(id);
      if (!ouvertPour(t)) throw new HttpError(503, 'Le paiement n’est pas encore ouvert.');
      if (!d.adresseServeur().startsWith('https://')) throw new HttpError(503, 'Le paiement est momentanément indisponible.');
      const moi = t.membres.find((m) => m.userId === userId);
      if (!moi || moi.etat !== 'accepte') throw new HttpError(403, 'Tu n’es pas membre de ce groupe.');
      let mvts = (await mouvementsDe(id)).filter((x) => x.membreId === moi.id);
      if (mvts.some((x) => x.statut === 'en_attente' && ENTREES.includes(x.genre))) return relire(id, userId);
      const { telephone } = contactDe(moi);
      if (!telephone) throw new HttpError(409, 'Numéro manquant.');
      await d.exigerNumero(telephone);
      if (mvts.filter((x) => x.mode === 'mobile' && x.createdAt.getTime() > maintenant() - 86400000).length >= DEMANDES_PAR_JOUR) throw new HttpError(429, 'Trop de demandes aujourd’hui. Réessaie demain.');
      // Une demande abandonnée a pu être validée entre-temps : ne pas faire payer deux fois.
      const anciennes = mvts.filter((x) => x.mode === 'mobile' && ENTREES.includes(x.genre) && REVERIFIABLES.includes(x.statut)).slice(-3);
      for (const a of anciennes) await verifier(a);
      const frais = await charger(id);
      const moiFrais = frais.membres.find((m) => m.id === moi.id)!;
      mvts = await mouvementsDe(id);
      const du = aPayer(frais, moiFrais, mvts);
      if (!du || du.genre !== genre) return relire(id, userId);

      let m: Mouvement;
      try {
        m = await d.db.tontineMouvement.create({ data: { reference: reference(), tontineId: id, membreId: moi.id, tourId: du.tourId, genre, montant: du.montant, devise: t.devise, mode: 'mobile', statut: 'en_attente', telephone: numeroMasque(telephone) } });
      } catch (e) {
        if (estDoublon(e)) return relire(id, userId);
        throw e;
      }
      try {
        const r = await d.flexpaie.demander({ telephone, reference: m.reference, montant: m.montant, devise: m.devise, retour: retourUrl() });
        await d.db.tontineMouvement.update({ where: { id: m.id }, data: { commande: r.commande } });
      } catch (e) {
        const config = e instanceof ErreurFlexpaie && e.configuration;
        await d.db.tontineMouvement.update({ where: { id: m.id }, data: { statut: 'echoue', message: config ? 'Paiement mobile money indisponible.' : (e as Error).message } });
        if (e instanceof ErreurFlexpaie) {
          console.error('FlexPaie', e.message);
          if (config) throw new HttpError(503, 'Le paiement mobile money est momentanément indisponible.');
          throw new HttpError(502, 'La demande n’a pas pu partir. Réessaie.');
        }
        throw e;
      }
      return relire(id, userId);
    },

    async abandonner(userId: string, id: string) {
      const t = await charger(id);
      const moi = t.membres.find((m) => m.userId === userId);
      if (!moi) throw new HttpError(404, 'Tu n’es pas dans ce groupe.');
      for (const m of (await mouvementsDe(id)).filter((x) => x.membreId === moi.id && x.statut === 'en_attente' && ENTREES.includes(x.genre))) {
        await verifier(m);
        await d.db.tontineMouvement.updateMany({ where: { id: m.id, statut: 'en_attente' }, data: { statut: 'abandonne', message: 'Demande abandonnée par le membre.' } });
      }
      return relire(id, userId);
    },

    /** L'organisateur relance un membre : un envoi par jour, par mail et SMS selon la configuration du système. */
    async rappeler(userId: string, membreId: string) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      const t = await charger(m.tontineId);
      exigerOrganisateur(t, userId);
      const du = aPayer(t, m, await mouvementsDe(t.id));
      if (!du) throw new HttpError(409, 'Ce membre n’a rien à payer.');
      if (!m.userId) throw new HttpError(409, 'Ce membre n’a plus de compte.');
      const r = await d.avertir(m.userId, contactDe(m).telephone, {
        cle: `tontine:rappel:${m.id}:${du.tourId ?? 'caution'}:${jourDe(t)}`,
        titre: du.genre === 'caution' ? `Caution à payer : ${montantCotisation(du.montant, t.devise)}` : `Cotisation à payer : ${montantCotisation(du.montant, t.devise)}`,
        corps: `« ${t.nom} ».`,
      });
      return { ...r, ...(await relire(t.id, userId)) };
    },

    /** Échéance dépassée : la caution couvre le tour pour que le bénéficiaire ne soit pas bloqué. Le membre devra la refaire. */
    async utiliserCaution(userId: string, membreId: string) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      const t = await charger(m.tontineId);
      exigerOrganisateur(t, userId);
      const tour = tourActuel(t);
      if (t.etat !== 'en_cours' || tour?.etat !== 'collecte') throw new HttpError(409, 'Aucune collecte en cours.');
      if (jourDe(t) <= tour.echeance) throw new HttpError(409, 'L’échéance n’est pas encore passée.');
      const mvts = await mouvementsDe(t.id);
      if (aCotise(mvts, m.id, tour.id)) throw new HttpError(409, 'Ce membre a déjà cotisé.');
      if (mvts.some((x) => x.membreId === m.id && x.statut === 'en_attente' && ENTREES.includes(x.genre))) throw new HttpError(409, 'Un paiement est en cours pour ce membre.');
      const fait = await d.db.tontineMembre.updateMany({ where: { id: m.id, cautionStatut: 'payee' }, data: { cautionStatut: 'utilisee' } });
      if (!fait.count) throw new HttpError(409, 'Ce membre n’a plus de caution : le groupe est bloqué, contacte l’administrateur.');
      await d.db.tontineMouvement.create({ data: { reference: reference(), tontineId: t.id, membreId: m.id, tourId: tour.id, genre: 'caution_utilisee', montant: t.montant, devise: t.devise, mode: 'interne', statut: 'paye', payeLe: new Date(maintenant()) } });
      if (m.userId) await d.avertir(m.userId, contactDe(m).telephone, { cle: `tontine:couvert:${m.id}:${tour.id}`, titre: 'Ta caution a couvert ta cotisation', corps: `« ${t.nom} » : refais ta caution de ${montantCotisation(t.montant, t.devise)}.` }).catch((e) => console.error('Avis de tontine', e));
      await fermerCollecte(t.id, tour.id);
      return relire(t.id, userId);
    },

    resumeAdmin,

    /** Validation de l'admin : seul ce geste fait sortir l'argent d'un tour. */
    async verserTour(adminNom: string, tourId: string, preuve?: string) {
      const tour = await d.db.tontineTour.findUnique({ where: { id: tourId } });
      if (!tour) throw new HttpError(404, 'Tour introuvable.');
      if (tour.etat !== 'a_verser') throw new HttpError(409, 'Ce tour n’attend pas de versement.');
      const t = await charger(tour.tontineId);
      const b = t.membres.find((m) => m.id === tour.beneficiaireId);
      const telephone = b ? contactDe(b).telephone : '';
      if (!telephone) throw new HttpError(409, 'Le bénéficiaire n’a plus de numéro.');
      await d.db.tontineTour.update({ where: { id: tourId }, data: { valideParNom: adminNom, valideLe: new Date(maintenant()) } });
      await sortie({ genre: 'versement', tontineId: t.id, membreId: b!.id, tourId, montant: tour.net, devise: t.devise, telephone, preuve });
      return resumeAdmin();
    },

    async rendreCaution(membreId: string, preuve?: string) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      if (m.cautionStatut !== 'a_rendre') throw new HttpError(409, 'Cette caution n’est pas à rendre.');
      const t = await charger(m.tontineId);
      const { telephone } = contactDe(m);
      if (!telephone) throw new HttpError(409, 'Le membre n’a plus de numéro.');
      await sortie({ genre: 'caution_rendue', tontineId: t.id, membreId: m.id, tourId: null, montant: t.montant, devise: t.devise, telephone, preuve });
      return resumeAdmin();
    },

    /** Appelée par FlexPaie : seule la référence sert, le mouvement est revérifié chez eux. */
    async retour(corps: Record<string, unknown>) {
      const commande = typeof corps.orderNumber === 'string' ? corps.orderNumber : null;
      const ref = typeof corps.reference === 'string' ? corps.reference : null;
      if (!commande && !ref) return { ok: true };
      const m = await d.db.tontineMouvement.findFirst({ where: { mode: 'mobile', OR: [...(commande ? [{ commande }] : []), ...(ref ? [{ reference: ref }] : [])] } });
      if (m) await verifier(m);
      return { ok: true };
    },

    /** Toutes les 5 minutes : retours perdus, puis rappels d'échéance, envoyés une seule fois. */
    async rattraper(instant = maintenant()) {
      const attente = await d.db.tontineMouvement.findMany({ where: { statut: 'en_attente', commande: { not: null }, createdAt: { gt: new Date(instant - ATTENTE_MS) } } });
      for (const m of attente) await verifier(m);
      // Une sortie d'argent reste en attente tant qu'elle n'est pas conclue : une relance automatique pourrait payer deux fois.
      await d.db.tontineMouvement.updateMany({ where: { statut: 'en_attente', genre: { in: ENTREES }, createdAt: { lte: new Date(instant - ATTENTE_MS) } }, data: { statut: 'expire', message: 'Paiement non validé à temps.' } });
      if (instant - dernierRattrapageLong >= RATTRAPAGE_PAS_MS) {
        dernierRattrapageLong = instant;
        const tardifs = await d.db.tontineMouvement.findMany({ where: { statut: { in: ['expire', 'abandonne'] }, commande: { not: null }, createdAt: { gt: new Date(instant - RATTRAPAGE_MS) } } });
        for (const m of tardifs) await verifier(m);
      }
      const tours = await d.db.tontineTour.findMany({ where: { etat: 'collecte' } });
      for (const tour of tours) {
        const t = await charger(tour.tontineId);
        const jour = jourDe(t);
        const moment = jour > tour.echeance ? 'retard' : jourPlus(jour, 1) >= tour.echeance ? 'bientot' : null;
        if (!moment) continue;
        const mvts = await mouvementsDe(t.id);
        for (const m of acceptes(t)) {
          if (!m.userId || aCotise(mvts, m.id, tour.id)) continue;
          await d
            .avertir(m.userId, contactDe(m).telephone, {
              cle: `tontine:echeance:${tour.id}:${m.id}:${moment}`,
              titre: moment === 'retard' ? `Cotisation en retard : ${montantCotisation(t.montant, t.devise)}` : `Cotisation à payer avant le ${tour.echeance.slice(8)}/${tour.echeance.slice(5, 7)}`,
              corps: `« ${t.nom} », tour ${tour.numero} sur ${t.places}.`,
            })
            .catch((e) => console.error('Avis de tontine', e));
        }
      }
    },

  };
}
