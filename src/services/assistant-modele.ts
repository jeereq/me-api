/** Choix du modèle OpenAI quand celui de l'admin n'existe plus (module pur, testé). */

export const MODELE_DEFAUT = 'gpt-4o-mini';
/** Le modèle plus fort des mails importants et des synthèses quand ni l'admin ni le serveur n'en ont choisi un. S'il manque chez OpenAI, le tri du modèle habituel reste. */
export const MODELE_FORT_DEFAUT = 'gpt-4.1';
/** Valeur à donner pour ne pas utiliser de modèle fort : un seul modèle pour tout. */
export const SANS_MODELE_FORT = 'aucun';

type ErreurOpenAI = { error?: { message?: string; code?: string | null; type?: string | null } };

/** OpenAI dit que le modèle est retiré, renommé ou inconnu (404, `model_not_found`, « deprecated »…). */
export function modeleIndisponible(status: number, data: ErreurOpenAI | undefined): boolean {
  const e = data?.error;
  if (e?.code === 'model_not_found') return true;
  if (/deprecated|decommission|does not exist|no longer (available|supported)|model_not_found/i.test(e?.message ?? '')) return true;
  return status === 404;
}

/** Les modèles à essayer, dans l'ordre : celui de l'admin, celui du serveur (`OPENAI_MODEL`), puis le modèle par défaut. */
export function modelesAEssayer(choisi: string | undefined, serveur: string | undefined): string[] {
  const liste = [choisi, serveur, MODELE_DEFAUT].map((m) => m?.trim()).filter((m): m is string => !!m);
  return [...new Set(liste)];
}

/** Le modèle fort : le choix de l'admin, sinon `OPENAI_MODEL_FORT`, sinon le défaut ; « aucun » (dans l'un ou l'autre) = pas de modèle fort, chaîne vide. */
export function modeleFortChoisi(admin: string | undefined, serveur: string | undefined): string {
  const m = [admin, serveur, MODELE_FORT_DEFAUT].map((x) => x?.trim()).find((x): x is string => !!x) ?? '';
  return m.toLowerCase() === SANS_MODELE_FORT ? '' : m;
}

/** Les identifiants qui ne sont pas des modèles de chat (voix, temps réel, images, recherche…) : jamais proposés à l'admin. */
export const NON_CHAT = /audio|realtime|live|transcribe|tts|image|search|embedding|instruct|moderation|codex|computer-use|deep-research/;

/** Les modèles proposés d'abord à l'admin : ceux qui marchent bien avec l'app. */
export const CONSEILLES = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-5-mini', 'gpt-5'];

/** La liste pour l'admin : seulement des modèles de chat, les conseillés d'abord, puis les plus récents. */
export function modelesProposes(ids: string[]): string[] {
  const chat = ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !NON_CHAT.test(id));
  const conseilles = CONSEILLES.filter((m) => chat.includes(m));
  return [...conseilles, ...chat.filter((m) => !conseilles.includes(m)).sort().reverse()];
}

/** Combien de temps un modèle refusé par OpenAI est laissé de côté avant un nouvel essai. */
export const DUREE_ECART_MS = 6 * 3600_000;
const ecartes = new Map<string, number>();

/** Laisse de côté un modèle refusé (inconnu, retiré, pas de chat). Vrai la première fois : on ne le dit qu'une fois. */
export function ecarterModele(m: string, maintenant = Date.now()): boolean {
  const nouveau = !((ecartes.get(m) ?? 0) > maintenant);
  ecartes.set(m, maintenant + DUREE_ECART_MS);
  return nouveau;
}

/** Les modèles écartés en ce moment. */
export const modelesEcartes = (maintenant = Date.now()) => [...ecartes].filter(([, jusqua]) => jusqua > maintenant).map(([m]) => m);

/** Les candidats sans ceux qui viennent d'être refusés ; s'il n'en reste aucun, le dernier (le modèle par défaut) reste. */
export function sansEcartes(candidats: string[], maintenant = Date.now()): string[] {
  const restent = candidats.filter((m) => !((ecartes.get(m) ?? 0) > maintenant));
  return restent.length ? restent : candidats.slice(-1);
}

/** Pour les tests. */
export const oublierEcartes = () => ecartes.clear();
