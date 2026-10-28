/**
 * Délais maximaux des appels aux services externes (Google, Microsoft, Slack, Trello, SendGrid, FlexPaie, Cloudinary).
 * Sans eux, un service qui ne répond plus garde la requête ouverte indéfiniment, et la tâche planifiée avec elle
 * (le verrou de synchro reste tenu jusqu'à la fin du bail).
 */

/** Un appel d'API ordinaire. */
export const DELAI_EXTERNE_MS = 15_000;
/** Un dépôt de fichier (jusqu'à 10 Mo) : plus long, la connexion du téléphone n'est pas en cause mais celle du serveur vers Cloudinary peut être lente. */
export const DELAI_FICHIER_MS = 60_000;

/** Signal à passer à `fetch` : l'appel est interrompu au bout de `ms`. */
export const delai = (ms: number = DELAI_EXTERNE_MS) => AbortSignal.timeout(ms);

/** Vrai si l'erreur vient d'un délai dépassé (et non d'un réseau coupé). */
export const estDelai = (e: unknown) => (e as { name?: string } | null)?.name === 'TimeoutError';
