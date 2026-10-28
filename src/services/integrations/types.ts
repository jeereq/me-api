import type { Fournisseur } from '@prisma/client';

import type { AgendaDispo, MailImporte } from './choix.js';

export type { AgendaDispo, MailImporte };

export type Ctx = 'perso' | 'pro';
/** Clés de source côté app (écran Agendas & outils). */
export type SourceKey = 'google_agenda' | 'google_taches' | 'gmail' | 'outlook' | 'trello' | 'slack';
export type ImportKind = 'agenda' | 'taches' | 'relances' | 'mails';

export type EvenementImporte = { id: string; date: string; debut: string; fin?: string; titre: string; lieu?: string; source: SourceKey; lien?: string; /** Nom de l'agenda d'origine (« Travail », « Famille »). */ agenda?: string };
/** Le mail d'où vient une tâche ou une relance : son fil (même identifiant que `MailImporte.fil`), son objet et l'adresse du contact. L'app s'en sert pour rattacher l'élément au mail. */
export type MailOrigine = { fil: string; sujet: string; contact?: string; adresse?: string };
export type TacheImportee = { id: string; titre: string; echeance: string | null; source: SourceKey; lien?: string; /** Liste d'origine (Google Tasks, Microsoft To Do) : de quoi cocher la tâche à la source depuis Me. */ liste?: string; mail?: MailOrigine };
export type RelanceImportee = { id: string; contact: string; sujet: string; date: string; source: SourceKey; lien?: string; mail?: MailOrigine };
/** Une étiquette du compte (libellé Gmail, catégorie Outlook), avec sa couleur quand le service en donne une. */
export type LibelleDispo = { nom: string; couleur?: string };
/** Une boîte partagée lue avec le compte (Microsoft 365) ; `erreur` dit pourquoi elle n'a pas pu l'être. */
export type BoitePartagee = { adresse: string; erreur?: string };
export type Elements = {
  agenda: EvenementImporte[];
  taches: TacheImportee[];
  relances: RelanceImportee[];
  mails: MailImporte[];
  /** Les étiquettes qu'on peut poser sur un mail de ce compte. */
  libelles?: LibelleDispo[];
  /** Les boîtes partagées demandées pour ce compte, et leur état à la dernière lecture. */
  boites?: BoitePartagee[];
  /** Les derniers mails vus en ouvrant un dossier (200 au plus) : de quoi les lire ou y répondre ensuite. */
  vus?: MailImporte[];
};

export type Jetons = { accessToken: string; refreshToken?: string | null; expiresAt?: Date | null };

/** Réglages de l'utilisateur pour une source, lus dans son espace (écran Agendas & outils). */
export type Prefs = { actif: boolean; imports: ImportKind[]; filtre: string[] };

/** Réglages propres à un compte connecté (écran Agendas & outils, bouton « Agendas à synchroniser »). */
export type PrefsCompte = {
  agendas?: string[];
  /** Adresses des boîtes partagées à lire avec ce compte (Microsoft 365). */
  boitesPartagees?: string[];
  /** Comment la boîte de réception se charge : sur combien de jours, et combien de fils au plus. */
  mails?: ChargementMails;
};
export type ChargementMails = { jours: number; max: number };
/** Par défaut : 7 jours, 25 fils, comme avant ce réglage. */
export const CHARGEMENT_DEFAUT: ChargementMails = { jours: 7, max: 25 };

/** Le genre d'un dossier, pour son icône et son ordre (comme le volet des dossiers d'Outlook). */
export type GenreDossier = 'reception' | 'envoyes' | 'brouillons' | 'archive' | 'supprimes' | 'indesirables' | 'suivis' | 'importants' | 'autre';
/** Un dossier de la boîte (Outlook) ou un libellé qui en tient lieu (Gmail) ; `parent` pour les sous-dossiers. */
export type DossierMail = { id: string; nom: string; parent?: string; genre: GenreDossier; nonLus: number; total?: number };
/** Une page de mails d'un dossier ; `suivant` se repasse pour la page d'après. */
export type PageMails = { mails: MailImporte[]; suivant?: string };
/** Une règle de la boîte Outlook, décrite en français. */
export type Regle = { id: string; nom: string; active: boolean; ordre: number; conditions: string[]; actions: string[]; enErreur?: boolean };
export type LectureDossier = { dossier: string; boite?: string; suivant?: string; max: number; fuseau: string };
/** Le fil d'un mail rattaché à une relance ou une tâche ; `moi` est l'adresse du compte (pour reconnaître un message envoyé). */
export type LectureFil = { fil: string; fuseau: string; moi?: string };
export type Deplacement = { mailId: string; fil?: string; dossier: string; depuis?: string; boite?: string };

export type Contexte = {
  jetons: Jetons;
  /** Agendas cochés pour CE compte ; vide = ceux que le service affiche par défaut. */
  agendas: string[];
  fuseau: string;
  /** Jours sans réponse avant de proposer une relance (configuration système). */
  delaiRelance: number;
  prefs: (k: SourceKey) => Prefs;
  /** Boîtes partagées à lire en plus de la boîte du compte. */
  boitesPartagees: string[];
  /** Combien de jours et de fils charger dans la boîte de réception. */
  chargement: ChargementMails;
};

