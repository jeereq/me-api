import type { Fournisseur } from '@prisma/client';

export type Ctx = 'perso' | 'pro';
/** Clés de source côté app (écran Agendas & outils). */
export type SourceKey = 'google_agenda' | 'gmail' | 'outlook' | 'trello' | 'slack';
export type ImportKind = 'agenda' | 'taches' | 'relances';

export type EvenementImporte = { id: string; date: string; debut: string; fin?: string; titre: string; lieu?: string; source: SourceKey; lien?: string };
export type TacheImportee = { id: string; titre: string; echeance: string | null; source: SourceKey; lien?: string };
export type RelanceImportee = { id: string; contact: string; sujet: string; date: string; source: SourceKey; lien?: string };
export type Elements = { agenda: EvenementImporte[]; taches: TacheImportee[]; relances: RelanceImportee[] };

export type Jetons = { accessToken: string; refreshToken?: string | null; expiresAt?: Date | null };

/** Réglages de l'utilisateur pour une source, lus dans son espace (écran Agendas & outils). */
export type Prefs = { actif: boolean; imports: ImportKind[]; filtre: string[] };

export type Contexte = {
  jetons: Jetons;
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
  importer(c: Contexte): Promise<Elements>;
}

export const vide = (): Elements => ({ agenda: [], taches: [], relances: [] });
