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
