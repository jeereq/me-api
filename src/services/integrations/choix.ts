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
  lien?: string;
  source: 'gmail' | 'outlook';
};

/**
 * Un seul message par fil (le plus récent), les plus récents d'abord.
 * Les mails sans date passent en dernier plutôt que d'être perdus.
 */
export function rangerMails(mails: MailImporte[], max = 25): MailImporte[] {
  const quand = (m: MailImporte) => `${m.date || '0000-00-00'} ${m.heure || '00:00'}`;
  const parFil = new Map<string, MailImporte>();
  for (const m of mails) {
    const cle = m.fil || m.id;
    const deja = parFil.get(cle);
    // Un fil où il reste un message non lu se signale même si le dernier message est lu.
    if (!deja) parFil.set(cle, m);
    else parFil.set(cle, { ...(quand(m) > quand(deja) ? m : deja), nonLu: deja.nonLu || m.nonLu });
  }
  return [...parFil.values()].sort((a, b) => quand(b).localeCompare(quand(a))).slice(0, max);
}
