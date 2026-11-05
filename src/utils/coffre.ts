import { chiffrer, dechiffrer } from './crypto.js';

/**
 * Données de mails gardées en base (objet, expéditeur, extrait, résultat d'analyse) : chiffrées comme les jetons.
 * En base : `{ chiffre: "iv.tag.contenu" }`. Ce qui a été écrit avant reste lisible jusqu'au prochain passage.
 */
export const enCoffre = (valeur: unknown) => ({ chiffre: chiffrer(JSON.stringify(valeur)) });

export const estEnCoffre = (v: unknown): v is { chiffre: string } => !!v && typeof v === 'object' && typeof (v as { chiffre?: unknown }).chiffre === 'string';

/** La valeur d'origine. Illisible (clé changée, contenu abîmé) : null, comme si rien n'était gardé ; la prochaine synchro la refait. */
export function horsCoffre<T>(v: unknown): T | null {
  if (!estEnCoffre(v)) return (v ?? null) as T | null;
  try {
    return JSON.parse(dechiffrer(v.chiffre)) as T;
  } catch (e) {
    console.error('Donnée chiffrée illisible :', (e as Error).message);
    return null;
  }
}
