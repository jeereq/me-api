/**
 * Nom de l'app choisi par l'utilisateur (« Jarvis », « Alfred »…), à la place de « Me ». Vide = le nom d'origine.
 * Le même contrôle côté serveur (enregistrement du compte, consignes de l'IA) et dans l'app (réglage, voix, mot-clé).
 */

export const NOM_APP_DEFAUT = 'Me';
export const NOM_APP_MAX = 24;

/** Espaces resserrées, sans espace autour. */
export const nettoyerNomApp = (nom: string) => nom.replace(/\s+/g, ' ').trim();

/** Ce qui ne va pas dans ce nom, ou null s'il convient. Le nom vide est permis : il remet « Me ». */
export function erreurNomApp(brut: string): string | null {
  const nom = nettoyerNomApp(brut);
  if (!nom) return null;
  if (nom.length < 2) return 'Deux lettres au moins.';
  if (nom.length > NOM_APP_MAX) return `${NOM_APP_MAX} caractères au plus.`;
  if (!/^[\p{L}\p{N}' ’.-]+$/u.test(nom) || !/\p{L}/u.test(nom)) return 'Des lettres, des chiffres, des espaces, des tirets ou des apostrophes seulement.';
  if (nom.split(' ').length > 3) return 'Trois mots au plus, pour que la voix le reconnaisse bien.';
  return null;
}

/** Le nom à afficher et à dire : celui choisi s'il est valable, sinon « Me ». */
export function nomApp(brut?: string | null): string {
  const nom = typeof brut === 'string' ? nettoyerNomApp(brut) : '';
  return nom && !erreurNomApp(nom) ? nom : NOM_APP_DEFAUT;
}
