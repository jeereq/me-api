import { createHmac, randomBytes, randomInt } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import { apresLimite, CAGNOTTE_MAX, echeancesAuJour, echeancesObjectif, horsLimites, montantCotisation, texteHeure, tropDeGroupes, type NiveauCompte, montantTontine, numeroMasque, penaliteDue, prenomDe, reglesDansLeCadre, REGLES_PLATEFORME_DEFAUT, rappelDuJour, rappelsDe, reglesDe, repartitionCagnotte, texteRegles, type LimitesCotisation, type RappelsGroupe, type ReglesPartielles, type ReglesPlateforme, type RythmeObjectif, type RythmeTontine } from '../../commun/cotisations.js';
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
export const VERSION_CONDITIONS_TONTINE = '2026-11-09';
const REVERIFIABLES = ['en_attente', 'expire', 'abandonne'];
const ENTREES = ['caution', 'cotisation'];
const ATTENTE_MS = 86400000;
const RATTRAPAGE_MS = 7 * 86400000;
const RATTRAPAGE_PAS_MS = 3600000;
/** Un numéro ne reçoit pas plus de demandes par jour. */
const DEMANDES_PAR_JOUR = 5;
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
  regles?: ReglesPartielles;
};
export type DepsTontines = {
  db: Pick<PrismaClient, 'tontine' | 'tontineMembre' | 'tontineTour' | 'tontineMouvement' | 'alerteAnnuaire' | 'signalementTontine' | 'tontineInvitation' | 'tontineChangement'>;
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
  /** Les anciennes limites réglées par l'admin (montant max par devise, membres) : valeurs par défaut des règles de la plateforme. */
  limites(): Promise<LimitesCotisation>;
  /** Le niveau d'un compte pour les limites : abonné Pro, approuvé, ou non approuvé. Par défaut : selon l'approbation. */
  niveau?: (userId: string) => Promise<NiveauCompte>;
  /** Une invitation envoyée par Me, selon les canaux du système. */
  envoyerInvitation(organisateurId: string, c: { telephone: string; titre: string; texte: string; sms?: string }): Promise<{ mail: boolean; sms: boolean }>;
  /** Les règles de la plateforme pour chaque sorte de groupe (admin). Par défaut : REGLES_PLATEFORME_DEFAUT. */
  reglesPlateforme?: () => Promise<ReglesPlateforme>;
  /** Ceux qui valident les versements (admins, commerciaux du module « versements »). */
  responsablesVersements?: () => Promise<string[]>;
  maintenant?: () => number;
  /** Pour les tests : le tirage au sort. */
  tirer?: (max: number) => number;
};

const INCLUS = { organisateur: { select: { nom: true, role: true, photoUrl: true, createdAt: true } }, membres: { orderBy: { createdAt: 'asc' }, include: { user: { select: { photoUrl: true } } } }, tours: { orderBy: { numero: 'asc' } }, invitations: { orderBy: { envoyeLe: 'desc' }, take: 100 }, changements: { orderBy: { createdAt: 'desc' }, take: 30 } } satisfies Prisma.TontineInclude;
type TontineComplete = Prisma.TontineGetPayload<{ include: typeof INCLUS }>;
type Membre = TontineComplete['membres'][number];
type Mouvement = Prisma.TontineMouvementGetPayload<object>;
type Changement = Prisma.TontineChangementGetPayload<object>;
/** Adjoints de l'initiateur, au plus. */
export const MAX_ADJOINTS = 2;

