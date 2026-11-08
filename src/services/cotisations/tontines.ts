import { randomBytes, randomInt } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import { CAGNOTTE_MAX, COMMISSION_BPS, echeancesObjectif, echeancesTontine, montantCotisation, montantTontine, numeroMasque, prenomDe, rappelDuJour, rappelsDe, repartitionCagnotte, type LimitesCotisation, type RappelsGroupe, type RythmeObjectif, type RythmeTontine } from '../../commun/cotisations.js';
import { enCoffre, horsCoffre } from '../../utils/coffre.js';
import { HttpError } from '../../utils/http.js';
import { ErreurFlexpaie, normaliserTelephone, type EtatCommande } from '../abonnements/flexpaie.js';
import { local } from '../integrations/http.js';
import { cheminGroupe, cleAlerte, confianceDe, correspondAlerte, MAX_ALERTES, trier, type Confiance, type FiltresAlerte, type FiltresAnnuaire, type MotifSignalement } from './annuaire.js';
import { tientEnUnSms } from '../sms/asmsc.js';
import type { AvisGroupe } from './envois.js';

/** Le SMS d'invitation : le lien doit arriver entier, quitte à raccourcir le nom du groupe. */
export function smsInvitation(qui: string, nom: string, montant: string, lien: string): string {
  const qui2 = qui ? `${qui} t'invite` : 'Invitation';
  for (const n of [nom, nom.length > 24 ? `${nom.slice(0, 22).trimEnd()}…` : null]) {
    if (!n) continue;
    for (const t of [`${qui2} à la cotisation « ${n} » : ${montant}. Rejoindre : ${lien}`, `${qui2} à « ${n} » (${montant}) : ${lien}`]) if (tientEnUnSms(t)) return t;
  }
  return `Invitation Me : ${lien}`;
}

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
/** Au-delà, une cotisation à raison précise compte trop de périodes. */
const MAX_TOURS_OBJECTIF = 366;
const COMPTE_A_APPROUVER = 'COMPTE_A_APPROUVER';
const AUTRE_RESPONSABLE = 'Un autre responsable doit valider ce geste.';

type Contact = { nom: string; telephone: string };
/** Qui valide une sortie d'argent. */
export type Acteur = { id: string; nom: string; admin: boolean };
export type CompteTontine = { id: string; nom: string; fuseau: string; telephone: string | null };
type Compte = CompteTontine;
export type CreationTontine = {
  nom: string;
  description?: string;
  montant: number;
  devise: string;
  rythme: RythmeObjectif;
  places: number;
  mode: 'rotation' | 'objectif';
  visibilite: 'public' | 'prive';
  cautionRequise?: boolean;
  telephone?: string;
  raison?: string;
  beneficiaire?: { nom: string; telephone: string };
  dateFin?: string;
  rappels?: RappelsGroupe;
};
export type DepsTontines = {
  db: Pick<PrismaClient, 'tontine' | 'tontineMembre' | 'tontineTour' | 'tontineMouvement' | 'alerteAnnuaire' | 'signalementTontine'>;
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
  /** `obligatoire` : un rappel de groupe, envoyé sur ces canaux sans tenir compte des préférences du membre. */
  avertir(userId: string, telephone: string | null, avis: AvisGroupe, mode?: boolean | { mail: boolean; sms: boolean }): Promise<{ nouveau: boolean; mail: boolean; sms: boolean }>;
  /** Comptes approuvés pour l'annuaire. */
  comptesApprouves(ids: string[]): Promise<Set<string>>;
  adresseApp(): string | null;
  /** Les limites réglées par l'admin. */
  limites(): Promise<LimitesCotisation>;
  /** Une invitation envoyée par Me, selon les canaux du système. */
  envoyerInvitation(organisateurId: string, c: { telephone: string; titre: string; texte: string; sms?: string }): Promise<{ mail: boolean; sms: boolean }>;
  maintenant?: () => number;
  /** Pour les tests : le tirage au sort. */
  tirer?: (max: number) => number;
};

const INCLUS = { organisateur: { select: { nom: true, role: true, photoUrl: true, createdAt: true } }, membres: { orderBy: { createdAt: 'asc' }, include: { user: { select: { photoUrl: true } } } }, tours: { orderBy: { numero: 'asc' } } } satisfies Prisma.TontineInclude;
type TontineComplete = Prisma.TontineGetPayload<{ include: typeof INCLUS }>;
type Membre = TontineComplete['membres'][number];
type Mouvement = Prisma.TontineMouvementGetPayload<object>;

const reference = () => `TO${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`;
const estDoublon = (e: unknown) => (e as { code?: string })?.code === 'P2002';
const contactDe = (m: { contact: unknown }) => horsCoffre<Contact>(m.contact) ?? { nom: 'Ancien membre', telephone: '' };

export type { FiltresAnnuaire };

