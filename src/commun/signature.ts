/**
 * Où commence la signature d'un mail : pour la présenter à part et ne pas la lire à voix haute. Module pur, le même pour l'écran et pour le serveur.
 * Il vaut mieux laisser une signature dans le texte que couper un vrai message : au moindre doute, on ne coupe pas.
 */

const DELIMITEUR = /^\s*(--|—|_{5,}|-{5,})\s*$/;
const ENVOYE_DE = /^\s*(envoy[ée]\s+(de|depuis)|sent from|get outlook|obtenir outlook|t[ée]l[ée]charger outlook)\b/i;
const FORMULE = /^\s*(cordialement|bien\s+(cordialement|à\s+(vous|toi)|a\s+(vous|toi))|bien\s+des\s+choses|sinc[eè]res\s+salutations|salutations(\s+distingu[ée]es)?|respectueusement|bonne\s+(journ[ée]e|soir[ée]e|semaine|r[ée]ception)|merci\s+(et\s+)?(cordialement|d['’]avance)|[àa]\s+bient[oô]t|best(\s+regards)?|kind\s+regards|regards|sincerely|thanks(\s+and\s+regards)?|cheers)\s*[,.!]*\s*$/i;
const COORDONNEE = /(\+?\d[\d\s().-]{7,}\d)|([^\s@]+@[^\s@]+\.[a-z]{2,})|(\bhttps?:\/\/|\bwww\.)|(^\s*(t[ée]l|tel|mobile|gsm|fax|site|web|adresse|email|e-mail|mail)\s*[.:]?\s)/i;

const COURTE = 80;
const MAX_SIGNATURE = 14;

const MERCI = /^\s*merci(\s+beaucoup)?\s*,?\s*$/i;

/** L'indice de la première ligne de la signature ; -1 s'il n'y en a pas de sûre. La formule de politesse reste dans le message. */
export function indiceSignature(lignes: string[], max = MAX_SIGNATURE): number {
  const n = lignes.length;
  const debut = Math.max(0, n - max - 1);
  const suite = (de: number) => lignes.slice(de).some((l) => l.trim()) && lignes.slice(de).every((l) => l.trim().length <= COURTE);
  for (let i = debut; i < n; i++) {
    if (i > 0 && DELIMITEUR.test(lignes[i]) && suite(i + 1)) return i;
    if (ENVOYE_DE.test(lignes[i]) && n - i <= 3) return i;
    if (FORMULE.test(lignes[i]) && suite(i + 1)) return i + 1;
    if (MERCI.test(lignes[i]) && n - i <= 6 && suite(i + 1)) return i + 1;
  }
  // Sans formule : un bloc final de coordonnées, précédé d'une ligne vide.
  let i = n - 1;
  while (i >= 0 && !lignes[i].trim()) i--;
  const fin = i;
  while (i >= 0 && lignes[i].trim() && lignes[i].trim().length <= COURTE) i--;
  const bloc = lignes.slice(i + 1, fin + 1);
  return i >= 0 && !lignes[i].trim() && bloc.filter((l) => COORDONNEE.test(l)).length >= 2 && bloc.length <= max ? i + 1 : -1;
}

export const estDelimiteur = (ligne: string) => DELIMITEUR.test(ligne);

/** Le message sans sa signature, et la signature à part. */
export function decouperSignature(texte: string): { corps: string; signature: string } {
  const lignes = texte.split('\n');
  const i = indiceSignature(lignes);
  if (i <= 0) return { corps: texte.trimEnd(), signature: '' };
  const part = lignes.slice(i);
  if (DELIMITEUR.test(part[0])) part.shift();
  return { corps: lignes.slice(0, i).join('\n').trimEnd(), signature: part.join('\n').trim() };
}
