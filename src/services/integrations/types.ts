import type { Fournisseur } from '@prisma/client';

import type { AgendaDispo, MailImporte } from './choix.js';

export type { AgendaDispo, MailImporte };

export type Ctx = 'perso' | 'pro';
/** Clés de source côté app (écran Agendas & outils). */
export type SourceKey = 'google_agenda' | 'google_taches' | 'gmail' | 'outlook' | 'trello' | 'slack';
export type ImportKind = 'agenda' | 'taches' | 'relances' | 'mails';

export type EvenementImporte = { id: string; date: string; debut: string; fin?: string; titre: string; lieu?: string; source: SourceKey; lien?: string; /** Nom de l'agenda d'origine (« Travail », « Famille »). */ agenda?: string };
export type TacheImportee = { id: string; titre: string; echeance: string | null; source: SourceKey; lien?: string; /** Liste d'origine (Google Tasks, Microsoft To Do) : de quoi cocher la tâche à la source depuis Me. */ liste?: string };
export type RelanceImportee = { id: string; contact: string; sujet: string; date: string; source: SourceKey; lien?: string };
export type Elements = { agenda: EvenementImporte[]; taches: TacheImportee[]; relances: RelanceImportee[]; mails: MailImporte[] };

export type Jetons = { accessToken: string; refreshToken?: string | null; expiresAt?: Date | null };

/** Réglages de l'utilisateur pour une source, lus dans son espace (écran Agendas & outils). */
export type Prefs = { actif: boolean; imports: ImportKind[]; filtre: string[] };

/** Réglages propres à un compte connecté (écran Agendas & outils, bouton « Agendas à synchroniser »). */
export type PrefsCompte = { agendas?: string[] };

export type Contexte = {
  jetons: Jetons;
  /** Agendas cochés pour CE compte ; vide = ceux que le service affiche par défaut. */
  agendas: string[];
  fuseau: string;
  /** Jours sans réponse avant de proposer une relance (configuration système). */
  delaiRelance: number;
  prefs: (k: SourceKey) => Prefs;
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
export type ReponseMail = { mailId: string; fil?: string; a: string; sujet: string; texte: string; messageId?: string; references?: string };
export type EcritureEvenement = { agendaId: string; titre: string; date: string; debut?: string; fin?: string; lieu?: string; journee?: boolean; fuseau: string };
export type ListeTaches = { id: string; nom: string; principale?: boolean };
export type EcritureTache = { listeId: string; titre: string; echeance?: string | null; fait?: boolean };

export const vide = (): Elements => ({ agenda: [], taches: [], relances: [], mails: [] });