export interface Connecteur {
  fournisseur: Fournisseur;
  nom: string;
  sources: SourceKey[];
  /** Contexte par défaut d'un compte connecté. */
  ctx: Ctx;
  configure(): boolean;
  urlAutorisation(state: string): string;
  /** Échange le code OAuth : jetons et nom du compte. */
  echanger(code: string): Promise<Jetons & { compte: string }>;
  rafraichir?(refreshToken: string): Promise<Jetons>;
  /** Agendas du compte, pour que l'utilisateur choisisse ceux à synchroniser. */
  agendas?(jetons: Jetons): Promise<AgendaDispo[]>;
  importer(c: Contexte): Promise<Elements>;

  /* Écriture : un service qui ne sait pas faire laisse la méthode absente, et l'app n'affiche pas le bouton. */

  /** Envoie une réponse dans le fil d'un message. */
  repondre?(jetons: Jetons, r: ReponseMail): Promise<{ lien?: string }>;
  /** Lit un mail en entier (et les messages plus anciens du fil), à la demande, et le marque comme lu dans la boîte. Me ne garde pas ce contenu. */
  lireMail?(jetons: Jetons, mailId: string, fuseau: string, ou?: OuMail): Promise<ContenuMail>;
  /** Pose ou retire des étiquettes sur un mail (tout le fil chez Gmail) ; rend les étiquettes qu'il porte ensuite. */
  etiqueter?(jetons: Jetons, e: Etiquetage): Promise<{ libelles: string[] }>;
  /** Accepte des boîtes partagées à lire avec le compte. */
  boitesPartagees?: boolean;
  /** Les dossiers de la boîte (la sienne ou une partagée), avec leurs non lus. */
  dossiers?(jetons: Jetons, boite?: string): Promise<DossierMail[]>;
  /** Une page de mails d'un dossier, lue à la demande. */
  mailsDuDossier?(jetons: Jetons, l: LectureDossier): Promise<PageMails>;
  /** Le dernier message d'un fil, où qu'il soit rangé (réception, envoyés, un dossier) ; null s'il n'existe plus. */
  mailDuFil?(jetons: Jetons, f: LectureFil): Promise<MailImporte | null>;
  /** Range un mail dans un autre dossier. */
  deplacer?(jetons: Jetons, d: Deplacement): Promise<void>;
  /** Les règles de la boîte de réception. */
  regles?(jetons: Jetons): Promise<Regle[]>;
  /** Active ou coupe une règle. */
  activerRegle?(jetons: Jetons, id: string, active: boolean): Promise<void>;
  /** Écrit un nouveau mail (pas une réponse). */
  envoyer?(jetons: Jetons, m: NouveauMail): Promise<{ lien?: string }>;
  /** Crée un rendez-vous dans un agenda du compte ; rend son identifiant. */
  creerEvenement?(jetons: Jetons, e: EcritureEvenement): Promise<{ id: string; lien?: string }>;
  modifierEvenement?(jetons: Jetons, e: EcritureEvenement & { id: string }): Promise<{ lien?: string }>;
  supprimerEvenement?(jetons: Jetons, e: { agendaId: string; id: string }): Promise<void>;
  /** Listes de tâches du compte (Google Tasks, Microsoft To Do). */
  listesTaches?(jetons: Jetons): Promise<ListeTaches[]>;
  creerTache?(jetons: Jetons, t: EcritureTache): Promise<{ id: string }>;
  majTache?(jetons: Jetons, t: EcritureTache & { id: string }): Promise<void>;
}

/** Une réponse à envoyer : le message d'origine, et le texte écrit dans Me. */
export type ReponseMail = { mailId: string; fil?: string; a: string; sujet: string; texte: string; messageId?: string; references?: string; /** Boîte partagée d'où part la réponse. */ boite?: string };
/** Où se trouve un mail : son fil, et la boîte partagée qui le contient (absente = la boîte du compte). */
/** `garderNonLu` : lu pour l'analyse du copilote, le mail reste « non lu » dans la boîte. */
export type OuMail = { fil?: string; boite?: string; garderNonLu?: boolean };
export type Etiquetage = OuMail & { mailId: string; ajouter: string[]; retirer: string[] };
/** Un message plus ancien du même fil, lu avec le mail ouvert. */
export type MessageFil = { id: string; de: string; adresse?: string; date?: string; heure?: string; texte: string; piecesJointes: string[] };
/** Un mail lu en entier : le texte brut (sans mise en forme) et le nom des pièces jointes. */
export type ContenuMail = {
  id: string;
  sujet: string;
  de: string;
  adresse?: string;
  a: string[];
  cc: string[];
  date?: string;
  heure?: string;
  texte: string;
  piecesJointes: string[];
  lien?: string;
  /** Étiquettes posées sur le mail (libellés Gmail, catégories Outlook). */
  libelles?: string[];
  /** Les messages plus anciens du fil, du plus ancien au plus récent (10 au plus). */
  fil?: MessageFil[];
};
/** Un nouveau mail écrit dans Me : adresses déjà vérifiées. */
export type NouveauMail = { a: string[]; cc: string[]; sujet: string; texte: string };
export type EcritureEvenement = { agendaId: string; titre: string; date: string; debut?: string; fin?: string; lieu?: string; journee?: boolean; fuseau: string };
export type ListeTaches = { id: string; nom: string; principale?: boolean };
export type EcritureTache = { listeId: string; titre: string; echeance?: string | null; fait?: boolean };

export const vide = (): Elements => ({ agenda: [], taches: [], relances: [], mails: [] });

/** Les messages du fil affichés avec le mail ouvert : les plus récents, sans le mail lui-même. */
export const FIL_MAX = 10;
