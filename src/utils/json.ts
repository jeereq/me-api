/**
 * Rend un objet sûr à écrire dans une colonne Json (Prisma → PostgreSQL jsonb).
 *
 * Les textes venus des services externes (aperçus de mails coupés au milieu d'un emoji,
 * titres tronqués…) peuvent contenir une moitié de paire UTF-16 isolée : Prisma l'envoie
 * telle quelle (« \ud83d ») et son moteur refuse toute la requête
 * (« unexpected end of hex escape »). PostgreSQL refuse aussi le caractère nul (\u0000).
 * On remplace la moitié isolée par « � » et on retire le caractère nul.
 */
const SURROGAT_ISOLE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const textePropre = (s: string) => s.replace(SURROGAT_ISOLE, '�').replace(/\u0000/g, '');

export const jsonPropre = <T>(v: T): T => {
  if (typeof v === 'string') return textePropre(v) as T;
  if (Array.isArray(v)) return v.map(jsonPropre) as T;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[textePropre(k)] = jsonPropre(x);
    return out as T;
  }
  return v;
};
