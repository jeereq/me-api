/** Choix du modèle OpenAI quand celui de l'admin n'existe plus (module pur, testé). */

export const MODELE_DEFAUT = 'gpt-4o-mini';

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