const reference = () => `TO${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`;
const estDoublon = (e: unknown) => (e as { code?: string })?.code === 'P2002';
const contactDe = (m: { contact: unknown }) => horsCoffre<Contact>(m.contact) ?? { nom: 'Ancien membre', telephone: '' };
/** Reconnaît le numéro d'une invitation sans le garder en clair. */
const empreinteInvitation = (tontineId: string, telephone: string) => createHmac('sha256', process.env.ENCRYPTION_KEY ?? 'me').update(`${tontineId}|${telephone}`).digest('hex');

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
  const estInitiateur = (t: Pick<TontineComplete, 'organisateurId'>, userId: string) => t.organisateurId === userId;
  const estAdjoint = (m: { role?: string | null; etat: string }) => m.role === 'adjoint' && m.etat === 'accepte';
  const adjointsDe = (t: TontineComplete) => t.membres.filter(estAdjoint);
  /** L'initiateur, ou l'un de ses adjoints : ils ont les mêmes droits sur le groupe. */
  const estOrganisateur = (t: TontineComplete, userId: string) => estInitiateur(t, userId) || adjointsDe(t).some((m) => m.userId === userId);
  function exigerOrganisateur(t: TontineComplete, userId: string) {
    if (!estOrganisateur(t, userId)) throw new HttpError(403, 'Réservé à l’organisateur du groupe.');
  }
  function exigerInitiateur(t: TontineComplete, userId: string) {
    if (!estInitiateur(t, userId)) throw new HttpError(403, 'Réservé à l’initiateur du groupe.');
  }
  const acceptes = (t: TontineComplete) => t.membres.filter((m) => m.etat === 'accepte');
  const ouvertPour = (t: TontineComplete) => d.paiementOuvert(t.organisateur?.role ?? null);
  const tourActuel = (t: TontineComplete) => t.tours.find((x) => x.numero === t.tourCourant) ?? null;
  const mouvementsDe = (tontineId: string) => d.db.tontineMouvement.findMany({ where: { tontineId } });
  const aCotise = (mvts: Mouvement[], membreId: string, tourId: string) => mvts.some((x) => x.membreId === membreId && x.tourId === tourId && x.statut === 'paye' && (x.genre === 'cotisation' || x.genre === 'caution_utilisee'));
  const reglesDuGroupe = (t: Pick<TontineComplete, 'regles' | 'visibilite' | 'montant' | 'rythme' | 'mode'>) => reglesDe(t.regles, { visibilite: t.visibilite as 'public' | 'prive', montant: t.montant, rythme: t.rythme, mode: t.mode });
  /** Jour et heure du groupe, maintenant. */
  const instantDe = (t: { fuseau: string }) => local(new Date(maintenant()), t.fuseau);
  /** L'heure limite du jour d'échéance est passée (ou le jour lui-même) ? */
  const echu = (t: TontineComplete, echeance: string) => {
    const { date, heure } = instantDe(t);
    return apresLimite(reglesDuGroupe(t), echeance, date, heure);
  };
  const niveauDe = async (userId: string): Promise<NiveauCompte> => (d.niveau ? d.niveau(userId) : (await d.comptesApprouves([userId])).has(userId) ? 'approuve' : 'standard');
  const groupesEnCours = (userId: string) => d.db.tontineMembre.count({ where: { userId, etat: { in: ['demande', 'accepte'] } } });
  /** Le plafond de groupes et la cotisation au plus, selon le niveau du compte. */
  async function exigerNiveau(userId: string, c: { visibilite: 'public' | 'prive'; rythme: RythmeObjectif; devise: string; montant: number }) {
    const p = await plateforme();
    const niveau = await niveauDe(userId);
    const trop = tropDeGroupes(p, niveau, await groupesEnCours(userId));
    if (trop) throw new HttpError(409, trop);
    const hors = horsLimites(p, c, niveau);
    if (hors) throw new HttpError(400, hors);
  }
  const plateforme = async () => (await d.reglesPlateforme?.()) ?? REGLES_PLATEFORME_DEFAUT;
  /** Les demandes de paiement sont-elles réservées à l'initiateur pour ce groupe ? (règle de la plateforme, lue à chaque fois) */
  const demandesParInitiateur = async (t: Pick<TontineComplete, 'visibilite'>) => (await plateforme())[t.visibilite as 'public' | 'prive'].demandes === 'initiateur';

  /** Les retards d'un membre dans ce groupe : payé après l'échéance, couvert par la caution, ou toujours dû après l'échéance. */
  function retardsDe(t: TontineComplete, m: Pick<Membre, 'id' | 'createdAt'>, mvts: Mouvement[]) {
    const { date: jour, heure } = instantDe(t);
    const regles = reglesDuGroupe(t);
    const entree = local(m.createdAt, t.fuseau).date;
    let n = 0;
    for (const tour of toursCollecte(t)) {
      if (tour.etat === 'a_venir' || (estObjectif(t) && tour.echeance < entree)) continue;
      const p = mvts.find((x) => x.membreId === m.id && x.tourId === tour.id && x.statut === 'paye' && (x.genre === 'cotisation' || x.genre === 'caution_utilisee'));
      if (p) {
        const quand = p.payeLe ? local(p.payeLe, t.fuseau) : null;
        if (p.genre === 'caution_utilisee' || (quand && apresLimite(regles, tour.echeance, quand.date, quand.heure))) n++;
      } else if (tour.etat === 'collecte' && apresLimite(regles, tour.echeance, jour, heure)) n++;
    }
    return n;
  }

  /** Les retards d'une personne dans ses autres groupes : une condition d'entrée possible. */
  async function retardsAilleurs(userId: string, sauf: string) {
    const liens = await d.db.tontineMembre.findMany({ where: { userId, etat: { in: ['accepte', 'parti', 'exclu'] } } });
    let n = 0;
    for (const l of liens.filter((x) => x.tontineId !== sauf)) {
      const t = await charger(l.tontineId);
      const m = t.membres.find((x) => x.id === l.id);
      if (m) n += retardsDe(t, m, await mouvementsDe(t.id));
    }
    return n;
  }

  async function exigerEntree(t: TontineComplete, userId: string) {
    const r = reglesDuGroupe(t);
    if (r.entree.compteApprouve && !(await d.comptesApprouves([userId])).has(userId)) throw new HttpError(403, 'Ce groupe demande un compte approuvé par Me.', COMPTE_A_APPROUVER);
    if (r.entree.retardsMax >= 0 && (await retardsAilleurs(userId, t.id)) > r.entree.retardsMax)
      throw new HttpError(403, r.entree.retardsMax ? `Ce groupe accepte au plus ${r.entree.retardsMax} retard${r.entree.retardsMax > 1 ? 's' : ''} dans d’autres groupes.` : 'Ce groupe n’accepte que les membres sans retard dans leurs autres groupes.');
  }

  /** Un membre arrivé en cours de route ne doit pas les périodes d'avant. */
  const toursDus = (t: TontineComplete, m: Pick<Membre, 'id' | 'createdAt'>, mvts: Mouvement[]) => {
    const entree = local(m.createdAt, t.fuseau).date;
    return toursCollecte(t).filter((x) => x.etat === 'collecte' && x.echeance >= entree && !aCotise(mvts, m.id, x.id));
  };

  /** Ce que ce membre doit payer maintenant : d'abord le tour, puis la caution. */
  function aPayer(t: TontineComplete, m: Pick<Membre, 'id' | 'etat' | 'cautionStatut' | 'createdAt'>, mvts: Mouvement[]) {
    if (m.etat !== 'accepte' || t.etat === 'annule' || t.etat === 'termine') return null;
    const regles = reglesDuGroupe(t);
    const cotisation = (tour: { id: string; echeance: string }) => {
      const { date, heure } = instantDe(t);
      const penalite = penaliteDue(regles, tour.echeance, date, heure);
      return { genre: 'cotisation' as const, montant: t.montant + penalite, penalite, tourId: tour.id as string | null };
    };
    if (estObjectif(t)) {
      const dus = toursDus(t, m, mvts);
      return dus.length ? cotisation(dus[0]) : null;
    }
    const tour = t.etat === 'en_cours' ? tourActuel(t) : null;
    if (tour?.etat === 'collecte' && !aCotise(mvts, m.id, tour.id)) return cotisation(tour);
    if (t.cautionRequise && (m.cautionStatut === 'due' || m.cautionStatut === 'utilisee')) return { genre: 'caution' as const, montant: t.montant, penalite: 0, tourId: null };
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

  /** Les changements en attente que cette personne voit : ceux qui la concernent, ou tous pour l'initiateur et ses adjoints. */
  function changementsVus(t: TontineComplete, userId: string, orga: boolean) {
    const nomDe = (id: string | null) => {
      const m = id ? t.membres.find((x) => x.id === id) : null;
      return m ? contactDe(m).nom : '';
    };
    return (t.changements ?? [])
      .filter((c) => c.etat === 'en_attente')
      .map((c) => {
        const r = rolesChangement(t, c, userId);
        return { c, r };
      })
      .filter(({ r }) => orga || r.membre || r.autre)
      .map(({ c, r }) => ({
        id: c.id,
        genre: c.genre as 'remplacement' | 'echange',
        membre: nomDe(c.membreId),
        avec: c.genre === 'echange' ? nomDe(c.avecMembreId) : c.nouveauContact ? (horsCoffre<Contact>(c.nouveauContact)?.nom ?? '') : '',
        numero: c.numero,
        accords: { membre: c.accordMembre, autre: c.accordAutre, initiateur: c.accordInitiateur },
        /** Ce que cette personne peut encore accepter. */
        aDonner: (r.membre && !c.accordMembre) || (r.autre && !c.accordAutre) || (r.initiateur && !c.accordInitiateur),
        annulable: c.demandeParId === userId || r.membre,
        creeLe: c.createdAt,
      }));
  }

  function vue(t: TontineComplete, userId: string, mvts: Mouvement[], cadre: ReglesPlateforme = REGLES_PLATEFORME_DEFAUT) {
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
      commissionBps: t.commissionBps,
      /** Règle de la plateforme : seul l'initiateur lance les demandes de paiement. */
      demandesParInitiateur: cadre[t.visibilite as 'public' | 'prive'].demandes === 'initiateur',
      suisOrganisateur: orga,
      /** L'initiateur lui-même (les adjoints ont `suisOrganisateur` mais pas ce droit : nommer des adjoints, annuler). */
      suisInitiateur: estInitiateur(t, userId),
      adjoints: adjointsDe(t).map((m) => ({ id: m.id, nom: contactDe(m).nom })),
      changements: changementsVus(t, userId, orga),
      /** Raison précise : l'initiateur peut clôturer avant la date de fin pour demander le versement. */
      cloturable: orga && estObjectif(t) && t.etat === 'en_cours' && !tourFinal(t),
      /** Pour l'organisateur : ce qui peut être versé maintenant au bénéficiaire, et ce qui l'a déjà été. */
      versement: orga ? (() => {
        const v = versementDe(t, mvts);
        return v ? { complet: v.complet, net: v.net, verse: v.paye, enCours: v.enCours, disponible: v.disponible, trancheDemandeLe: estObjectif(t) ? (t.trancheDemandeLe ?? null) : (t.tours.find((x) => x.id === v.tourId)?.versementDemandeLe ?? null) } : null;
      })() : null,
      lienInvitation: orga ? lienInvitation(t) : null,
      rappels: rappelsDe(t.rappels),
      regles: reglesDuGroupe(t),
      texteRegles: texteRegles(reglesDuGroupe(t), t.devise, t.rythme),
      /** Les règles se changent avant le démarrage, et tant qu'aucune cotisation n'est payée pour une raison précise. */
      reglesModifiables: orga && (estObjectif(t) ? !mvts.some((x) => x.genre === 'cotisation' && x.statut === 'paye') : t.etat === 'ouvert'),
      invitations: orga ? t.invitations.map((x) => ({ id: x.id, numero: x.numero, mail: x.mail, sms: x.sms, envois: x.envois, envoyeLe: x.envoyeLe, rejointLe: x.rejointLe })) : [],
      collecte: mvts.filter((x) => x.genre === 'cotisation' && x.statut === 'paye').reduce((n, x) => n + x.montant, 0),
      final: tourFinal(t) ? { etat: tourFinal(t)!.etat, net: tourFinal(t)!.net, commission: tourFinal(t)!.commission, versementDemandeLe: tourFinal(t)!.versementDemandeLe } : null,
      tourCourant: t.tourCourant,
      jour: jourDe(t),
      moi: moi ? { id: moi.id, etat: moi.etat, rang: moi.rang, cautionStatut: moi.cautionStatut, telephone: numeroMasque(contactDe(moi).telephone) } : null,
      aPayer: du ? { genre: du.genre, montant: du.montant, penalite: du.penalite } : null,
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
            retards: retardsDe(t, m, mvts),
            adjoint: estAdjoint(m),
            initiateur: m.userId === t.organisateurId,
            ...(orga ? { du: aPayer(t, m, mvts)?.genre === 'cotisation' ? (aPayer(t, m, mvts)?.montant ?? null) : null, especes: mvts.filter((x) => x.membreId === m.id && x.mode === 'especes' && x.statut === 'paye').reduce((n, x) => n + x.montant, 0) } : {}),
          }))
        : [],
      demandes: orga ? t.membres.filter((m) => m.etat === 'demande').map((m) => ({ id: m.id, nom: contactDe(m).nom })) : [],
      tours: (orga || estAccepte) && !estObjectif(t) ? t.tours.map((x) => ({ numero: x.numero, beneficiaire: x.beneficiaireId ? (parMembre.get(x.beneficiaireId)?.nom ?? '') : '', pourMoi: x.beneficiaireId === moi?.id, echeance: x.echeance, etat: x.etat, net: x.net, especes: x.especes, versementDemandeLe: x.versementDemandeLe })) : [],
    };
  }

  /*
   * Versement en plusieurs tranches : le bénéficiaire peut recevoir, au fil des paiements, ce qui est déjà arrivé (net de
   * la commission), sans attendre la cagnotte complète. Le reste part quand tout est réuni.
   */
  const SORTIES = ['en_attente', 'paye'];
  const verseSur = (mvts: Mouvement[], garder: (x: Mouvement) => boolean, statuts = SORTIES) => mvts.filter((x) => x.genre === 'versement' && statuts.includes(x.statut) && garder(x)).reduce((n, x) => n + x.montant, 0);
  /** Ce qui peut partir maintenant vers le bénéficiaire d'un tour (rotation) ou d'une raison précise (`tour` absent). */
  function etatVersement(t: TontineComplete, mvts: Mouvement[], tour?: TontineComplete['tours'][number] | null) {
    if (estObjectif(t)) {
      const final = tourFinal(t);
      const recu = mvts.filter((x) => x.genre === 'cotisation' && x.statut === 'paye' && x.mode !== 'especes').reduce((n, x) => n + x.montant, 0);
      const net = final ? final.net : repartitionCagnotte(recu, 1, t.commissionBps).net;
      const verse = verseSur(mvts, () => true);
      return { cle: `g:${t.id}`, tourId: final?.id ?? null, complet: final?.etat === 'a_verser', net, verse, paye: verseSur(mvts, () => true, ['paye']), disponible: Math.max(0, net - verse), enCours: mvts.some((x) => x.genre === 'versement' && x.statut === 'en_attente') };
    }
    if (!tour) return null;
    const recu = mvts.filter((x) => x.tourId === tour.id && x.statut === 'paye' && x.mode !== 'especes' && (x.genre === 'cotisation' || x.genre === 'caution_utilisee')).reduce((n, x) => n + x.montant, 0);
    const net = tour.etat === 'a_verser' || tour.etat === 'verse' ? tour.net : repartitionCagnotte(recu, 1, t.commissionBps).net;
    const verse = verseSur(mvts, (x) => x.tourId === tour.id);
    return { cle: `t:${tour.id}`, tourId: tour.id, complet: tour.etat === 'a_verser', net, verse, paye: verseSur(mvts, (x) => x.tourId === tour.id, ['paye']), disponible: tour.etat === 'verse' ? 0 : Math.max(0, net - verse), enCours: mvts.some((x) => x.genre === 'versement' && x.tourId === tour.id && x.statut === 'en_attente') };
  }
  /** Le versement en cours d'un groupe : le tour à verser, sinon le tour en collecte, ou la raison précise. */
  const versementDe = (t: TontineComplete, mvts: Mouvement[]) => {
    if (t.etat !== 'en_cours' || (estObjectif(t) ? tourFinal(t)?.etat === 'verse' : false)) return null;
    return estObjectif(t) ? etatVersement(t, mvts) : etatVersement(t, mvts, t.tours.find((x) => x.etat === 'a_verser') ?? (tourActuel(t)?.etat === 'collecte' ? tourActuel(t) : null));
  };

  /** Qui est cette personne pour ce changement : le membre qui cède ou propose, l'autre membre d'un échange, un organisateur. */
  function rolesChangement(t: TontineComplete, c: Pick<Changement, 'membreId' | 'avecMembreId' | 'genre'>, userId: string) {
    const userDe = (id: string | null) => (id ? (t.membres.find((m) => m.id === id)?.userId ?? null) : null);
    return { membre: userDe(c.membreId) === userId, autre: c.genre === 'echange' && userDe(c.avecMembreId) === userId, initiateur: estOrganisateur(t, userId) };
  }

  /** Une place peut changer de main tant que son titulaire n'a pas reçu, sans paiement en cours. */
  async function exigerPlaceLibre(t: TontineComplete, m: Membre) {
    if (m.etat !== 'accepte') throw new HttpError(409, 'Ce membre n’est plus dans le groupe.');
    if (t.etat === 'termine' || t.etat === 'annule' || (estObjectif(t) && tourFinal(t))) throw new HttpError(409, 'Ce groupe est terminé.');
    if (!estObjectif(t) && t.tours.some((x) => x.beneficiaireId === m.id && (x.etat === 'verse' || x.etat === 'a_verser'))) throw new HttpError(409, 'Ce membre a déjà reçu sa cagnotte : il reste jusqu’au bout.');
    if ((await mouvementsDe(t.id)).some((x) => x.membreId === m.id && x.statut === 'en_attente')) throw new HttpError(409, 'Un paiement est en cours pour ce membre.');
    if ((t.changements ?? []).some((c) => c.etat === 'en_attente' && (c.membreId === m.id || c.avecMembreId === m.id))) throw new HttpError(409, 'Un changement est déjà en attente pour ce membre.');
  }

  /** Tout le monde est d'accord : la place change de main, ou les deux tours sont échangés. */
  async function appliquerSiPret(changementId: string) {
    const c = await d.db.tontineChangement.findUnique({ where: { id: changementId } });
    if (!c || c.etat !== 'en_attente' || !c.accordMembre || !c.accordAutre || !c.accordInitiateur) return;
    const t = await charger(c.tontineId);
    const m = t.membres.find((x) => x.id === c.membreId);
    if (!m || m.etat !== 'accepte') {
      await d.db.tontineChangement.update({ where: { id: c.id }, data: { etat: 'annule' } });
      return;
    }
    if (c.genre === 'echange') {
      const a = t.tours.find((x) => x.beneficiaireId === c.membreId);
      const b = t.tours.find((x) => x.beneficiaireId === c.avecMembreId);
      const autre = t.membres.find((x) => x.id === c.avecMembreId);
      if (!a || !b || !autre || a.etat !== 'a_venir' || b.etat !== 'a_venir') {
        await d.db.tontineChangement.update({ where: { id: c.id }, data: { etat: 'annule' } });
        return;
      }
      const fait = await d.db.tontineChangement.updateMany({ where: { id: c.id, etat: 'en_attente' }, data: { etat: 'fait', faitLe: new Date(maintenant()) } });
      if (!fait.count) return;
      await d.db.tontineTour.update({ where: { id: a.id }, data: { beneficiaireId: autre.id } });
      await d.db.tontineTour.update({ where: { id: b.id }, data: { beneficiaireId: m.id } });
      await d.db.tontineMembre.update({ where: { id: m.id }, data: { rang: b.numero } });
      await d.db.tontineMembre.update({ where: { id: autre.id }, data: { rang: a.numero } });
      await prevenirTous(t, `tontine:echange:${c.id}`, { titre: 'Tours échangés', corps: `« ${t.nom} » : ${prenomDe(contactDe(m).nom)} reçoit au tour ${b.numero}, ${prenomDe(contactDe(autre).nom)} au tour ${a.numero}.` });
      return;
    }
    const nouveau = c.nouveauContact ? horsCoffre<Contact>(c.nouveauContact) : null;
    if (!c.nouveauUserId || !nouveau) return;
    if (t.membres.some((x) => x.userId === c.nouveauUserId)) {
      await d.db.tontineChangement.update({ where: { id: c.id }, data: { etat: 'annule' } });
      return;
    }
    const fait = await d.db.tontineChangement.updateMany({ where: { id: c.id, etat: 'en_attente' }, data: { etat: 'fait', faitLe: new Date(maintenant()) } });
    if (!fait.count) return;
    const ancien = { userId: m.userId, ...contactDe(m) };
    // La place garde tout ce qui y est attaché : cotisations payées, caution, tour de réception.
    await d.db.tontineMembre.update({ where: { id: m.id }, data: { userId: c.nouveauUserId, contact: enCoffre(nouveau), conditionsVersion: VERSION_CONDITIONS_TONTINE, role: 'membre' } });
    if (ancien.userId) await d.avertir(ancien.userId, ancien.telephone, { cle: `tontine:cede:${c.id}`, titre: 'Place cédée', corps: `« ${t.nom} » : ta place est reprise par ${prenomDe(nouveau.nom)}. Tu ne dois plus rien au groupe.` }).catch((e) => console.error('Avis de tontine', e));
    await d.avertir(c.nouveauUserId, nouveau.telephone, { cle: `tontine:reprise:${c.id}`, titre: 'Tu entres dans le groupe', corps: `Tu reprends la place de ${prenomDe(ancien.nom)} dans « ${t.nom} ».` }).catch((e) => console.error('Avis de tontine', e));
    await prevenirOrganisateur(t, `tontine:remplacement:${c.id}`, { titre: 'Place reprise', corps: `« ${t.nom} » : ${prenomDe(nouveau.nom)} remplace ${prenomDe(ancien.nom)}.` });
  }

  /** La personne invitée accepte de reprendre la place : elle donne son numéro mobile money, puis le changement se fait si tout le monde est d'accord. */
  async function reprendrePlace(u: Compte, c: Changement, brut: string) {
    const t = await charger(c.tontineId);
    if (c.etat !== 'en_attente') {
      if (c.nouveauUserId === u.id) return { ...(await relire(t.id, u.id)), remplacement: carteRemplacement(t, c, await mouvementsDe(t.id)) };
      throw new HttpError(404, 'Cette invitation n’est plus valable.');
    }
    const m = t.membres.find((x) => x.id === c.membreId);
    if (m?.userId === u.id) throw new HttpError(409, 'C’est ta propre place.');
    if (t.membres.some((x) => x.userId === u.id)) throw new HttpError(409, 'Tu as déjà une place dans ce groupe.');
    if (c.nouveauUserId && c.nouveauUserId !== u.id) throw new HttpError(409, 'Quelqu’un a déjà accepté cette place.');
    const telephone = normaliserTelephone(brut);
    if (!telephone) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
    await d.exigerNumero(telephone);
    if (t.visibilite === 'public') await exigerApprobation(u.id);
    await exigerEntree(t, u.id);
    await exigerNiveau(u.id, { visibilite: t.visibilite as 'public' | 'prive', rythme: t.rythme as RythmeObjectif, devise: t.devise, montant: t.montant });
    await d.db.tontineChangement.update({ where: { id: c.id }, data: { nouveauUserId: u.id, nouveauContact: enCoffre({ nom: u.nom, telephone }), accordAutre: true } });
    await appliquerSiPret(c.id);
    const apres = await d.db.tontineChangement.findUnique({ where: { id: c.id } });
    if (apres?.etat === 'en_attente') await prevenirOrganisateur(t, `tontine:reprise-acceptee:${c.id}`, { titre: 'Remplacement à valider', corps: `« ${t.nom} » : ${prenomDe(u.nom)} accepte de reprendre la place de ${m ? prenomDe(contactDe(m).nom) : 'ce membre'}.` });
    const frais = await charger(t.id);
    return { ...(await relire(t.id, u.id)), remplacement: carteRemplacement(frais, apres ?? c, await mouvementsDe(t.id)) };
  }

  /**
   * L'initiateur demande à l'équipe de verser au bénéficiaire ce qui est déjà arrivé, sans attendre la cagnotte complète.
   * Une relance est possible après un jour.
   */
  async function demanderTranche(t: TontineComplete, userId: string) {
    const v = versementDe(t, await mouvementsDe(t.id));
    if (!v || !v.disponible) throw new HttpError(409, 'Rien à verser pour l’instant : l’argent n’est pas encore arrivé.');
    const tour = estObjectif(t) ? null : t.tours.find((x) => x.id === v.tourId)!;
    const deja = estObjectif(t) ? t.trancheDemandeLe : tour?.versementDemandeLe;
    if (deja && deja.getTime() > maintenant() - 86400000) throw new HttpError(409, 'Tranche déjà demandée : tu pourras relancer demain.');
    if (estObjectif(t)) await d.db.tontine.update({ where: { id: t.id }, data: { trancheDemandeLe: new Date(maintenant()) } });
    else await d.db.tontineTour.update({ where: { id: tour!.id }, data: { versementDemandeLe: new Date(maintenant()), versementDemandes: (tour!.versementDemandes ?? 0) + 1 } });
    const b = tour ? t.membres.find((m) => m.id === tour.beneficiaireId) : null;
    const pour = estObjectif(t) ? (beneficiaireDe(t)?.nom ?? 'le bénéficiaire') : b ? contactDe(b).nom : 'le bénéficiaire';
    const qui = prenomDe(t.organisateur?.nom ?? '') || 'L’initiateur';
    for (const admin of (await d.responsablesVersements?.()) ?? [])
      await d.avertir(admin, null, { cle: `tontine:tranche-demande:${v.cle}:${maintenant()}`, titre: `Tranche demandée : ${montantCotisation(v.disponible, t.devise)}`, corps: `${qui} demande de verser à ${pour} ce qui est déjà arrivé dans « ${t.nom} ». À verser dans Utilisateurs › Cotisations.`, url: '/utilisateurs?page=cotisations' }, true).catch((e) => console.error('Avis de tontine', e));
    return relire(t.id, userId);
  }

  /** Ce que voit la personne invitée à reprendre une place. */
  function carteRemplacement(t: TontineComplete, c: Changement, mvts: Mouvement[]) {
    const m = t.membres.find((x) => x.id === c.membreId);
    const tour = m ? t.tours.find((x) => x.beneficiaireId === m.id) : undefined;
    return {
      changementId: c.id,
      etat: c.etat,
      place: m ? prenomDe(contactDe(m).nom) : '',
      tour: tour ? { numero: tour.numero, echeance: tour.echeance } : null,
      payees: m ? mvts.filter((x) => x.membreId === m.id && x.genre === 'cotisation' && x.statut === 'paye').length : 0,
      caution: m ? m.cautionStatut === 'payee' : false,
      accepte: c.accordAutre,
      attenteInitiateur: !c.accordInitiateur,
      attenteMembre: !c.accordMembre,
    };
  }

  const relire = async (id: string, userId: string) => {
    const t = await charger(id);
    return { groupe: vue(t, userId, await mouvementsDe(id), await plateforme()) };
  };

  const prevenirTous = (t: TontineComplete, cle: string, avis: Omit<AvisGroupe, 'cle'>, sauf?: string) =>
    Promise.all(acceptes(t).filter((m) => m.userId && m.id !== sauf).map((m) => d.avertir(m.userId!, contactDe(m).telephone, { cle: `${cle}:${m.id}`, ...avis }).catch((e) => console.error('Avis de tontine', e))));
  /** L'initiateur et ses adjoints. */
  const prevenirOrganisateur = (t: TontineComplete, cle: string, avis: Omit<AvisGroupe, 'cle'>, seulementApp = true) =>
    Promise.all(
      [...new Set([t.organisateurId, ...adjointsDe(t).map((m) => m.userId)].filter((x): x is string => !!x))].map((id) =>
        d.avertir(id, null, { cle: id === t.organisateurId ? cle : `${cle}:${id}`, ...avis }, seulementApp).catch((e) => console.error('Avis de tontine', e)),
      ),
    );

  /** Tous ont cotisé : le versement attend la validation de l'admin. */
  async function fermerCollecte(tontineId: string, tourId: string) {
    const t = await charger(tontineId);
    const tour = t.tours.find((x) => x.id === tourId);
    if (!tour || tour.etat !== 'collecte') return;
    const mvts = await mouvementsDe(tontineId);
    if (!acceptes(t).every((m) => aCotise(mvts, m.id, tourId))) return;
    // La cagnotte réelle : pénalités comprises ; la part en espèces est remise par l'organisateur, Me ne verse que le reste.
    const payes = mvts.filter((x) => x.tourId === tourId && x.statut === 'paye' && (x.genre === 'cotisation' || x.genre === 'caution_utilisee'));
    const especes = payes.filter((x) => x.mode === 'especes').reduce((n, x) => n + x.montant, 0);
    const part = repartitionCagnotte(payes.filter((x) => x.mode !== 'especes').reduce((n, x) => n + x.montant, 0), 1, t.commissionBps);
    const fait = await d.db.tontineTour.updateMany({ where: { id: tourId, etat: 'collecte' }, data: { etat: 'a_verser', ...part, especes } });
    if (!fait.count) return;
    const b = t.membres.find((m) => m.id === tour.beneficiaireId);
    // Des tranches sont déjà parties : il ne reste que la différence (ou rien).
    const dejaVerse = verseSur(mvts, (x) => x.tourId === tourId);
    if (dejaVerse && dejaVerse >= part.net && part.net) {
      if (verseSur(mvts, (x) => x.tourId === tourId, ['paye']) >= part.net) await apresVersement(tourId);
      return;
    }
    const enEspeces = especes ? ` ${montantCotisation(especes, t.devise)} en espèces te seront remis par l’organisateur.` : '';
    // Tout en espèces : rien à verser par Me.
    if (!part.net) {
      if (b?.userId) await d.avertir(b.userId, contactDe(b).telephone, { cle: `tontine:complet:${tourId}`, titre: 'Ta cagnotte est complète', corps: `« ${t.nom} » :${enEspeces}` }).catch((e) => console.error('Avis de tontine', e));
      await apresVersement(tourId);
      return;
    }
    if (b?.userId) await d.avertir(b.userId, contactDe(b).telephone, { cle: `tontine:complet:${tourId}`, titre: 'Ta cagnotte est complète', corps: `${montantCotisation(part.net, t.devise)} réunis dans « ${t.nom} », en cours de validation. Tu seras prévenu au versement.${enEspeces}` }).catch((e) => console.error('Avis de tontine', e));
    await prevenirEquipe(`tontine:a-verser:${tourId}`, `À verser : ${montantCotisation(part.net - dejaVerse, t.devise)}`, `« ${t.nom} », tour ${tour.numero} : la cagnotte de ${b ? contactDe(b).nom : 'ce tour'} est complète${dejaVerse ? `, ${montantCotisation(dejaVerse, t.devise)} déjà versés en tranches` : ''}.`);
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
        const payes = (await mouvementsDe(t.id)).filter((x) => x.genre === 'cotisation' && x.statut === 'paye');
        const total = payes.filter((x) => x.mode !== 'especes').reduce((n, x) => n + x.montant, 0);
        await d.db.tontineTour.update({ where: { id: final.id }, data: { ...repartitionCagnotte(total, 1, t.commissionBps), especes: payes.filter((x) => x.mode === 'especes').reduce((n, x) => n + x.montant, 0) } });
      } else if (final) console.error(`Tontine ${t.id} : paiement ${m.reference} reçu après le versement final`);
    }
  }

  /** Raison précise : ouvre les périodes échues puis, après la date de fin, prépare le versement au bénéficiaire. */
  async function avancerObjectif(id: string, forcer = false) {
    const t = await charger(id);
    if (!estObjectif(t) || t.etat !== 'en_cours' || !t.dateFin) return;
    const jour = jourDe(t);
    const tours = toursCollecte(t);
    for (const [i, x] of tours.entries()) {
      if (x.etat === 'a_venir' && i > 0 && tours[i - 1].echeance < jour) await d.db.tontineTour.updateMany({ where: { id: x.id, etat: 'a_venir' }, data: { etat: 'collecte' } });
    }
    if ((jour <= t.dateFin && !forcer) || tourFinal(t)) return;
    const mvts = await mouvementsDe(id);
    // On attend la réponse des demandes en cours : elles comptent dans la cagnotte.
    if (mvts.some((x) => x.statut === 'en_attente' && ENTREES.includes(x.genre))) {
      if (forcer) throw new HttpError(409, 'Un paiement est en cours : attends sa réponse avant de clôturer.');
      return;
    }
    await d.db.tontineTour.updateMany({ where: { tontineId: id, etat: { in: ['a_venir', 'collecte'] } }, data: { etat: 'clos' } });
    const payes = mvts.filter((x) => x.genre === 'cotisation' && x.statut === 'paye');
    const total = payes.filter((x) => x.mode !== 'especes').reduce((n, x) => n + x.montant, 0);
    const especes = payes.filter((x) => x.mode === 'especes').reduce((n, x) => n + x.montant, 0);
    if (!total) {
      await d.db.tontine.update({ where: { id }, data: { etat: 'termine' } });
      return;
    }
    const part = repartitionCagnotte(total, 1, t.commissionBps);
    try {
      await d.db.tontineTour.create({ data: { tontineId: id, numero: 0, echeance: t.dateFin, etat: 'a_verser', ...part, especes } });
      const dejaVerse = verseSur(mvts, () => true);
      await prevenirEquipe(`tontine:a-verser:${id}:final`, `À verser : ${montantCotisation(Math.max(0, part.net - dejaVerse), t.devise)}`, `« ${t.nom} » est clôturée : ${montantCotisation(part.net, t.devise)} pour ${beneficiaireDe(t)?.nom ?? 'le bénéficiaire'}${dejaVerse ? `, dont ${montantCotisation(dejaVerse, t.devise)} déjà versés en tranches` : ''}.`);
      // Tout est déjà parti en tranches : la cotisation est terminée.
      if (dejaVerse >= part.net && verseSur(mvts, () => true, ['paye']) >= part.net) {
        const final = await d.db.tontineTour.findFirst({ where: { tontineId: id, numero: 0 } });
        if (final) await apresVersement(final.id);
        return;
      }
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
    if (b?.userId && tour.net) await d.avertir(b.userId, contactDe(b).telephone, { cle: `tontine:verse:${tourId}`, titre: 'Ta cagnotte est versée', corps: `${montantCotisation(tour.net, t.devise)} du groupe « ${t.nom} » t’ont été versés.${tour.especes ? ` Le reste, ${montantCotisation(tour.especes, t.devise)}, t’est remis en espèces par l’organisateur.` : ''}` }).catch((e) => console.error('Avis de tontine', e));
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

  /** Une tranche ou le solde est parti : le tour est versé quand tout l'est, sinon le bénéficiaire est prévenu de la tranche. */
  async function apresSortie(m: Mouvement) {
    if (m.genre === 'versement' && m.tontineId) {
      const t = await charger(m.tontineId);
      const mvts = await mouvementsDe(t.id);
      const tour = estObjectif(t) ? tourFinal(t) : t.tours.find((x) => x.id === m.tourId);
      const v = etatVersement(t, mvts, tour);
      if (tour?.etat === 'a_verser' && v && v.paye >= tour.net) await apresVersement(tour.id);
      else if (v) {
        const b = estObjectif(t) ? null : t.membres.find((x) => x.id === tour?.beneficiaireId);
        if (b?.userId) await d.avertir(b.userId, contactDe(b).telephone, { cle: `tontine:tranche:${m.id}`, titre: `Tranche reçue : ${montantCotisation(m.montant, t.devise)}`, corps: `« ${t.nom} » : ${montantCotisation(v.paye, t.devise)} versés jusqu’ici. Le reste suit quand l’argent arrive.` }).catch((e) => console.error('Avis de tontine', e));
        await prevenirOrganisateur(t, `tontine:tranche-orga:${m.id}`, { titre: `Tranche versée : ${montantCotisation(m.montant, t.devise)}`, corps: `« ${t.nom} » : ${montantCotisation(v.paye, t.devise)} versés à ${estObjectif(t) ? (beneficiaireDe(t)?.nom ?? 'le bénéficiaire') : b ? prenomDe(contactDe(b).nom) : 'le bénéficiaire'}.` });
      }
    }
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

  /** Prévient l'équipe qui verse (admins, commerciaux du module « versements ») ; la notification ouvre l'écran des versements. */
  async function prevenirEquipe(cle: string, titre: string, corps: string) {
    for (const admin of (await d.responsablesVersements?.()) ?? [])
      await d.avertir(admin, null, { cle, titre, corps: `${corps} À verser dans Utilisateurs › Cotisations.`, url: '/utilisateurs?page=cotisations' }, true).catch((e) => console.error('Avis de tontine', e));
  }

  /** La demande de paiement qu'un initiateur envoie au numéro d'un membre. */
  async function demanderA(t: TontineComplete, membreId: string): Promise<'envoyee' | 'rien' | 'en_cours' | 'limite'> {
    if (!ouvertPour(t)) throw new HttpError(503, 'Le paiement n’est pas encore ouvert.');
    if (!d.adresseServeur().startsWith('https://')) throw new HttpError(503, 'Le paiement est momentanément indisponible.');
    const m = t.membres.find((x) => x.id === membreId);
    if (!m || m.etat !== 'accepte') throw new HttpError(404, 'Ce membre n’est pas dans le groupe.');
    let mvts = await mouvementsDe(t.id);
    const siens = () => mvts.filter((x) => x.membreId === m.id);
    if (siens().some((x) => x.statut === 'en_attente' && ENTREES.includes(x.genre))) return 'en_cours';
    if (siens().filter((x) => x.mode === 'mobile' && x.createdAt.getTime() > maintenant() - 86400000).length >= DEMANDES_PAR_JOUR) return 'limite';
    // Une demande abandonnée a pu être validée entre-temps : ne pas faire payer deux fois.
    for (const a of siens().filter((x) => x.mode === 'mobile' && ENTREES.includes(x.genre) && REVERIFIABLES.includes(x.statut)).slice(-3)) await verifier(a);
    mvts = await mouvementsDe(t.id);
    const frais = await charger(t.id);
    const du = aPayer(frais, frais.membres.find((x) => x.id === m.id)!, mvts);
    if (!du) return 'rien';
    const { telephone } = contactDe(m);
    if (!telephone) throw new HttpError(409, 'Ce membre n’a pas de numéro.');
    await d.exigerNumero(telephone);
    await lancerDemande(t, m.id, telephone, du);
    if (m.userId)
      await d
        .avertir(m.userId, null, { cle: `tontine:demande-paiement:${m.id}:${maintenant()}`, titre: `${du.genre === 'caution' ? 'Caution' : 'Cotisation'} à valider : ${montantCotisation(du.montant, t.devise)}`, corps: `${prenomDe(t.organisateur?.nom ?? '') || 'L’organisateur'} t’envoie la demande de paiement de « ${t.nom} ». Valide-la sur ton téléphone avec ton code mobile money.` }, true)
        .catch((e) => console.error('Avis de tontine', e));
    return 'envoyee';
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
    // Les groupes en cours où de l'argent est déjà arrivé : une tranche peut partir sans attendre la cagnotte complète.
    const enCours = await d.db.tontine.findMany({ where: { etat: 'en_cours' }, include: INCLUS });
    const mvtsDe = new Map<string, Mouvement[]>();
    for (const t of [...enCours, ...groupes.values()]) if (!mvtsDe.has(t.id)) mvtsDe.set(t.id, await mouvementsDe(t.id));
    const ligneVersement = (t: TontineComplete, x: TontineComplete['tours'][number] | null) => {
      const b = x ? t.membres.find((m) => m.id === x.beneficiaireId) : null;
      const contact = estObjectif(t) ? beneficiaireDe(t) : b ? contactDe(b) : null;
      const v = estObjectif(t) ? etatVersement(t, mvtsDe.get(t.id)!) : etatVersement(t, mvtsDe.get(t.id)!, x);
      const demandeLe = estObjectif(t) && !x ? (t.trancheDemandeLe ?? null) : (x?.versementDemandeLe ?? null);
      return { cle: v?.cle ?? `t:${x?.id}`, tourId: x?.id ?? null, complet: x?.etat === 'a_verser', raison: t.raison, groupe: t.nom, numero: x?.numero ?? 0, places: t.places, beneficiaire: contact?.nom ?? '', telephone: contact?.telephone ?? '', brut: x?.brut ?? 0, commission: x?.commission ?? 0, net: v?.net ?? x?.net ?? 0, especes: x?.especes ?? 0, devise: t.devise, demandeLe, demandes: x?.versementDemandes ?? 0, dejaVerse: v?.paye ?? 0, disponible: v?.disponible ?? 0, enCours: v?.enCours ?? false };
    };
    const complets = tours.map((x) => ligneVersement(groupes.get(x.tontineId)!, x));
    const tranches = enCours
      .map((t) => {
        if (estObjectif(t)) return tourFinal(t) ? null : ligneVersement(t, null);
        const x = tourActuel(t);
        return x?.etat === 'collecte' ? ligneVersement(t, x) : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x && x.disponible > 0);
    // Les versements demandés par l'initiateur d'abord, le plus ancien en tête ; les cagnottes complètes avant les tranches.
    const ordre = (a: { demandeLe: Date | null; complet: boolean }, b: { demandeLe: Date | null; complet: boolean }) => Number(!a.demandeLe) - Number(!b.demandeLe) || Number(!a.complet) - Number(!b.complet) || (a.demandeLe?.getTime() ?? 0) - (b.demandeLe?.getTime() ?? 0);
    return {
      versementApi: d.versementApi(),
      totaux: [...parDevise].map(([devise, v]) => ({ devise, ...v })),
      versements: [...complets, ...tranches].sort(ordre),
      cautions: cautions.map((m) => {
        const t = groupes.get(m.tontineId)!;
        const contact = contactDe(m);
        return { membreId: m.id, groupe: t.nom, nom: contact.nom, telephone: contact.telephone, montant: t.montant, devise: t.devise };
      }),
    };
  }

  /**
   * Validation de l'admin : seul ce geste fait sortir l'argent. `montant` : une tranche de ce qui est déjà arrivé (net de
   * la commission) ; sans montant, tout ce qui est disponible. `cle` : « t:<tour> » pour une rotation, « g:<groupe> » pour
   * une raison précise (un identifiant de tour seul reste accepté).
   */
  async function verserCle(acteur: Acteur, cle: string, preuve?: string, montant?: number) {
    const [genre, id] = cle.startsWith('g:') || cle.startsWith('t:') ? [cle.slice(0, 1), cle.slice(2)] : ['t', cle];
    let t: TontineComplete;
    let tour: TontineComplete['tours'][number] | null = null;
    if (genre === 'g') {
      t = await charger(id);
      if (!estObjectif(t)) throw new HttpError(400, 'Ce groupe verse tour par tour.');
      tour = tourFinal(t);
    } else {
      const x = await d.db.tontineTour.findUnique({ where: { id } });
      if (!x) throw new HttpError(404, 'Tour introuvable.');
      t = await charger(x.tontineId);
      tour = t.tours.find((y) => y.id === id) ?? null;
      if (estObjectif(t)) tour = tourFinal(t);
    }
    if (estObjectif(t) ? t.etat !== 'en_cours' || (tour && tour.etat !== 'a_verser') : !tour || (tour.etat !== 'a_verser' && tour.etat !== 'collecte')) throw new HttpError(409, 'Rien n’attend de versement ici.');
    const mvts = await mouvementsDe(t.id);
    const v = etatVersement(t, mvts, tour)!;
    if (v.enCours) throw new HttpError(409, 'Un versement est déjà en cours : attends sa réponse.');
    const somme = montant ?? v.disponible;
    if (!v.disponible) throw new HttpError(409, 'Rien de disponible pour l’instant : l’argent n’est pas encore arrivé.');
    if (!Number.isInteger(somme) || somme < 1 || somme > v.disponible) throw new HttpError(400, `Disponible : ${montantCotisation(v.disponible, t.devise)} au plus.`);
    const b = estObjectif(t) ? null : t.membres.find((m) => m.id === tour!.beneficiaireId);
    const telephone = estObjectif(t) ? (beneficiaireDe(t)?.telephone ?? '') : b ? contactDe(b).telephone : '';
    if (!telephone) throw new HttpError(409, 'Le bénéficiaire n’a plus de numéro.');
    // Pas de validation pour soi-même : ni sa propre cagnotte, ni celle d'un groupe qu'on organise pour une raison précise.
    if (!acteur.admin && (b?.userId === acteur.id || (estObjectif(t) && t.organisateurId === acteur.id))) throw new HttpError(403, AUTRE_RESPONSABLE);
    if (tour) await d.db.tontineTour.update({ where: { id: tour.id }, data: { valideParNom: acteur.nom, valideLe: new Date(maintenant()) } });
    await sortie({ acteur: acteur.nom, genre: 'versement', tontineId: t.id, membreId: b?.id ?? null, tourId: tour?.id ?? null, montant: somme, devise: t.devise, telephone, preuve });
    // La demande de tranche est servie.
    if (!v.complet) {
      if (estObjectif(t)) await d.db.tontine.update({ where: { id: t.id }, data: { trancheDemandeLe: null } });
      else if (tour) await d.db.tontineTour.update({ where: { id: tour.id }, data: { versementDemandeLe: null } });
    }
    return resumeAdmin();
  }

  return {
    /** Les groupes qui cherchent des membres. */
    limites: async () => ({ ...(await d.limites()), plateforme: await plateforme() }),

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
      const cadre = await plateforme();
      const groupes = await Promise.all(liens.map(async (l) => vue(await charger(l.tontineId), userId, await mouvementsDe(l.tontineId), cadre)));
      return { groupes: groupes.sort((a, b) => a.nom.localeCompare(b.nom)), versementApi: d.versementApi(), niveau: await niveauDe(userId) };
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
      // Les limites de la plateforme pour cette sorte de groupe, ce rythme, cette devise, puis celles du niveau du compte.
      const hors = horsLimites(await plateforme(), { ...c, jour: local(new Date(maintenant()), u.fuseau).date });
      if (hors) throw new HttpError(400, hors);
      await exigerNiveau(u.id, c);
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
      const cadre = (await plateforme())[c.visibilite];
      const cautionRequise = objectif ? false : publique || cadre.cautionObligatoire ? true : c.cautionRequise !== false;
      const t = await d.db.tontine.create({
        data: {
          organisateurId: u.id, nom: c.nom, description: c.description || null, montant: c.montant, devise: c.devise, rythme: c.rythme, places: c.places, commissionBps: cadre.commissionBps, fuseau: u.fuseau,
          mode: c.mode, visibilite: c.visibilite, cautionRequise, codeInvitation: publique ? null : randomBytes(9).toString('base64url'),
          raison: objectif ? (c.raison ?? null) : null, dateFin: objectif ? c.dateFin : null, ...(beneficiaire ? { beneficiaire: enCoffre(beneficiaire) } : {}),
          etat: objectif ? 'en_cours' : 'ouvert', tourCourant: objectif ? 1 : 0,
          rappels: rappelsDe(c.rappels),
          regles: reglesDansLeCadre(reglesDe(c.regles, { visibilite: c.visibilite, montant: c.montant, rythme: c.rythme, mode: c.mode }), cadre, c.montant),
        },
      });
      await d.db.tontineMembre.create({ data: { tontineId: t.id, userId: u.id, etat: 'accepte', cautionStatut: cautionRequise ? 'due' : 'dispense', contact: enCoffre({ nom: u.nom, telephone }), conditionsVersion: VERSION_CONDITIONS_TONTINE } });
      for (const [i, echeance] of dates.entries()) await d.db.tontineTour.create({ data: { tontineId: t.id, numero: i + 1, echeance, etat: i === 0 ? 'collecte' : 'a_venir', brut: 0, commission: 0, net: 0 } });
      if (publique) void charger(t.id).then(alerterAnnuaire).catch((e) => console.error('Alerte annuaire', e));
      return relire(t.id, u.id);
    },

    /** Ce qu'une personne invitée voit avant de rejoindre, même sans compte. */
    async invitation(code: string, userId?: string) {
      const reprise = await d.db.tontineChangement.findUnique({ where: { code } });
      if (reprise) {
        const t = await charger(reprise.tontineId);
        if (reprise.etat !== 'en_attente' && reprise.nouveauUserId !== userId) throw new HttpError(404, 'Cette invitation n’est plus valable.');
        return { groupe: carte(t, userId ?? ''), remplacement: carteRemplacement(t, reprise, await mouvementsDe(t.id)) };
      }
      const t = await d.db.tontine.findUnique({ where: { codeInvitation: code }, include: INCLUS });
      if (!t || !accueille(t)) throw new HttpError(404, 'Cette invitation n’est plus valable.');
      return { groupe: carte(t, userId ?? '') };
    },

    /** Le lien vient de l'initiateur, responsable de son groupe : pas d'approbation de Me, et entrée directe. */
    async rejoindreParInvitation(u: Compte, code: string, brut: string) {
      const reprise = await d.db.tontineChangement.findUnique({ where: { code } });
      if (reprise) return reprendrePlace(u, reprise, brut);
      const t = await d.db.tontine.findUnique({ where: { codeInvitation: code }, include: INCLUS });
      if (!t || !accueille(t)) throw new HttpError(404, 'Cette invitation n’est plus valable.');
      if (acceptes(t).length >= t.places) throw new HttpError(409, 'Ce groupe est complet.');
      const deja = t.membres.find((m) => m.userId === u.id);
      if (deja?.etat === 'accepte') return relire(t.id, u.id);
      if (deja?.etat === 'refuse') throw new HttpError(409, 'L’initiateur t’a retiré de ce groupe.');
      if (deja?.cautionStatut === 'a_rendre') throw new HttpError(409, 'Ta caution est en cours de remboursement.');
      await exigerNiveau(u.id, { visibilite: t.visibilite as 'public' | 'prive', rythme: t.rythme as RythmeObjectif, devise: t.devise, montant: t.montant });
      if (deja?.etat === 'exclu') throw new HttpError(409, 'Tu as été exclu de ce groupe.');
      const telephone = normaliserTelephone(brut);
      if (!telephone) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
      await d.exigerNumero(telephone);
      await exigerEntree(t, u.id);
      const donnees = { contact: enCoffre({ nom: u.nom, telephone }), etat: 'accepte', cautionStatut: t.cautionRequise ? 'due' : 'dispense', conditionsVersion: VERSION_CONDITIONS_TONTINE };
      if (deja) await d.db.tontineMembre.update({ where: { id: deja.id }, data: donnees });
      else await d.db.tontineMembre.create({ data: { tontineId: t.id, userId: u.id, ...donnees } });
      // L'invitation envoyée à ce numéro (ou à celui du compte) est rejointe.
      const empreintes = [...new Set([telephone, u.telephone].filter((x): x is string => !!x))].map((x) => empreinteInvitation(t.id, x));
      await d.db.tontineInvitation.updateMany({ where: { tontineId: t.id, empreinte: { in: empreintes }, rejointLe: null }, data: { rejointLe: new Date(maintenant()) } });
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
      // La trace de l'envoi, pour l'organisateur : le numéro masqué, et son empreinte pour savoir s'il a rejoint.
      const empreinte = empreinteInvitation(t.id, telephone);
      const deja = await d.db.tontineInvitation.findFirst({ where: { tontineId: t.id, empreinte } });
      const membre = t.membres.some((m) => m.etat === 'accepte' && contactDe(m).telephone === telephone);
      if (deja) await d.db.tontineInvitation.update({ where: { id: deja.id }, data: { envois: deja.envois + 1, envoyeLe: new Date(maintenant()), mail: deja.mail || envoi.mail, sms: deja.sms || envoi.sms } });
      else await d.db.tontineInvitation.create({ data: { tontineId: t.id, empreinte, numero: numeroMasque(telephone), envois: 1, mail: envoi.mail, sms: envoi.sms, envoyeLe: new Date(maintenant()), rejointLe: membre ? new Date(maintenant()) : null } });
      return { ...envoi, ...(await relire(t.id, userId)) };
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
      if (deja?.etat === 'exclu') throw new HttpError(409, 'Tu as été exclu de ce groupe.');
      if (deja?.cautionStatut === 'a_rendre') throw new HttpError(409, 'Ta caution est en cours de remboursement.');
      await exigerNiveau(u.id, { visibilite: 'public', rythme: t.rythme as RythmeObjectif, devise: t.devise, montant: t.montant });
      const telephone = u.telephone;
      if (!telephone) throw new HttpError(403, 'Confirme ton numéro par SMS d’abord.', COMPTE_A_APPROUVER);
      await d.exigerNumero(telephone);
      await exigerEntree(t, u.id);
      const auto = reglesDuGroupe(t).entree.automatique;
      const donnees = { contact: enCoffre({ nom: u.nom, telephone }), etat: auto ? 'accepte' : 'demande', cautionStatut: t.cautionRequise ? 'due' : 'dispense', conditionsVersion: VERSION_CONDITIONS_TONTINE };
      if (deja) await d.db.tontineMembre.update({ where: { id: deja.id }, data: donnees });
      else await d.db.tontineMembre.create({ data: { tontineId: id, userId: u.id, ...donnees } });
      await prevenirOrganisateur(t, `tontine:demande:${id}:${u.id}`, auto ? { titre: 'Nouveau membre', corps: `${prenomDe(u.nom)} a rejoint « ${t.nom} » (entrée d’office).` } : { titre: 'Nouvelle demande', corps: `${prenomDe(u.nom)} veut rejoindre « ${t.nom} ».` });
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
      if (estInitiateur(t, userId)) throw new HttpError(409, 'Annule le groupe plutôt que de le quitter.');
      if ((await mouvementsDe(id)).some((x) => x.membreId === moi.id && x.statut === 'en_attente')) throw new HttpError(409, 'Un paiement est en cours.');
      await d.db.tontineMembre.update({ where: { id: moi.id }, data: { etat: 'parti', cautionStatut: moi.cautionStatut === 'payee' ? 'a_rendre' : moi.cautionStatut } });
      return relire(id, userId);
    },

    async annuler(userId: string, id: string) {
      const t = await charger(id);
      exigerInitiateur(t, userId);
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
      // L'ordre choisi par l'organisateur doit couvrir tout le monde, une place chacun.
      if (reglesDuGroupe(t).ordre === 'organisateur' && new Set(liste.map((m) => m.rang).filter((x): x is number => !!x && x >= 1 && x <= liste.length)).size !== liste.length)
        throw new HttpError(409, 'Choisis l’ordre des tours avant de démarrer.');
      const fait = await d.db.tontine.updateMany({ where: { id, etat: 'ouvert' }, data: { etat: 'en_cours', tourCourant: 1 } });
      if (!fait.count) return relire(id, userId);
      const regle = reglesDuGroupe(t).ordre;
      const tirer = d.tirer ?? ((max: number) => randomInt(max));
      const ordre = [...liste];
      if (regle === 'organisateur') ordre.sort((a, b) => (a.rang ?? 0) - (b.rang ?? 0));
      else if (regle === 'tirage')
        for (let i = ordre.length - 1; i > 0; i--) {
          const j = tirer(i + 1);
          [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
        }
      // « arrivee » : les membres sont déjà dans l'ordre où ils sont entrés.
      const part = repartitionCagnotte(t.montant, t.places, t.commissionBps);
      const dates = echeancesAuJour(t.rythme as RythmeTontine, jourDe(t), t.places, reglesDuGroupe(t).echeance.jour);
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
      // Règle de la plateforme : seul l'initiateur lance les demandes (il peut toujours payer pour lui-même).
      if (!estOrganisateur(t, userId) && (await demandesParInitiateur(t))) throw new HttpError(403, `${prenomDe(t.organisateur?.nom ?? '') || 'L’initiateur'} t’enverra la demande de paiement : tu la valideras sur ton téléphone.`, 'DEMANDE_PAR_INITIATEUR');
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

    /**
     * L'initiateur déclenche la demande de paiement sur le téléphone d'un membre : la même demande que si le membre
     * appuyait sur « Payer » (cotisation, pénalité comprise, ou caution). Le membre valide avec son code mobile money.
     */
    async demanderPaiement(userId: string, membreId: string) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      await avancerObjectif(m.tontineId);
      const t = await charger(m.tontineId);
      exigerOrganisateur(t, userId);
      const envoi = await demanderA(t, membreId);
      if (envoi === 'rien') throw new HttpError(409, 'Ce membre n’a rien à payer.');
      if (envoi === 'en_cours') throw new HttpError(409, 'Une demande est déjà en cours pour ce membre.');
      if (envoi === 'limite') throw new HttpError(429, 'Trop de demandes aujourd’hui pour ce membre. Réessaie demain.');
      return relire(t.id, userId);
    },

    /** L'initiateur demande le paiement à tous ceux qui doivent encore payer (sauf lui-même), en une fois. */
    async demanderATous(userId: string, id: string) {
      await avancerObjectif(id);
      const t = await charger(id);
      exigerOrganisateur(t, userId);
      const bilan = { envoyees: 0, enCours: 0, limite: 0 };
      for (const m of acceptes(t)) {
        if (m.userId === userId) continue;
        const r = await demanderA(t, m.id).catch(() => 'erreur' as const);
        if (r === 'envoyee') bilan.envoyees++;
        else if (r === 'en_cours') bilan.enCours++;
        else if (r === 'limite') bilan.limite++;
      }
      if (!bilan.envoyees && !bilan.enCours) throw new HttpError(409, bilan.limite ? 'Trop de demandes aujourd’hui. Réessaie demain.' : 'Personne n’a de paiement à faire.');
      return { ...bilan, ...(await relire(id, userId)) };
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
      if (m.userId === t.organisateurId) throw new HttpError(403, 'L’initiateur reste dans le groupe.');
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

    /** L'organisateur règle son groupe avant le démarrage (pour une raison précise : avant le premier paiement). Les membres sont prévenus. */
    async reglerRegles(userId: string, id: string, brut: ReglesPartielles) {
      const t = await charger(id);
      exigerOrganisateur(t, userId);
      const mvts = await mouvementsDe(id);
      const ouvert = estObjectif(t) ? !mvts.some((x) => x.genre === 'cotisation' && x.statut === 'paye') : t.etat === 'ouvert';
      if (!ouvert) throw new HttpError(409, 'Le groupe a démarré : ses règles ne changent plus.');
      const regles = reglesDansLeCadre(reglesDe(brut, { visibilite: t.visibilite as 'public' | 'prive', montant: t.montant, rythme: t.rythme, mode: t.mode }), (await plateforme())[t.visibilite as 'public' | 'prive'], t.montant);
      if (JSON.stringify(regles) === JSON.stringify(reglesDuGroupe(t))) return relire(id, userId);
      await d.db.tontine.update({ where: { id }, data: { regles } });
      await prevenirTous(t, `tontine:regles:${id}:${maintenant()}`, { titre: 'Règles du groupe modifiées', corps: `« ${t.nom} » : ${texteRegles(regles, t.devise, t.rythme).join(' ')}` }, t.membres.find((m) => m.userId === userId)?.id);
      return relire(id, userId);
    },

    /** L'organisateur range les membres dans l'ordre où ils recevront la cagnotte (règle « choisi par l'organisateur »). */
    async ordonner(userId: string, id: string, ids: string[]) {
      const t = await charger(id);
      exigerOrganisateur(t, userId);
      if (estObjectif(t) || t.etat !== 'ouvert') throw new HttpError(409, 'L’ordre se choisit avant le démarrage.');
      if (reglesDuGroupe(t).ordre !== 'organisateur') throw new HttpError(409, 'Ce groupe tire l’ordre au sort.');
      const liste = acceptes(t);
      if (ids.length !== liste.length || new Set(ids).size !== ids.length || !ids.every((x) => liste.some((m) => m.id === x))) throw new HttpError(400, 'Range chaque membre une fois.');
      for (const [i, mid] of ids.entries()) await d.db.tontineMembre.update({ where: { id: mid }, data: { rang: i + 1 } });
      return relire(id, userId);
    },

    /** Groupe privé qui l'accepte : l'organisateur note une cotisation reçue en espèces. Le membre est prévenu. */
    async noterEspeces(userId: string, membreId: string) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      const t = await charger(m.tontineId);
      exigerOrganisateur(t, userId);
      if (!reglesDuGroupe(t).especes) throw new HttpError(409, 'Ce groupe n’accepte pas les espèces : active-le dans ses règles.');
      await avancerObjectif(t.id);
      const frais = await charger(t.id);
      const membre = frais.membres.find((x) => x.id === membreId)!;
      const mvts = await mouvementsDe(t.id);
      if (mvts.some((x) => x.membreId === membreId && x.statut === 'en_attente' && ENTREES.includes(x.genre))) throw new HttpError(409, 'Un paiement mobile est en cours pour ce membre.');
      const du = aPayer(frais, membre, mvts);
      if (du?.genre !== 'cotisation') throw new HttpError(409, 'Ce membre n’a pas de cotisation à payer.');
      const qui = prenomDe(t.organisateur?.nom ?? '');
      let mv: Mouvement;
      try {
        mv = await d.db.tontineMouvement.create({ data: { reference: reference(), tontineId: t.id, membreId, tourId: du.tourId, genre: 'cotisation', montant: du.montant, devise: t.devise, mode: 'especes', statut: 'paye', message: `Espèces notées par ${qui || 'l’organisateur'}`, validePar: qui || null, payeLe: new Date(maintenant()) } });
      } catch (e) {
        if (estDoublon(e)) return relire(t.id, userId);
        throw e;
      }
      if (membre.userId && membre.userId !== userId)
        await d.avertir(membre.userId, contactDe(membre).telephone, { cle: `tontine:especes:${mv.id}`, titre: 'Paiement en espèces noté', corps: `${qui || 'L’organisateur'} a noté ${montantCotisation(du.montant, t.devise)} reçus de toi en espèces pour « ${t.nom} ». Si ce n’est pas le cas, réponds-lui vite.` }).catch((e) => console.error('Avis de tontine', e));
      await apresEntree(mv);
      return relire(t.id, userId);
    },

    /** Le seuil de retards est atteint : pour une raison précise, l'organisateur peut retirer le membre (il ne doit plus les périodes suivantes). */
    async exclure(userId: string, membreId: string) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      const t = await charger(m.tontineId);
      exigerOrganisateur(t, userId);
      if (m.userId === userId) throw new HttpError(409, 'Tu ne peux pas t’exclure toi-même.');
      if (m.userId === t.organisateurId) throw new HttpError(403, 'L’initiateur reste dans le groupe.');
      const seuil = reglesDuGroupe(t).exclusion.retards;
      if (!seuil) throw new HttpError(409, 'Ce groupe n’a pas de règle d’exclusion.');
      const membre = t.membres.find((x) => x.id === membreId)!;
      if (membre.etat !== 'accepte') throw new HttpError(409, 'Ce membre n’est plus dans le groupe.');
      const mvts = await mouvementsDe(t.id);
      if (retardsDe(t, membre, mvts) < seuil) throw new HttpError(409, `Il faut ${seuil} retards pour exclure.`);
      // Dans une rotation, chacun reçoit une fois et paie pour les autres : sortir en cours de route ferait perdre de l'argent à quelqu'un.
      if (!estObjectif(t)) throw new HttpError(409, 'Dans une rotation, un membre reste jusqu’au bout : sa caution couvre ses retards.');
      if (mvts.some((x) => x.membreId === membreId && x.statut === 'en_attente')) throw new HttpError(409, 'Un paiement est en cours pour ce membre.');
      await d.db.tontineMembre.update({ where: { id: membreId }, data: { etat: 'exclu' } });
      if (membre.userId) await d.avertir(membre.userId, contactDe(membre).telephone, { cle: `tontine:exclu:${membreId}`, titre: 'Exclu du groupe', corps: `« ${t.nom} » : après ${seuil} retards, l’organisateur t’a retiré du groupe. Ce que tu as payé reste pour le bénéficiaire.` }).catch((e) => console.error('Avis de tontine', e));
      return relire(t.id, userId);
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
      if (!echu(t, tour.echeance)) throw new HttpError(409, 'L’échéance n’est pas encore passée.');
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

    /** L'initiateur nomme un adjoint (deux au plus), ou lui retire ce rôle. Un adjoint a ses droits, sauf nommer et annuler. */
    async adjoint(userId: string, membreId: string, oui: boolean) {
      const m = await d.db.tontineMembre.findUnique({ where: { id: membreId } });
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      const t = await charger(m.tontineId);
      exigerInitiateur(t, userId);
      if (m.userId === userId) throw new HttpError(409, 'Tu es déjà l’initiateur.');
      if (m.etat !== 'accepte') throw new HttpError(409, 'Ce membre n’est plus dans le groupe.');
      if (oui && !estAdjoint(m) && adjointsDe(t).length >= MAX_ADJOINTS) throw new HttpError(409, `${MAX_ADJOINTS} adjoints au plus.`);
      await d.db.tontineMembre.update({ where: { id: m.id }, data: { role: oui ? 'adjoint' : 'membre' } });
      if (m.userId) await d.avertir(m.userId, null, oui ? { cle: `tontine:adjoint:${m.id}:${maintenant()}`, titre: 'Tu es adjoint', corps: `« ${t.nom} » : ${prenomDe(t.organisateur?.nom ?? '') || 'L’initiateur'} te confie la gestion du groupe avec lui.` } : { cle: `tontine:plus-adjoint:${m.id}:${maintenant()}`, titre: 'Tu n’es plus adjoint', corps: `« ${t.nom} » : tu restes membre du groupe.` }, true).catch((e) => console.error('Avis de tontine', e));
      return relire(t.id, userId);
    },

    /**
     * Un membre cède sa place (remplacement) ou propose d'échanger son tour (échange). L'initiateur ou un adjoint peut le
     * proposer pour lui. Rien ne se fait sans l'accord du membre, de l'autre personne et d'un organisateur.
     */
    async proposerChangement(u: Compte, id: string, p: { genre: 'remplacement'; membreId: string; telephone: string } | { genre: 'echange'; membreId: string; avecMembreId: string }) {
      const t = await charger(id);
      const m = t.membres.find((x) => x.id === p.membreId);
      if (!m) throw new HttpError(404, 'Membre introuvable.');
      const orga = estOrganisateur(t, u.id);
      if (m.userId !== u.id && !orga) throw new HttpError(403, 'Tu ne peux proposer un changement que pour ta place.');
      if (p.genre === 'remplacement' && m.userId === t.organisateurId) throw new HttpError(409, 'L’initiateur garde sa place : nomme plutôt un adjoint.');
      await exigerPlaceLibre(t, m);
      const base = { tontineId: t.id, membreId: m.id, demandeParId: u.id, accordMembre: m.userId === u.id, accordInitiateur: orga };
      if (p.genre === 'echange') {
        if (estObjectif(t) || t.etat !== 'en_cours') throw new HttpError(409, 'Les tours s’échangent dans une rotation démarrée. Avant le démarrage, l’initiateur choisit l’ordre.');
        const autre = t.membres.find((x) => x.id === p.avecMembreId);
        if (!autre || autre.id === m.id) throw new HttpError(400, 'Choisis un autre membre.');
        await exigerPlaceLibre(t, autre);
        const a = t.tours.find((x) => x.beneficiaireId === m.id);
        const b = t.tours.find((x) => x.beneficiaireId === autre.id);
        if (a?.etat !== 'a_venir' || b?.etat !== 'a_venir') throw new HttpError(409, 'Seuls les tours à venir s’échangent.');
        const c = await d.db.tontineChangement.create({ data: { ...base, genre: 'echange', avecMembreId: autre.id, accordAutre: autre.userId === u.id } });
        if (autre.userId && autre.userId !== u.id) await d.avertir(autre.userId, null, { cle: `tontine:echange-demande:${c.id}`, titre: 'Échange de tour proposé', corps: `« ${t.nom} » : ${prenomDe(contactDe(m).nom)} propose de recevoir au tour ${b.numero} et toi au tour ${a.numero}. Réponds dans Me.` }, true).catch((e) => console.error('Avis de tontine', e));
        if (m.userId && m.userId !== u.id) {
          await d.avertir(m.userId, null, { cle: `tontine:echange-propose:${c.id}`, titre: 'Échange de tour proposé', corps: `« ${t.nom} » : recevoir au tour ${b.numero} au lieu du tour ${a.numero}. Réponds dans Me.` }, true).catch((e) => console.error('Avis de tontine', e));
        }
        if (!orga) await prevenirOrganisateur(t, `tontine:echange-orga:${c.id}`, { titre: 'Échange de tour à valider', corps: `« ${t.nom} » : ${prenomDe(contactDe(m).nom)} et ${prenomDe(contactDe(autre).nom)} veulent échanger les tours ${a.numero} et ${b.numero}.` });
        await appliquerSiPret(c.id);
        return relire(t.id, u.id);
      }
      const lien = d.adresseApp();
      if (!lien) throw new HttpError(503, 'L’adresse de l’app n’est pas configurée.');
      const telephone = normaliserTelephone(p.telephone);
      if (!telephone) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
      await d.exigerNumero(telephone);
      if (telephone === contactDe(m).telephone) throw new HttpError(400, 'C’est le numéro de ce membre.');
      const code = randomBytes(9).toString('base64url');
      const c = await d.db.tontineChangement.create({ data: { ...base, genre: 'remplacement', code, numero: numeroMasque(telephone) } });
      const qui = prenomDe(contactDe(m).nom);
      const tour = t.tours.find((x) => x.beneficiaireId === m.id);
      const montant = montantTontine(t.montant, t.devise, t.rythme as RythmeObjectif);
      const url = `${lien}/g/${code}`;
      const texte = `${qui} te propose de reprendre sa place dans la cotisation « ${t.nom} » : ${montant}${tour && !estObjectif(t) ? `, tour ${tour.numero} sur ${t.places}` : ''}. Voir et accepter : ${url}`;
      const envoi = await d.envoyerInvitation(u.id, { telephone, titre: `Reprendre une place dans « ${t.nom} »`, texte, sms: tientEnUnSms(texte) ? texte : `${qui} te cède sa place dans « ${t.nom.slice(0, 24)} » : ${url}` });
      if (!envoi.mail && !envoi.sms) {
        await d.db.tontineChangement.update({ where: { id: c.id }, data: { etat: 'annule' } });
        throw new HttpError(503, 'Aucun envoi possible : vérifie la configuration ou la limite du jour.');
      }
      if (m.userId && m.userId !== u.id) await d.avertir(m.userId, null, { cle: `tontine:remplacement-propose:${c.id}`, titre: 'Remplacement proposé', corps: `« ${t.nom} » : l’organisateur propose qu’une autre personne reprenne ta place. Réponds dans Me.` }, true).catch((e) => console.error('Avis de tontine', e));
      if (!orga) await prevenirOrganisateur(t, `tontine:remplacement-orga:${c.id}`, { titre: 'Remplacement à valider', corps: `« ${t.nom} » : ${qui} veut céder sa place au ${numeroMasque(telephone)}.` });
      return { ...envoi, ...(await relire(t.id, u.id)) };
    },

    /** Accord ou refus d'une personne concernée par un changement. Un refus l'arrête. */
    async repondreChangement(userId: string, changementId: string, oui: boolean) {
      const c = await d.db.tontineChangement.findUnique({ where: { id: changementId } });
      if (!c) throw new HttpError(404, 'Changement introuvable.');
      const t = await charger(c.tontineId);
      if (c.etat !== 'en_attente') return relire(t.id, userId);
      const r = rolesChangement(t, c, userId);
      if (!r.membre && !r.autre && !r.initiateur) throw new HttpError(403, 'Ce changement ne te concerne pas.');
      if (!oui) {
        await d.db.tontineChangement.update({ where: { id: c.id }, data: { etat: 'refuse' } });
        const m = t.membres.find((x) => x.id === c.membreId);
        const avertis = new Set([m?.userId, c.demandeParId, c.nouveauUserId].filter((x): x is string => !!x && x !== userId));
        for (const id of avertis) await d.avertir(id, null, { cle: `tontine:changement-refuse:${c.id}:${id}`, titre: c.genre === 'echange' ? 'Échange refusé' : 'Remplacement refusé', corps: `« ${t.nom} » : le changement demandé n’aura pas lieu.` }, true).catch((e) => console.error('Avis de tontine', e));
        return relire(t.id, userId);
      }
      await d.db.tontineChangement.update({ where: { id: c.id }, data: { ...(r.membre ? { accordMembre: true } : {}), ...(r.autre ? { accordAutre: true } : {}), ...(r.initiateur ? { accordInitiateur: true } : {}) } });
      await appliquerSiPret(c.id);
      return relire(t.id, userId);
    },

    /** Celui qui a proposé, ou le membre concerné, retire sa demande. */
    async annulerChangement(userId: string, changementId: string) {
      const c = await d.db.tontineChangement.findUnique({ where: { id: changementId } });
      if (!c) throw new HttpError(404, 'Changement introuvable.');
      const t = await charger(c.tontineId);
      if (c.demandeParId !== userId && !rolesChangement(t, c, userId).membre) throw new HttpError(403, 'Seul celui qui l’a proposé peut l’annuler.');
      await d.db.tontineChangement.updateMany({ where: { id: c.id, etat: 'en_attente' }, data: { etat: 'annule' } });
      return relire(t.id, userId);
    },

    /** Raison précise : l'initiateur clôture avant la date de fin pour demander le versement de ce qui est réuni. */
    async cloturer(userId: string, id: string) {
      const t = await charger(id);
      exigerOrganisateur(t, userId);
      if (!estObjectif(t)) throw new HttpError(409, 'Une rotation se termine quand chacun a reçu.');
      if (t.etat !== 'en_cours' || tourFinal(t)) throw new HttpError(409, 'Cette cotisation est déjà clôturée.');
      await avancerObjectif(id, true);
      return relire(id, userId);
    },

    /**
     * Cagnotte complète : l'initiateur demande à l'équipe de Me de verser au bénéficiaire. Le versement reste validé par
     * l'équipe (seul geste qui fait sortir l'argent). Une relance est possible après un jour.
     */
    async demanderVersement(userId: string, id: string) {
      const t = await charger(id);
      exigerOrganisateur(t, userId);
      const tour = estObjectif(t) ? tourFinal(t) : t.tours.find((x) => x.etat === 'a_verser');
      if (!tour || tour.etat !== 'a_verser') return demanderTranche(t, userId);
      if (tour.versementDemandeLe && tour.versementDemandeLe.getTime() > maintenant() - 86400000) throw new HttpError(409, 'Versement déjà demandé : tu pourras relancer demain.');
      await d.db.tontineTour.update({ where: { id: tour.id }, data: { versementDemandeLe: new Date(maintenant()), versementDemandes: (tour.versementDemandes ?? 0) + 1 } });
      const b = t.membres.find((m) => m.id === tour.beneficiaireId);
      const pour = estObjectif(t) ? (beneficiaireDe(t)?.nom ?? 'le bénéficiaire') : b ? contactDe(b).nom : 'le bénéficiaire';
      const relance = (tour.versementDemandes ?? 0) > 0;
      const qui = prenomDe(t.organisateur?.nom ?? '') || 'L’initiateur';
      for (const admin of (await d.responsablesVersements?.()) ?? [])
        await d
          .avertir(admin, null, { cle: `tontine:versement-demande:${tour.id}:${(tour.versementDemandes ?? 0) + 1}`, titre: `${relance ? 'Relance : versement' : 'Versement'} demandé : ${montantCotisation(tour.net, t.devise)}`, corps: `${qui} demande le versement de « ${t.nom} »${estObjectif(t) ? '' : `, tour ${tour.numero}`} à ${pour}. À verser dans Utilisateurs › Cotisations.`, url: '/utilisateurs?page=cotisations' }, true)
          .catch((e) => console.error('Avis de tontine', e));
      if (b?.userId && b.userId !== userId) await d.avertir(b.userId, null, { cle: `tontine:versement-demande-b:${tour.id}`, titre: 'Ton versement est demandé', corps: `${qui} a demandé à Me de te verser ${montantCotisation(tour.net, t.devise)} de « ${t.nom} ».` }, true).catch((e) => console.error('Avis de tontine', e));
      return relire(id, userId);
    },

    verser: verserCle,
    /** L'ancien chemin : un tour, versé en entier ou par tranche. */
    verserTour: (acteur: Acteur, tourId: string, preuve?: string, montant?: number) => verserCle(acteur, `t:${tourId}`, preuve, montant),

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
        const penalite = retard ? penaliteDue(reglesDuGroupe(t), tour.echeance, jour, heure) : 0;
        const aHeure = texteHeure(reglesDuGroupe(t));
        for (const m of acceptes(t)) {
          if (!m.userId || aCotise(mvts, m.id, tour.id) || (estObjectif(t) && !toursDus(t, m, mvts).some((x) => x.id === tour.id))) continue;
          await d
            .avertir(
              m.userId,
              contactDe(m).telephone,
              {
                cle: `tontine:echeance:${tour.id}:${m.id}:${moment}`,
                titre: retard ? `Cotisation en retard : ${montantCotisation(t.montant + penalite, t.devise)}${penalite ? ' avec la pénalité' : ''}` : moment === 'avant:0' ? `Cotisation à payer aujourd’hui${aHeure ? ` avant ${aHeure.slice(3)}` : ''} : ${montantCotisation(t.montant, t.devise)}` : `Cotisation de ${montantCotisation(t.montant, t.devise)} à payer avant le ${date}${aHeure}`,
                corps: `Groupe « ${t.nom} »${estObjectif(t) ? '' : `, tour ${tour.numero} sur ${t.places}`}. ${retard ? `L’échéance du ${date} est passée : paie dès que possible.` : 'Paie dans Me, onglet Cotisations.'}`,
              },
              { mail: reglage.mail, sms: reglage.sms },
            )
            .catch((e) => console.error('Avis de tontine', e));
        }
        // Seuil d'exclusion atteint : l'organisateur est prévenu une fois par membre.
        const seuil = reglesDuGroupe(t).exclusion.retards;
        if (seuil)
          for (const m of acceptes(t)) {
            if (m.userId && estOrganisateur(t, m.userId)) continue;
            const n = retardsDe(t, m, mvts);
            if (n >= seuil) await prevenirOrganisateur(t, `tontine:exclusion:${m.id}:${seuil}`, { titre: `${prenomDe(contactDe(m).nom)} : ${n} retards`, corps: `Dans « ${t.nom} », le seuil de ${seuil} retards est atteint.${estObjectif(t) ? ' Tu peux l’exclure depuis la page du groupe.' : ' Sa caution couvre ses prochaines cotisations en retard.'}` }, false);
          }
      }
    },

  };
}