export function creerTontines(d: DepsTontines) {
  const maintenant = () => d.maintenant?.() ?? Date.now();
  const jourDe = (t: { fuseau: string }) => local(new Date(maintenant()), t.fuseau).date;
  let dernierRattrapageLong = 0;

  async function charger(id: string) {
    const t = await d.db.tontine.findUnique({ where: { id }, include: INCLUS });
    if (!t) throw new HttpError(404, 'Groupe introuvable.');
    return t;
  }
  const estObjectif = (t: Pick<TontineComplete, 'mode'>) => t.mode === 'objectif';
  const toursCollecte = (t: TontineComplete) => t.tours.filter((x) => x.numero > 0);
  const tourFinal = (t: TontineComplete) => t.tours.find((x) => x.numero === 0) ?? null;
  const beneficiaireDe = (t: Pick<TontineComplete, 'beneficiaire'>) => (t.beneficiaire ? horsCoffre<Contact>(t.beneficiaire) : null);
  const lienInvitation = (t: Pick<TontineComplete, 'codeInvitation'>) => (t.codeInvitation && d.adresseApp() ? `${d.adresseApp()}/g/${t.codeInvitation}` : null);
  /** Une rotation accueille jusqu'au démarrage, une raison précise jusqu'à sa date de fin. */
  const accueille = (t: TontineComplete) => (estObjectif(t) ? t.etat === 'en_cours' && !tourFinal(t) : t.etat === 'ouvert');
  const estOrganisateur = (t: TontineComplete, userId: string) => t.organisateurId === userId;
  function exigerOrganisateur(t: TontineComplete, userId: string) {
    if (!estOrganisateur(t, userId)) throw new HttpError(403, 'Réservé à l’organisateur du groupe.');
  }
  const acceptes = (t: TontineComplete) => t.membres.filter((m) => m.etat === 'accepte');
  const ouvertPour = (t: TontineComplete) => d.paiementOuvert(t.organisateur?.role ?? null);
  const tourActuel = (t: TontineComplete) => t.tours.find((x) => x.numero === t.tourCourant) ?? null;
  const mouvementsDe = (tontineId: string) => d.db.tontineMouvement.findMany({ where: { tontineId } });
  const aCotise = (mvts: Mouvement[], membreId: string, tourId: string) => mvts.some((x) => x.membreId === membreId && x.tourId === tourId && x.statut === 'paye' && (x.genre === 'cotisation' || x.genre === 'caution_utilisee'));

  /** Un membre arrivé en cours de route ne doit pas les périodes d'avant. */
  const toursDus = (t: TontineComplete, m: Pick<Membre, 'id' | 'createdAt'>, mvts: Mouvement[]) => {
    const entree = local(m.createdAt, t.fuseau).date;
    return toursCollecte(t).filter((x) => x.etat === 'collecte' && x.echeance >= entree && !aCotise(mvts, m.id, x.id));
  };

  /** Ce que ce membre doit payer maintenant : d'abord le tour, puis la caution. */
  function aPayer(t: TontineComplete, m: Pick<Membre, 'id' | 'etat' | 'cautionStatut' | 'createdAt'>, mvts: Mouvement[]) {
    if (m.etat !== 'accepte' || t.etat === 'annule' || t.etat === 'termine') return null;
    if (estObjectif(t)) {
      const dus = toursDus(t, m, mvts);
      return dus.length ? { genre: 'cotisation' as const, montant: t.montant, tourId: dus[0].id } : null;
    }
    const tour = t.etat === 'en_cours' ? tourActuel(t) : null;
    if (tour?.etat === 'collecte' && !aCotise(mvts, m.id, tour.id)) return { genre: 'cotisation' as const, montant: t.montant, tourId: tour.id };
    if (t.cautionRequise && (m.cautionStatut === 'due' || m.cautionStatut === 'utilisee')) return { genre: 'caution' as const, montant: t.montant, tourId: null };
    return null;
  }

  const carte = (t: TontineComplete, userId: string, confiance: Confiance | null = null) => ({
    id: t.id,
    nom: t.nom,
    description: t.description,
    montant: t.montant,
    devise: t.devise,
    rythme: t.rythme as RythmeObjectif,
    places: t.places,
    mode: t.mode as 'rotation' | 'objectif',
    visibilite: t.visibilite as 'public' | 'prive',
    cautionRequise: t.cautionRequise,
    raison: t.raison,
    beneficiaireNom: beneficiaireDe(t)?.nom ?? null,
    dateFin: t.dateFin,
    totalPrevu: t.montant * t.places * (estObjectif(t) ? Math.max(1, toursCollecte(t).length) : 1),
    inscrits: acceptes(t).length,
    etat: t.etat,
    organisateur: prenomDe(t.organisateur?.nom ?? ''),
    organisateurPhoto: t.organisateur?.photoUrl ?? null,
    ...repartitionCagnotte(t.montant, t.places, t.commissionBps),
    monEtat: t.membres.find((m) => m.userId === userId)?.etat ?? null,
    confiance,
    /** La page du groupe dans l'annuaire, à partager. */
    lien: t.visibilite === 'public' && d.adresseApp() ? `${d.adresseApp()}${cheminGroupe(t)}` : null,
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
      lienInvitation: orga ? lienInvitation(t) : null,
      rappels: rappelsDe(t.rappels),
      collecte: mvts.filter((x) => x.genre === 'cotisation' && x.statut === 'paye').reduce((n, x) => n + x.montant, 0),
      final: tourFinal(t) ? { etat: tourFinal(t)!.etat, net: tourFinal(t)!.net, commission: tourFinal(t)!.commission } : null,
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
            photo: m.user?.photoUrl ?? null,
            rang: m.rang,
            cautionPayee: m.cautionStatut !== 'due',
            cautionStatut: orga ? m.cautionStatut : null,
            aCotise: estObjectif(t) ? !toursDus(t, m, mvts).length : tour ? aCotise(mvts, m.id, tour.id) : false,
            enCours: mvts.some((x) => x.membreId === m.id && x.statut === 'en_attente' && ENTREES.includes(x.genre)),
          }))
        : [],
      demandes: orga ? t.membres.filter((m) => m.etat === 'demande').map((m) => ({ id: m.id, nom: contactDe(m).nom })) : [],
      tours: (orga || estAccepte) && !estObjectif(t) ? t.tours.map((x) => ({ numero: x.numero, beneficiaire: x.beneficiaireId ? (parMembre.get(x.beneficiaireId)?.nom ?? '') : '', pourMoi: x.beneficiaireId === moi?.id, echeance: x.echeance, etat: x.etat, net: x.net })) : [],
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
    if (b?.userId) await d.avertir(b.userId, contactDe(b).telephone, { cle: `tontine:complet:${tourId}`, titre: 'Ta cagnotte est complète', corps: `${montantCotisation(tour.net, t.devise)} réunis dans « ${t.nom} », en cours de validation. Tu seras prévenu au versement.` }).catch((e) => console.error('Avis de tontine', e));
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
    if (m.genre === 'cotisation' && m.tourId && !estObjectif(t)) await fermerCollecte(m.tontineId, m.tourId);
    // Un paiement validé en retard entre dans le versement final tant qu'il n'est pas parti.
    if (m.genre === 'cotisation' && estObjectif(t)) {
      const final = tourFinal(t);
      if (final?.etat === 'a_verser') {
        const total = (await mouvementsDe(t.id)).filter((x) => x.genre === 'cotisation' && x.statut === 'paye').reduce((n, x) => n + x.montant, 0);
        await d.db.tontineTour.update({ where: { id: final.id }, data: repartitionCagnotte(total, 1, t.commissionBps) });
      } else if (final) console.error(`Tontine ${t.id} : paiement ${m.reference} reçu après le versement final`);
    }
  }

  /** Raison précise : ouvre les périodes échues puis, après la date de fin, prépare le versement au bénéficiaire. */
  async function avancerObjectif(id: string) {
    const t = await charger(id);
    if (!estObjectif(t) || t.etat !== 'en_cours' || !t.dateFin) return;
    const jour = jourDe(t);
    const tours = toursCollecte(t);
    for (const [i, x] of tours.entries()) {
      if (x.etat === 'a_venir' && i > 0 && tours[i - 1].echeance < jour) await d.db.tontineTour.updateMany({ where: { id: x.id, etat: 'a_venir' }, data: { etat: 'collecte' } });
    }
    if (jour <= t.dateFin || tourFinal(t)) return;
    const mvts = await mouvementsDe(id);
    // On attend la réponse des demandes en cours : elles comptent dans la cagnotte.
    if (mvts.some((x) => x.statut === 'en_attente' && ENTREES.includes(x.genre))) return;
    await d.db.tontineTour.updateMany({ where: { tontineId: id, etat: { in: ['a_venir', 'collecte'] } }, data: { etat: 'clos' } });
    const total = mvts.filter((x) => x.genre === 'cotisation' && x.statut === 'paye').reduce((n, x) => n + x.montant, 0);
    if (!total) {
      await d.db.tontine.update({ where: { id }, data: { etat: 'termine' } });
      return;
    }
    const part = repartitionCagnotte(total, 1, t.commissionBps);
    try {
      await d.db.tontineTour.create({ data: { tontineId: id, numero: 0, echeance: t.dateFin, etat: 'a_verser', ...part } });
    } catch (e) {
      if (estDoublon(e)) return;
      throw e;
    }
    await prevenirOrganisateur(t, `tontine:fin-objectif:${id}`, { titre: 'Cotisation clôturée', corps: `« ${t.nom} » : ${montantCotisation(part.net, t.devise)} en cours de validation pour ${beneficiaireDe(t)?.nom ?? 'le bénéficiaire'}.` }, false);
  }

  /** Le tour est versé : le suivant s'ouvre, ou le groupe se termine et les cautions sont à rendre. */
  async function apresVersement(tourId: string) {
    const fait = await d.db.tontineTour.updateMany({ where: { id: tourId, etat: 'a_verser' }, data: { etat: 'verse' } });
    if (!fait.count) return;
    const tour = await d.db.tontineTour.findUniqueOrThrow({ where: { id: tourId } });
    const t = await charger(tour.tontineId);
    if (estObjectif(t)) {
      await d.db.tontine.update({ where: { id: t.id }, data: { etat: 'termine' } });
      await prevenirTous(t, `tontine:fin:${t.id}`, { titre: 'Cotisation versée', corps: `« ${t.nom} » : ${montantCotisation(tour.net, t.devise)} versés à ${beneficiaireDe(t)?.nom ?? 'le bénéficiaire'}.` });
      return;
    }
    const b = t.membres.find((m) => m.id === tour.beneficiaireId);
    if (b?.userId) await d.avertir(b.userId, contactDe(b).telephone, { cle: `tontine:verse:${tourId}`, titre: 'Ta cagnotte est versée', corps: `${montantCotisation(tour.net, t.devise)} du groupe « ${t.nom} » t’ont été versés.` }).catch((e) => console.error('Avis de tontine', e));
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

  async function exigerApprobation(userId: string) {
    if (!(await d.comptesApprouves([userId])).has(userId)) throw new HttpError(403, 'Fais approuver ton compte pour utiliser l’annuaire.', COMPTE_A_APPROUVER);
  }

  /** Envoie la demande de paiement. Un double clic n'en crée qu'une. */
  async function lancerDemande(t: TontineComplete, membreId: string, telephone: string, du: { genre: 'caution' | 'cotisation'; montant: number; tourId: string | null }) {
    let m: Mouvement;
    try {
      m = await d.db.tontineMouvement.create({ data: { reference: reference(), tontineId: t.id, membreId, tourId: du.tourId, genre: du.genre, montant: du.montant, devise: t.devise, mode: 'mobile', statut: 'en_attente', telephone: numeroMasque(telephone) } });
    } catch (e) {
      if (estDoublon(e)) return;
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
  }

  /** Une sortie d'argent après validation de l'admin : API FlexPaie si elle est ouverte, sinon preuve d'un versement fait hors de Me. */
  async function sortie(c: { acteur: string; genre: 'versement' | 'caution_rendue'; tontineId: string; membreId: string | null; tourId: string | null; montant: number; devise: string; telephone: string; preuve?: string }) {
    const base = { reference: reference(), tontineId: c.tontineId, membreId: c.membreId, tourId: c.tourId, genre: c.genre, montant: c.montant, devise: c.devise, telephone: numeroMasque(c.telephone), validePar: c.acteur };
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

  /** Ce que l'annuaire montre d'un groupe. Sans compte : le prénom de l'organisateur, jamais sa photo. */
  const carteVisible = (t: TontineComplete, userId: string | null, confiance: Confiance | null) => (userId ? carte(t, userId, confiance) : { ...carte(t, '', confiance), organisateurPhoto: null });

  /** Ce que chaque organisateur a déjà mené sur Me. */
  async function confianceOrganisateurs(groupes: TontineComplete[]) {
    const depuis = new Map(groupes.flatMap((t) => (t.organisateurId ? [[t.organisateurId, t.organisateur?.createdAt ?? null] as const] : [])));
    if (!depuis.size) return new Map<string, Confiance>();
    const menes = await d.db.tontine.findMany({
      where: { organisateurId: { in: [...depuis.keys()] }, etat: { in: ['en_cours', 'termine'] } },
      select: { organisateurId: true, etat: true, tours: { where: { etat: 'verse' }, select: { etat: true, echeance: true, valideLe: true } } },
    });
    return new Map([...depuis].map(([id, le]) => [id, confianceDe(menes.filter((m) => m.organisateurId === id), le)]));
  }

  /** Un nouveau groupe de l'annuaire : prévenir ceux dont la recherche enregistrée y correspond, dans l'app seulement. */
  async function alerterAnnuaire(t: TontineComplete) {
    const alertes = await d.db.alerteAnnuaire.findMany({ where: { userId: { not: t.organisateurId ?? '' } }, take: 2000 });
    const deja = new Set<string>();
    for (const a of alertes) {
      if (deja.has(a.userId) || !correspondAlerte(a.filtres as unknown as FiltresAlerte, t)) continue;
      deja.add(a.userId);
      const libres = t.places - acceptes(t).length;
      await d
        .avertir(a.userId, null, { cle: `annuaire:${t.id}:${a.userId}`, titre: 'Nouveau groupe dans l’annuaire', corps: `« ${t.nom} » : ${montantTontine(t.montant, t.devise, t.rythme as RythmeObjectif)}, ${libres} place${libres > 1 ? 's' : ''}.` }, true)
        .catch((e) => console.error('Alerte annuaire', e));
    }
  }

  async function mesAlertes(userId: string) {
    const alertes = await d.db.alerteAnnuaire.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return { alertes: alertes.map((a) => ({ id: a.id, filtres: a.filtres as unknown as FiltresAlerte, creeLe: a.createdAt })) };
  }

  /** Pour l'équipe : les groupes signalés, les plus signalés d'abord. */
  async function adminSignalements() {
    const ouverts = await d.db.signalementTontine.findMany({ where: { statut: 'ouvert' }, orderBy: { createdAt: 'desc' } });
    const parGroupe = new Map<string, typeof ouverts>();
    for (const x of ouverts) parGroupe.set(x.tontineId, [...(parGroupe.get(x.tontineId) ?? []), x]);
    const groupes = await Promise.all(
      [...parGroupe].map(async ([id, liste]) => {
        const t = await d.db.tontine.findUnique({ where: { id }, include: INCLUS });
        if (!t) return null;
        return {
          tontineId: id,
          groupe: t.nom,
          organisateur: t.organisateur?.nom ?? '',
          organisateurId: t.organisateurId,
          membres: acceptes(t).length,
          retire: !!t.retireAnnuaireLe,
          nombre: liste.length,
          motifs: liste.map((x) => ({ motif: x.motif as MotifSignalement, texte: x.texte, le: x.createdAt })),
        };
      }),
    );
    return { signalements: groupes.filter((g): g is NonNullable<typeof g> => g !== null).sort((a, b) => b.nombre - a.nombre) };
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
        const contact = estObjectif(t) ? beneficiaireDe(t) : b ? contactDe(b) : null;
        return { tourId: x.id, raison: t.raison, groupe: t.nom, numero: x.numero, places: t.places, beneficiaire: contact?.nom ?? '', telephone: contact?.telephone ?? '', brut: x.brut, commission: x.commission, net: x.net, devise: t.devise };
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
    limites: () => d.limites(),

    async annuaire(userId: string | null, f: FiltresAnnuaire = {}) {
      const where: Prisma.TontineWhereInput = {
        visibilite: 'public',
        retireAnnuaireLe: null,
        etat: f.ouverts ? 'ouvert' : { in: ['ouvert', 'en_cours'] },
        ...(f.mode ? { mode: f.mode } : {}),
        ...(f.rythme ? { rythme: f.rythme } : {}),
        ...(f.devise ? { devise: f.devise } : {}),
        ...(f.montantMax ? { montant: { lte: f.montantMax } } : {}),
      };
      const tous = await d.db.tontine.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: INCLUS });
      const mot = f.q?.trim().toLowerCase();
      const groupes = tous.filter((t) => accueille(t) && acceptes(t).length < t.places && (!mot || t.nom.toLowerCase().includes(mot)));
      // Seuls les groupes des comptes approuvés sont visibles.
      const approuves = await d.comptesApprouves(groupes.flatMap((t) => (t.organisateurId ? [t.organisateurId] : [])));
      const visibles = trier(
        groupes.filter((t) => t.organisateurId && approuves.has(t.organisateurId)).map((t) => ({ t, montant: t.montant, places: t.places, inscrits: acceptes(t).length, createdAt: t.createdAt })),
        f.tri,
      )
        .slice(0, 100)
        .map((x) => x.t);
      const confiances = await confianceOrganisateurs(visibles);
      return { groupes: visibles.map((t) => carteVisible(t, userId, confiances.get(t.organisateurId!) ?? null)) };
    },

    /** La page d'un groupe de l'annuaire, à partager. Un membre la voit encore quand le groupe est complet. */
    async groupeAnnuaire(userId: string | null, id: string) {
      const t = await d.db.tontine.findUnique({ where: { id }, include: INCLUS });
      const membre = !!userId && !!t?.membres.some((m) => m.userId === userId && ['demande', 'accepte'].includes(m.etat));
      if (!t || t.visibilite !== 'public' || !t.organisateurId) throw new HttpError(404, 'Ce groupe n’est plus dans l’annuaire.');
      const visible = !t.retireAnnuaireLe && accueille(t) && acceptes(t).length < t.places && (await d.comptesApprouves([t.organisateurId])).has(t.organisateurId);
      if (!visible && !membre) throw new HttpError(404, 'Ce groupe n’est plus dans l’annuaire.');
      const confiances = await confianceOrganisateurs([t]);
      return { groupe: carteVisible(t, userId, confiances.get(t.organisateurId) ?? null) };
    },

    mesAlertes,

    async creerAlerte(userId: string, f: FiltresAlerte) {
      const filtres: FiltresAlerte = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== '')) as FiltresAlerte;
      const miennes = await d.db.alerteAnnuaire.findMany({ where: { userId } });
      if (!miennes.some((a) => cleAlerte(a.filtres as unknown as FiltresAlerte) === cleAlerte(filtres))) {
        if (miennes.length >= MAX_ALERTES) throw new HttpError(409, `${MAX_ALERTES} alertes au maximum : supprime-en une.`);
        await d.db.alerteAnnuaire.create({ data: { userId, filtres: filtres as Prisma.InputJsonObject } });
      }
      return mesAlertes(userId);
    },

    async supprimerAlerte(userId: string, id: string) {
      await d.db.alerteAnnuaire.deleteMany({ where: { id, userId } });
      return mesAlertes(userId);
    },

    /** Un signalement par personne et par groupe : le renvoyer met à jour le motif. */
    async signaler(userId: string, id: string, motif: MotifSignalement, texte?: string) {
      const t = await d.db.tontine.findUnique({ where: { id }, include: INCLUS });
      if (!t || t.visibilite !== 'public') throw new HttpError(404, 'Groupe introuvable.');
      if (t.organisateurId === userId) throw new HttpError(400, 'Tu ne peux pas signaler ton propre groupe.');
      const data = { motif, texte: texte?.trim() || null, statut: 'ouvert', traitePar: null, traiteLe: null };
      const deja = await d.db.signalementTontine.findFirst({ where: { tontineId: id, userId } });
      if (deja) await d.db.signalementTontine.update({ where: { id: deja.id }, data });
      else await d.db.signalementTontine.create({ data: { tontineId: id, userId, ...data } });
      return { ok: true };
    },

    adminSignalements,

    /** Retirer garde le groupe pour ses membres et son argent : il ne figure plus dans l'annuaire, et personne ne peut plus le rejoindre. */
    async adminDeciderSignalement(a: Acteur, id: string, decision: 'retirer' | 'rejeter') {
      const t = await charger(id);
      const donnees = { statut: decision === 'retirer' ? 'retire' : 'rejete', traitePar: a.nom, traiteLe: new Date(maintenant()) };
      await d.db.signalementTontine.updateMany({ where: { tontineId: id, statut: 'ouvert' }, data: donnees });
      if (decision === 'retirer' && !t.retireAnnuaireLe) {
        await d.db.tontine.update({ where: { id }, data: { retireAnnuaireLe: new Date(maintenant()) } });
        await prevenirOrganisateur(t, `tontine:retire:${id}`, { titre: 'Groupe retiré de l’annuaire', corps: `« ${t.nom} » ne figure plus dans l’annuaire après des signalements. Tes membres et leur argent ne changent pas.` });
      }
      return adminSignalements();
    },

    async mesGroupes(userId: string) {
      const liens = await d.db.tontineMembre.findMany({ where: { userId, etat: { in: ['demande', 'accepte'] } }, select: { tontineId: true } });
      const groupes = await Promise.all(liens.map(async (l) => vue(await charger(l.tontineId), userId, await mouvementsDe(l.tontineId))));
      return { groupes: groupes.sort((a, b) => a.nom.localeCompare(b.nom)), versementApi: d.versementApi() };
    },

    /** Ouvrir un groupe revérifie mes paiements en attente : c'est ce que l'app interroge pendant la validation. */
    async detail(userId: string, id: string) {
      await avancerObjectif(id);
      const t = await charger(id);
      const moi = t.membres.find((m) => m.userId === userId);
      const orga = estOrganisateur(t, userId);
      if (moi || orga) for (const m of (await mouvementsDe(id)).filter((x) => (orga || x.membreId === moi?.id) && x.statut === 'en_attente' && ENTREES.includes(x.genre))) await verifier(m);
      return relire(id, userId);
    },

    async creer(u: Compte, c: CreationTontine) {
      if ((await d.db.tontineMembre.count({ where: { userId: u.id, etat: { in: ['demande', 'accepte'] } } })) >= MAX_GROUPES) throw new HttpError(409, `${MAX_GROUPES} groupes en cours au maximum.`);
      const limites = await d.limites();
      const montantMax = limites.montantMax[c.devise as 'USD' | 'CDF'];
      if (c.montant > montantMax) throw new HttpError(400, `La cotisation ne peut pas dépasser ${montantCotisation(montantMax, c.devise)}.`);
      if (c.places > limites.membresMax) throw new HttpError(400, `Un groupe ne peut pas dépasser ${limites.membresMax} membres.`);
      const publique = c.visibilite === 'public';
      if (publique) await exigerApprobation(u.id);
      // Dans l'annuaire, le numéro est celui confirmé par SMS ; sur invitation, l'initiateur répond de ses membres.
      const telephone = publique ? u.telephone : normaliserTelephone(c.telephone ?? '');
      if (!telephone) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
      await d.exigerNumero(telephone);
      const objectif = c.mode === 'objectif';
      const jour = local(new Date(maintenant()), u.fuseau).date;
      let beneficiaire: Contact | null = null;
      let dates: string[] = [];
      if (objectif) {
        if (!c.dateFin || c.dateFin <= jour) throw new HttpError(400, 'Choisis une date de fin à venir.');
        const numero = normaliserTelephone(c.beneficiaire?.telephone ?? '');
        if (!numero || !c.beneficiaire?.nom) throw new HttpError(400, 'Indique le nom et le numéro du bénéficiaire.');
        await d.exigerNumero(numero);
        beneficiaire = { nom: c.beneficiaire.nom, telephone: numero };
        dates = echeancesObjectif(c.rythme, jour, c.dateFin);
        if (dates.length > MAX_TOURS_OBJECTIF) throw new HttpError(400, 'Cette cotisation compte trop de périodes : choisis un autre rythme ou une date plus proche.');
      } else if (c.rythme === 'unique') throw new HttpError(400, 'Choisis un rythme.');
      if (c.montant * c.places * Math.max(1, dates.length) > CAGNOTTE_MAX) throw new HttpError(400, 'La cagnotte serait trop élevée : réduis le montant, le nombre de membres ou de périodes.');
      const cautionRequise = objectif ? false : publique ? true : c.cautionRequise !== false;
      const t = await d.db.tontine.create({
        data: {
          organisateurId: u.id, nom: c.nom, description: c.description || null, montant: c.montant, devise: c.devise, rythme: c.rythme, places: c.places, commissionBps: COMMISSION_BPS, fuseau: u.fuseau,
          mode: c.mode, visibilite: c.visibilite, cautionRequise, codeInvitation: publique ? null : randomBytes(9).toString('base64url'),
          raison: objectif ? (c.raison ?? null) : null, dateFin: objectif ? c.dateFin : null, ...(beneficiaire ? { beneficiaire: enCoffre(beneficiaire) } : {}),
          etat: objectif ? 'en_cours' : 'ouvert', tourCourant: objectif ? 1 : 0,
          rappels: rappelsDe(c.rappels),
        },
      });
      await d.db.tontineMembre.create({ data: { tontineId: t.id, userId: u.id, etat: 'accepte', cautionStatut: cautionRequise ? 'due' : 'dispense', contact: enCoffre({ nom: u.nom, telephone }), conditionsVersion: VERSION_CONDITIONS_TONTINE } });
      for (const [i, echeance] of dates.entries()) await d.db.tontineTour.create({ data: { tontineId: t.id, numero: i + 1, echeance, etat: i === 0 ? 'collecte' : 'a_venir', brut: 0, commission: 0, net: 0 } });
      if (publique) void charger(t.id).then(alerterAnnuaire).catch((e) => console.error('Alerte annuaire', e));
      return relire(t.id, u.id);
    },

    /** Ce qu'une personne invitée voit avant de rejoindre, même sans compte. */
    async invitation(code: string, userId?: string) {
      const t = await d.db.tontine.findUnique({ where: { codeInvitation: code }, include: INCLUS });
      if (!t || !accueille(t)) throw new HttpError(404, 'Cette invitation n’est plus valable.');
      return { groupe: carte(t, userId ?? '') };
    },

    /** Le lien vient de l'initiateur, responsable de son groupe : pas d'approbation de Me, et entrée directe. */
    async rejoindreParInvitation(u: Compte, code: string, brut: string) {
      const t = await d.db.tontine.findUnique({ where: { codeInvitation: code }, include: INCLUS });
      if (!t || !accueille(t)) throw new HttpError(404, 'Cette invitation n’est plus valable.');
      if (acceptes(t).length >= t.places) throw new HttpError(409, 'Ce groupe est complet.');
      const deja = t.membres.find((m) => m.userId === u.id);
      if (deja?.etat === 'accepte') return relire(t.id, u.id);
      if (deja?.etat === 'refuse') throw new HttpError(409, 'L’initiateur t’a retiré de ce groupe.');
      if (deja?.cautionStatut === 'a_rendre') throw new HttpError(409, 'Ta caution est en cours de remboursement.');
      if ((await d.db.tontineMembre.count({ where: { userId: u.id, etat: { in: ['demande', 'accepte'] } } })) >= MAX_GROUPES) throw new HttpError(409, `${MAX_GROUPES} groupes en cours au maximum.`);
      const telephone = normaliserTelephone(brut);
      if (!telephone) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
      await d.exigerNumero(telephone);
      const donnees = { contact: enCoffre({ nom: u.nom, telephone }), etat: 'accepte', cautionStatut: t.cautionRequise ? 'due' : 'dispense', conditionsVersion: VERSION_CONDITIONS_TONTINE };
      if (deja) await d.db.tontineMembre.update({ where: { id: deja.id }, data: donnees });
      else await d.db.tontineMembre.create({ data: { tontineId: t.id, userId: u.id, ...donnees } });
      await prevenirOrganisateur(t, `tontine:invite:${t.id}:${u.id}`, { titre: 'Invitation acceptée', corps: `${prenomDe(u.nom)} a rejoint « ${t.nom} ».` });
      return relire(t.id, u.id);
    },

    /** Me envoie le lien d'invitation, une fois par clic, selon les canaux du système. */
    async inviter(userId: string, id: string, brut: string) {
      const t = await charger(id);
      exigerOrganisateur(t, userId);
      const lien = lienInvitation(t);
      if (!lien || !accueille(t)) throw new HttpError(409, 'Ce groupe n’accepte plus d’invitation.');
      const telephone = normaliserTelephone(brut);
      if (!telephone) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
      await d.exigerNumero(telephone);
      const qui = prenomDe(t.organisateur?.nom ?? '');
      const texte = `${qui ? `${qui} t'invite` : 'Tu es invité'} à la cotisation « ${t.nom} » : ${montantTontine(t.montant, t.devise, t.rythme as RythmeObjectif)}. Rejoindre : ${lien}`;
      const envoi = await d.envoyerInvitation(userId, { telephone, titre: `Invitation « ${t.nom} »`, texte, sms: smsInvitation(qui, t.nom, montantTontine(t.montant, t.devise, t.rythme as RythmeObjectif), lien) });
      if (!envoi.mail && !envoi.sms) throw new HttpError(503, 'Aucun envoi possible : vérifie la configuration ou la limite du jour.');
      return envoi;
    },

    async adherer(u: Compte, id: string) {
      const t = await charger(id);
      if (t.visibilite !== 'public') throw new HttpError(404, 'Groupe introuvable.');
      if (t.retireAnnuaireLe) throw new HttpError(404, 'Ce groupe n’est plus dans l’annuaire.');
      if (!accueille(t)) throw new HttpError(409, 'Ce groupe n’accepte plus de membres.');
      await exigerApprobation(u.id);
      if (acceptes(t).length >= t.places) throw new HttpError(409, 'Ce groupe est complet.');
      const deja = t.membres.find((m) => m.userId === u.id);
      if (deja && ['demande', 'accepte'].includes(deja.etat)) return relire(id, u.id);
      if (deja?.etat === 'refuse') throw new HttpError(409, 'L’organisateur a refusé ta demande.');
      if (deja?.cautionStatut === 'a_rendre') throw new HttpError(409, 'Ta caution est en cours de remboursement.');
      if ((await d.db.tontineMembre.count({ where: { userId: u.id, etat: { in: ['demande', 'accepte'] } } })) >= MAX_GROUPES) throw new HttpError(409, `${MAX_GROUPES} groupes en cours au maximum.`);
      const telephone = u.telephone;
      if (!telephone) throw new HttpError(403, 'Confirme ton numéro par SMS d’abord.', COMPTE_A_APPROUVER);
      await d.exigerNumero(telephone);
      const donnees = { contact: enCoffre({ nom: u.nom, telephone }), etat: 'demande', cautionStatut: t.cautionRequise ? 'due' : 'dispense', conditionsVersion: VERSION_CONDITIONS_TONTINE };
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
      if (!accueille(t) || m.etat !== 'demande') throw new HttpError(409, 'Cette demande n’est plus ouverte.');
      if (accepte && acceptes(t).length >= t.places) throw new HttpError(409, 'Le groupe est complet.');
      await d.db.tontineMembre.update({ where: { id: m.id }, data: { etat: accepte ? 'accepte' : 'refuse' } });
      if (m.userId) await d.avertir(m.userId, contactDe(m).telephone, accepte ? { cle: `tontine:accepte:${m.id}`, titre: 'Demande acceptée', corps: `Tu entres dans « ${t.nom} ». Dernière étape : paie ta caution de ${montantCotisation(t.montant, t.devise)}.` } : { cle: `tontine:refuse:${m.id}`, titre: 'Demande refusée', corps: `L’organisateur de « ${t.nom} » n’a pas accepté ta demande. D’autres groupes t’attendent dans l’annuaire.` }).catch((e) => console.error('Avis de tontine', e));
      return relire(t.id, userId);
    },

    /** Avant le démarrage seulement. Une fois le tirage fait, le groupe compte sur chaque membre. */
    async quitter(userId: string, id: string) {
      const t = await charger(id);
      const moi = t.membres.find((m) => m.userId === userId);
      if (!moi || !['demande', 'accepte'].includes(moi.etat)) throw new HttpError(404, 'Tu n’es pas dans ce groupe.');
      if (!accueille(t)) throw new HttpError(409, 'Le groupe a démarré : tu ne peux plus le quitter.');
      if (estOrganisateur(t, userId)) throw new HttpError(409, 'Annule le groupe plutôt que de le quitter.');
      if ((await mouvementsDe(id)).some((x) => x.membreId === moi.id && x.statut === 'en_attente')) throw new HttpError(409, 'Un paiement est en cours.');
      await d.db.tontineMembre.update({ where: { id: moi.id }, data: { etat: 'parti', cautionStatut: moi.cautionStatut === 'payee' ? 'a_rendre' : moi.cautionStatut } });
      return relire(id, userId);
    },

    async annuler(userId: string, id: string) {
      const t = await charger(id);
      exigerOrganisateur(t, userId);
      if (estObjectif(t) ? t.etat !== 'en_cours' || tourFinal(t) : t.etat !== 'ouvert') throw new HttpError(409, 'Le groupe a démarré : il ne peut plus être annulé.');
      if (estObjectif(t) && (await mouvementsDe(id)).some((x) => x.genre === 'cotisation' && ['paye', 'en_attente'].includes(x.statut))) throw new HttpError(409, 'Des paiements existent : la cotisation va jusqu’à sa date de fin.');
      await d.db.tontine.update({ where: { id }, data: { etat: 'annule' } });
      await d.db.tontineMembre.updateMany({ where: { tontineId: id, cautionStatut: 'payee' }, data: { cautionStatut: 'a_rendre' } });
      await prevenirTous(t, `tontine:annule:${id}`, { titre: 'Groupe annulé', corps: `« ${t.nom} » est annulé. Si tu as payé une caution, elle te sera rendue.` }, t.membres.find((m) => m.userId === userId)?.id);
      return relire(id, userId);
    },

    /** Groupe complet et cautions payées : tirage au sort de l'ordre, puis premier tour. */
    async demarrer(userId: string, id: string) {
      const t = await charger(id);
      exigerOrganisateur(t, userId);
      if (estObjectif(t)) throw new HttpError(409, 'Cette cotisation est déjà ouverte.');
      if (t.etat !== 'ouvert') throw new HttpError(409, 'Ce groupe a déjà démarré.');
      if (!ouvertPour(t)) throw new HttpError(503, 'Le paiement n’est pas encore ouvert.');
      const liste = acceptes(t);
      if (liste.length !== t.places) throw new HttpError(409, 'Le groupe n’est pas complet.');
      if (t.cautionRequise && !liste.every((m) => m.cautionStatut === 'payee')) throw new HttpError(409, 'Toutes les cautions ne sont pas payées.');
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
      await avancerObjectif(id);
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

      await lancerDemande(t, moi.id, telephone, du);
      return relire(id, userId);
    },

    /** Groupe privé : l'initiateur, responsable du groupe, paie à la place d'un membre pour débloquer le tour. */
    async payerPourMembre(userId: string, membreId: string) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      const t = await charger(m.tontineId);
      exigerOrganisateur(t, userId);
      if (t.visibilite !== 'prive') throw new HttpError(409, 'Réservé aux groupes privés.');
      if (!ouvertPour(t)) throw new HttpError(503, 'Le paiement n’est pas encore ouvert.');
      if (!d.adresseServeur().startsWith('https://')) throw new HttpError(503, 'Le paiement est momentanément indisponible.');
      const moi = t.membres.find((x) => x.userId === userId);
      const telephone = moi ? contactDe(moi).telephone : '';
      if (!telephone) throw new HttpError(409, 'Numéro manquant.');
      const mvts = await mouvementsDe(t.id);
      if (mvts.some((x) => x.membreId === m.id && x.statut === 'en_attente' && ENTREES.includes(x.genre))) return relire(t.id, userId);
      if (mvts.filter((x) => x.membreId === m.id && x.mode === 'mobile' && x.createdAt.getTime() > maintenant() - 86400000).length >= DEMANDES_PAR_JOUR) throw new HttpError(429, 'Trop de demandes aujourd’hui. Réessaie demain.');
      const du = aPayer(t, m, mvts);
      if (du?.genre !== 'cotisation') throw new HttpError(409, 'Ce membre n’a pas de cotisation à payer.');
      await lancerDemande(t, m.id, telephone, du);
      return relire(t.id, userId);
    },

    /** L'initiateur retire un membre tant que le groupe n'a pas démarré. */
    async retirer(userId: string, membreId: string) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      const t = await charger(m.tontineId);
      exigerOrganisateur(t, userId);
      if (m.userId === userId) throw new HttpError(409, 'Annule le groupe plutôt que de te retirer.');
      if (!accueille(t)) throw new HttpError(409, 'Le groupe a démarré : ce membre reste.');
      if ((await mouvementsDe(t.id)).some((x) => x.membreId === m.id && x.statut === 'en_attente')) throw new HttpError(409, 'Un paiement est en cours pour ce membre.');
      await d.db.tontineMembre.update({ where: { id: m.id }, data: { etat: 'refuse', cautionStatut: m.cautionStatut === 'payee' ? 'a_rendre' : m.cautionStatut } });
      return relire(t.id, userId);
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
      const reglage = rappelsDe(t.rappels);
      const r = await d.avertir(
        m.userId,
        contactDe(m).telephone,
        {
          cle: `tontine:rappel:${m.id}:${du.tourId ?? 'caution'}:${jourDe(t)}`,
          titre: du.genre === 'caution' ? `Caution à payer : ${montantCotisation(du.montant, t.devise)}` : `Cotisation à payer : ${montantCotisation(du.montant, t.devise)}`,
          corps: `Groupe « ${t.nom} ». L’organisateur te le rappelle : paie dans Me, onglet Cotisations.`,
        },
        { mail: reglage.mail, sms: reglage.sms },
      );
      return { ...r, ...(await relire(t.id, userId)) };
    },

    /** L'initiateur règle les rappels de son groupe. Il en reste toujours au moins un : ils sont obligatoires. */
    async reglerRappels(userId: string, id: string, rappels: RappelsGroupe) {
      const t = await charger(id);
      exigerOrganisateur(t, userId);
      if (t.etat === 'termine' || t.etat === 'annule') throw new HttpError(409, 'Ce groupe est terminé.');
      await d.db.tontine.update({ where: { id }, data: { rappels: rappelsDe(rappels) } });
      return relire(id, userId);
    },

    /** Échéance dépassée : la caution couvre le tour pour que le bénéficiaire ne soit pas bloqué. Le membre devra la refaire. */
    async utiliserCaution(userId: string, membreId: string) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      const t = await charger(m.tontineId);
      exigerOrganisateur(t, userId);
      const tour = tourActuel(t);
      if (estObjectif(t) || t.etat !== 'en_cours' || tour?.etat !== 'collecte') throw new HttpError(409, 'Aucune collecte en cours.');
      if (jourDe(t) <= tour.echeance) throw new HttpError(409, 'L’échéance n’est pas encore passée.');
      const mvts = await mouvementsDe(t.id);
      if (aCotise(mvts, m.id, tour.id)) throw new HttpError(409, 'Ce membre a déjà cotisé.');
      if (mvts.some((x) => x.membreId === m.id && x.statut === 'en_attente' && ENTREES.includes(x.genre))) throw new HttpError(409, 'Un paiement est en cours pour ce membre.');
      const fait = await d.db.tontineMembre.updateMany({ where: { id: m.id, cautionStatut: 'payee' }, data: { cautionStatut: 'utilisee' } });
      if (!fait.count) throw new HttpError(409, 'Ce membre n’a plus de caution : le groupe est bloqué, contacte l’administrateur.');
      await d.db.tontineMouvement.create({ data: { reference: reference(), tontineId: t.id, membreId: m.id, tourId: tour.id, genre: 'caution_utilisee', montant: t.montant, devise: t.devise, mode: 'interne', statut: 'paye', payeLe: new Date(maintenant()) } });
      if (m.userId) await d.avertir(m.userId, contactDe(m).telephone, { cle: `tontine:couvert:${m.id}:${tour.id}`, titre: 'Ta caution a couvert ta cotisation', corps: `L’échéance de « ${t.nom} » était passée. Refais ta caution (${montantCotisation(t.montant, t.devise)}) pour rester dans le groupe.` }).catch((e) => console.error('Avis de tontine', e));
      await fermerCollecte(t.id, tour.id);
      return relire(t.id, userId);
    },

    resumeAdmin,

    /** Validation de l'admin : seul ce geste fait sortir l'argent d'un tour. */
    async verserTour(acteur: Acteur, tourId: string, preuve?: string) {
      const tour = await d.db.tontineTour.findUnique({ where: { id: tourId } });
      if (!tour) throw new HttpError(404, 'Tour introuvable.');
      if (tour.etat !== 'a_verser') throw new HttpError(409, 'Ce tour n’attend pas de versement.');
      const t = await charger(tour.tontineId);
      const b = t.membres.find((m) => m.id === tour.beneficiaireId);
      const telephone = estObjectif(t) ? (beneficiaireDe(t)?.telephone ?? '') : b ? contactDe(b).telephone : '';
      if (!telephone) throw new HttpError(409, 'Le bénéficiaire n’a plus de numéro.');
      // Pas de validation pour soi-même : ni sa propre cagnotte, ni celle d'un groupe qu'on organise pour une raison précise.
      if (!acteur.admin && (b?.userId === acteur.id || (estObjectif(t) && t.organisateurId === acteur.id))) throw new HttpError(403, AUTRE_RESPONSABLE);
      await d.db.tontineTour.update({ where: { id: tourId }, data: { valideParNom: acteur.nom, valideLe: new Date(maintenant()) } });
      await sortie({ acteur: acteur.nom, genre: 'versement', tontineId: t.id, membreId: b?.id ?? null, tourId, montant: tour.net, devise: t.devise, telephone, preuve });
      return resumeAdmin();
    },

    async rendreCaution(acteur: Acteur, membreId: string, preuve?: string) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      if (m.cautionStatut !== 'a_rendre') throw new HttpError(409, 'Cette caution n’est pas à rendre.');
      if (!acteur.admin && m.userId === acteur.id) throw new HttpError(403, AUTRE_RESPONSABLE);
      const t = await charger(m.tontineId);
      const { telephone } = contactDe(m);
      if (!telephone) throw new HttpError(409, 'Le membre n’a plus de numéro.');
      await sortie({ acteur: acteur.nom, genre: 'caution_rendue', tontineId: t.id, membreId: m.id, tourId: null, montant: t.montant, devise: t.devise, telephone, preuve });
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
      const objectifs = await d.db.tontine.findMany({ where: { mode: 'objectif', etat: 'en_cours' }, select: { id: true } });
      for (const o of objectifs) await avancerObjectif(o.id);
      const tours = await d.db.tontineTour.findMany({ where: { etat: 'collecte' } });
      for (const tour of tours) {
        const t = await charger(tour.tontineId);
        // Pas de rappel avant 8 h, heure du groupe.
        const { date: jour, heure } = local(new Date(instant), t.fuseau);
        if (heure < '08:00') continue;
        const reglage = rappelsDe(t.rappels);
        const moment = rappelDuJour(reglage, jour, tour.echeance);
        if (!moment) continue;
        const retard = moment.startsWith('apres');
        const date = `${tour.echeance.slice(8)}/${tour.echeance.slice(5, 7)}`;
        const mvts = await mouvementsDe(t.id);
        for (const m of acceptes(t)) {
          if (!m.userId || aCotise(mvts, m.id, tour.id) || (estObjectif(t) && !toursDus(t, m, mvts).some((x) => x.id === tour.id))) continue;
          await d
            .avertir(
              m.userId,
              contactDe(m).telephone,
              {
                cle: `tontine:echeance:${tour.id}:${m.id}:${moment}`,
                titre: retard ? `Cotisation en retard : ${montantCotisation(t.montant, t.devise)}` : moment === 'avant:0' ? `Cotisation à payer aujourd’hui : ${montantCotisation(t.montant, t.devise)}` : `Cotisation de ${montantCotisation(t.montant, t.devise)} à payer avant le ${date}`,
                corps: `Groupe « ${t.nom} »${estObjectif(t) ? '' : `, tour ${tour.numero} sur ${t.places}`}. ${retard ? `L’échéance du ${date} est passée : paie dès que possible.` : 'Paie dans Me, onglet Cotisations.'}`,
              },
              { mail: reglage.mail, sms: reglage.sms },
            )
            .catch((e) => console.error('Avis de tontine', e));
        }
      }
    },

  };
}
