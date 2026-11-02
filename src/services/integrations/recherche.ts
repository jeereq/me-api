/**
 * Chercher des mails pour l'analyse du copilote : ceux d'une personne (adresse ou nom), d'un domaine (tout @ovh.com),
 * d'un dossier, d'une boîte partagée, sur une période. Module pur : il traduit la demande pour Gmail et pour Outlook.
 * Dates en texte « AAAA-MM-JJ », bornes incluses.
 */

export type RechercheMails = { de?: string; domaine?: string; dossier?: string; boite?: string; depuis?: string; jusqua?: string; nonLus?: boolean; pj?: boolean; objet?: string; suivant?: string; max: number; fuseau: string };

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
export function requeteGmail(r: Pick<RechercheMails, 'de' | 'domaine' | 'depuis' | 'jusqua' | 'nonLus' | 'pj' | 'objet'>): string {
  const p: string[] = [];
  const de = propre(r.de);
  if (de) p.push(/\s/.test(de) ? `from:"${de}"` : `from:${de}`);
  const dom = domaineNu(r.domaine);
  if (dom) p.push(`from:${dom}`);
  if (r.depuis) p.push(`after:${r.depuis.replace(/-/g, '/')}`);
  if (r.jusqua) p.push(`before:${lendemain(r.jusqua).replace(/-/g, '/')}`);
  if (r.nonLus) p.push('is:unread');
  if (r.pj) p.push('has:attachment');
  const objet = propre(r.objet);
  if (objet) p.push(/\s/.test(objet) ? `subject:(${objet.replace(/[()]/g, ' ')})` : `subject:${objet}`);
  return p.join(' ');
}

/**
 * La requête Graph : avec un expéditeur ou un domaine, `$search` (qui ne se combine ni avec `$filter` ni avec `$orderby` :
 * la période, le non-lu et la pièce jointe sont alors vérifiés sur les mails rendus, `garder`) ; sinon un filtre trié sur la date de réception.
 */
export function requeteOutlook(r: Pick<RechercheMails, 'de' | 'domaine' | 'depuis' | 'jusqua' | 'nonLus' | 'pj' | 'objet' | 'max' | 'suivant'>, champs: string): { params: URLSearchParams; garder: (recu?: string, m?: { isRead?: boolean; hasAttachments?: boolean }) => boolean } {
  const de = propre(r.de);
  const dom = domaineNu(r.domaine);
  const debut = r.depuis ? `${r.depuis}T00:00:00Z` : '';
  const fin = r.jusqua ? `${lendemain(r.jusqua)}T00:00:00Z` : '';
  const objet = propre(r.objet);
  const dansPeriode = (recu?: string) => !recu || ((!debut || recu >= debut) && (!fin || recu < fin));
  const garder = (recu?: string, m?: { isRead?: boolean; hasAttachments?: boolean }) => dansPeriode(recu) && (!r.nonLus || m?.isRead === false) && (!r.pj || m?.hasAttachments === true);
  const saut = Math.max(0, Number(r.suivant) || 0);
  if (de || dom || objet) {
    const cherche = [de && `from:${de}`, dom && `from:${dom}`, objet && `subject:${objet}`].filter(Boolean).join(' AND ');
    // `$skip` n'est pas permis avec `$search` : on demande plus large, la période et les filtres font le tri.
    return { params: new URLSearchParams({ $search: `"${cherche}"`, $top: String(r.nonLus || r.pj ? 250 : Math.min(250, r.max * 2)), $select: champs }), garder };
  }
  // Graph exige que le champ trié vienne d'abord dans le filtre : une borne basse quand il n'y a pas de période.
  const avecFiltres = r.nonLus || r.pj;
  const f = [debut ? `receivedDateTime ge ${debut}` : avecFiltres && 'receivedDateTime ge 1900-01-01T00:00:00Z', fin && `receivedDateTime lt ${fin}`, r.nonLus && 'isRead eq false', r.pj && 'hasAttachments eq true'].filter(Boolean).join(' and ');
  return { params: new URLSearchParams({ ...(f ? { $filter: f } : {}), $orderby: 'receivedDateTime desc', $top: String(r.max), $skip: String(saut), $select: champs }), garder: () => true };
}
