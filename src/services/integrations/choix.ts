/**
 * Ce que le serveur lit dans un compte connecté : quels agendas, et comment ranger les mails.
 * Module pur (aucun appel réseau), partagé par les connecteurs Google et Microsoft.
 */

export type AgendaDispo = {
  id: string;
  nom: string;
  /** Agenda principal du compte. */
  principal?: boolean;
  /** Affiché par défaut dans le service d'origine (Google : case cochée dans la liste des agendas). */
  visible?: boolean;
  couleur?: string;
};

/** Vrai si l'un des noms contient l'un des filtres (comparaison sans casse). */
export const passeNom = (filtre: string[], ...noms: (string | undefined)[]) =>
  !filtre.length || noms.some((n) => n && filtre.some((f) => n.toLowerCase().includes(f.toLowerCase())));

/**
 * Les agendas à lire, dans l'ordre : ceux cochés dans l'app pour ce compte ; sinon ceux dont le nom contient
 * le filtre de l'écran Agendas & outils ; sinon ceux que le service affiche par défaut.
 * Un agenda coché puis disparu (partagé retiré) est simplement ignoré.
 */
export function agendasALire(dispo: AgendaDispo[], choisis: string[] | undefined, filtre: string[], max = 10): AgendaDispo[] {
  const garder = (l: AgendaDispo[]) => l.slice(0, max);
  if (choisis?.length) {
    const voulus = new Set(choisis);
    const retenus = dispo.filter((c) => voulus.has(c.id));
    // Tous les agendas cochés ont disparu : plutôt que de ne rien importer, on retombe sur le défaut.
    if (retenus.length) return garder(retenus);
  }
  if (filtre.length) return garder(dispo.filter((c) => passeNom(filtre, c.nom)));
  return garder(dispo.filter((c) => c.visible !== false));
}

/** Garde, parmi les agendas cochés, ceux qui existent encore : ce que l'app réaffiche après une synchronisation. */
export const choixValides = (dispo: AgendaDispo[], choisis: string[] | undefined) => {
  const existe = new Set(dispo.map((c) => c.id));
  return (choisis ?? []).filter((id) => existe.has(id));
};

export type MailImporte = {
  id: string;
  sujet: string;
  /** Qui écrit (mail reçu) ou à qui (mail envoyé). */
  contact: string;
  date: string;
  heure?: string;
  sens: 'recu' | 'envoye';
  nonLu?: boolean;
  /** Fil de discussion : les messages du même échange portent le même identifiant. */
  fil?: string;
  /** Adresse du contact, pour lui répondre. */
  adresse?: string;
  /** `Message-ID` du message : c'est lui qui raccroche une réponse au bon fil. */
  messageId?: string;
  /** `References` du message, à prolonger dans la réponse. */
  references?: string;
  lien?: string;
  source: 'gmail' | 'outlook';
  /** Les premiers mots du message, pour la liste (Gmail : snippet, Outlook : bodyPreview). */
  extrait?: string;
  /** Étiquettes posées sur le fil (libellés Gmail créés par l'utilisateur, catégories Outlook). */
  libelles?: string[];
  /** Le message porte des pièces jointes (Outlook le dit dès la liste). */
  pj?: boolean;
  /** Boîte partagée d'où vient le mail ; absente = la boîte du compte. */
  boite?: string;
  /** Dossier d'où vient le mail quand il a été lu dans un dossier (absent = boîte de réception). */
  dossier?: string;
};

/** Le réglage de chargement ramené dans des bornes raisonnables : 1 à 90 jours, 10 à 100 fils. */
export const chargementValide = (c: { jours?: unknown; max?: unknown } | undefined, defaut = { jours: 7, max: 25 }) => {
  const borne = (v: unknown, min: number, max: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d);
  return { jours: borne(c?.jours, 1, 90, defaut.jours), max: borne(c?.max, 10, 100, defaut.max) };
};

/** Des dossiers à plat rangés comme Outlook : réception, envoyés, brouillons… puis les autres par nom, chaque parent suivi de ses enfants. */
export function rangerDossiers<T extends { id: string; nom: string; parent?: string; genre: string }>(l: T[]): T[] {
  const ORDRE = ['reception', 'suivis', 'importants', 'brouillons', 'envoyes', 'archive', 'autre', 'indesirables', 'supprimes'];
  const cmp = (a: T, b: T) => ORDRE.indexOf(a.genre) - ORDRE.indexOf(b.genre) || a.nom.localeCompare(b.nom, 'fr');
  const ids = new Set(l.map((d) => d.id));
  const enfants = (p?: string): T[] =>
    l
      .filter((d) => (p ? d.parent === p : !d.parent || !ids.has(d.parent)))
      .sort(cmp)
      .flatMap((d) => [d, ...enfants(d.id)]);
  return enfants();
}

/** L'extrait d'un message, sur une ligne et en 160 caractères au plus. */
export const extrait = (t = '') => {
  const l = t.replace(/\s+/g, ' ').trim();
  return l.length > 160 ? `${l.slice(0, 159).trimEnd()}…` : l || undefined;
};

/** Les étiquettes ajoutées et retirées, appliquées à la liste courante : sans doublon, dans l'ordre d'origine. */
export function appliquerLibelles(actuels: string[], ajouter: string[], retirer: string[]): string[] {
  const sans = new Set(retirer.map((x) => x.toLowerCase()));
  const out = actuels.filter((x) => !sans.has(x.toLowerCase()));
  for (const a of ajouter) if (!out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  return out;
}

/** Une liste d'adresses de boîtes partagées propre : en minuscules, sans doublon, 10 au plus. */
export const boitesValides = (l: string[] = []) => [...new Set(l.map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))].slice(0, 10);

/**
 * Un seul message par fil (le plus récent), les plus récents d'abord.
 * Les mails sans date passent en dernier plutôt que d'être perdus.
 */
export function rangerMails(mails: MailImporte[], max = 25): MailImporte[] {
  const quand = (m: MailImporte) => `${m.date || '0000-00-00'} ${m.heure || '00:00'}`;
  const parFil = new Map<string, MailImporte>();
  for (const m of mails) {
    const cle = `${m.boite ?? ''}|${m.fil || m.id}`;
    const deja = parFil.get(cle);
    // Un fil où il reste un message non lu se signale même si le dernier message est lu.
    if (!deja) parFil.set(cle, m);
    else {
      const libelles = [...new Set([...(deja.libelles ?? []), ...(m.libelles ?? [])])];
      parFil.set(cle, { ...(quand(m) > quand(deja) ? m : deja), nonLu: deja.nonLu || m.nonLu, ...(libelles.length ? { libelles } : {}) });
    }
  }
  return [...parFil.values()].sort((a, b) => quand(b).localeCompare(quand(a))).slice(0, max);
}
