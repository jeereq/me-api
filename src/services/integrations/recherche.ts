/**
 * Chercher des mails pour l'analyse du copilote : ceux d'une personne (adresse ou nom), d'un domaine (tout @ovh.com),
 * d'un dossier, d'une boîte partagée, sur une période. Module pur : il traduit la demande pour Gmail et pour Outlook.
 * Dates en texte « AAAA-MM-JJ », bornes incluses.
 */

export type RechercheMails = { de?: string; domaine?: string; dossier?: string; boite?: string; depuis?: string; jusqua?: string; suivant?: string; max: number; fuseau: string };

const propre = (s?: string) => (s ?? '').trim().replace(/["\\]/g, '');
/** « @ovh.com », « ovh.com », « https://www.ovh.com/fr » → « ovh.com ». */
export const domaineNu = (s?: string) =>
  propre(s)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^.*@/, '')
    .replace(/\/.*$/, '');

const lendemain = (d: string) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

/** La recherche Gmail (`q`) : `from:` accepte une adresse, un nom ou un domaine ; `before:` exclut son jour, d'où le lendemain. */
export function requeteGmail(r: Pick<RechercheMails, 'de' | 'domaine' | 'depuis' | 'jusqua'>): string {
  const p: string[] = [];
  const de = propre(r.de);
  if (de) p.push(/\s/.test(de) ? `from:"${de}"` : `from:${de}`);
  const dom = domaineNu(r.domaine);
  if (dom) p.push(`from:${dom}`);
  if (r.depuis) p.push(`after:${r.depuis.replace(/-/g, '/')}`);
  if (r.jusqua) p.push(`before:${lendemain(r.jusqua).replace(/-/g, '/')}`);
  return p.join(' ');
}

/**
 * La requête Graph : avec un expéditeur ou un domaine, `$search` (qui ne se combine ni avec `$filter` ni avec `$orderby` :
 * la période est alors vérifiée sur les mails rendus, `garder`) ; sinon un filtre sur la date de réception, trié.
 */
export function requeteOutlook(r: Pick<RechercheMails, 'de' | 'domaine' | 'depuis' | 'jusqua' | 'max' | 'suivant'>, champs: string): { params: URLSearchParams; garder: (recu?: string) => boolean } {
  const de = propre(r.de);
  const dom = domaineNu(r.domaine);
  const debut = r.depuis ? `${r.depuis}T00:00:00Z` : '';
  const fin = r.jusqua ? `${lendemain(r.jusqua)}T00:00:00Z` : '';
  const garder = (recu?: string) => !recu || ((!debut || recu >= debut) && (!fin || recu < fin));
  const saut = Math.max(0, Number(r.suivant) || 0);
  if (de || dom) {
    const cherche = [de && `from:${de}`, dom && `from:${dom}`].filter(Boolean).join(' AND ');
    // `$skip` n'est pas permis avec `$search` : on demande plus large, la période fait le tri.
    return { params: new URLSearchParams({ $search: `"${cherche}"`, $top: String(Math.min(250, r.max * 2)), $select: champs }), garder };
  }
  const f = [debut && `receivedDateTime ge ${debut}`, fin && `receivedDateTime lt ${fin}`].filter(Boolean).join(' and ');
  return { params: new URLSearchParams({ ...(f ? { $filter: f } : {}), $orderby: 'receivedDateTime desc', $top: String(r.max), $skip: String(saut), $select: champs }), garder: () => true };
}
