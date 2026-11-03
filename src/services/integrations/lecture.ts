/**
 * Lire un mail en entier : retrouver son texte dans ce que renvoie Gmail, ou le tirer du HTML quand il n'y a que ça.
 * Module pur (aucun appel réseau) : les connecteurs lui passent la réponse du service.
 */

/** Taille maximale du texte rendu à l'app : au-delà, un lien vers le mail d'origine suffit. */
export const TEXTE_MAX = 50_000;

/** Gmail encode les corps en base64 « URL safe ». */
export const depuisBase64Url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

const ENTITES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', ugrave: 'ù', icirc: 'î', euro: '€', rsquo: '’', lsquo: '‘', laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—' };

/** Les entités HTML d'un texte (« &amp; », « &#39; ») remplacées par leur caractère : les extraits de Gmail en sont pleins. */
export const decoderEntites = (t: string) =>
  t
    .replace(/&#(\d+);/g, (_t, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_t, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (t, n: string) => ENTITES[n.toLowerCase()] ?? t);

/** Du HTML au texte lisible : les blocs deviennent des lignes, les liens gardent leur adresse, le reste est retiré. */
export function htmlEnTexte(html: string): string {
  return nettoyerTexte(
    decoderEntites(
      html
        .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_t, href: string, txt: string) => {
          const t = txt.replace(/<[^>]+>/g, '').trim();
          return !t || t === href || href.startsWith('mailto:') ? t || href : `${t} (${href})`;
        })
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/(p|div|tr|h[1-6]|blockquote|table|ul|ol)>/gi, '\n')
        .replace(/<[^>]+>/g, ''),
    ),
  );
}

/** Espaces en trop retirés, jamais plus d'une ligne vide d'affilée, et une longueur raisonnable. */
export function nettoyerTexte(t: string): string {
  const net = t
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return net.length > TEXTE_MAX ? `${net.slice(0, TEXTE_MAX).trimEnd()}\n\n[…] La suite est dans le mail d'origine.` : net;
}

export type PartieGmail = { partId?: string; mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; attachmentId?: string; size?: number }; parts?: PartieGmail[] };
export type ImageGmail = { cid: string; mimeType?: string; filename?: string; attachmentId?: string; data?: string; size: number };

/** Le HTML d'un message Gmail, et les images jointes que ce HTML peut afficher (« cid: »), par identifiant brut. */
export function htmlDeGmail(payload: PartieGmail | undefined): { html: string; images: ImageGmail[] } {
  const htmls: string[] = [];
  const images: ImageGmail[] = [];
  const parcourir = (p: PartieGmail | undefined) => {
    if (!p) return;
    const cid = p.headers?.find((h) => h.name.toLowerCase() === 'content-id')?.value;
    if (cid && p.mimeType?.toLowerCase().startsWith('image/') && (p.body?.attachmentId || p.body?.data)) {
      images.push({ cid, mimeType: p.mimeType, filename: p.filename, attachmentId: p.body.attachmentId, data: p.body.data, size: p.body.size ?? 0 });
    } else if (!p.filename && p.body?.data && p.mimeType === 'text/html') htmls.push(depuisBase64Url(p.body.data));
    p.parts?.forEach(parcourir);
  };
  parcourir(payload);
  return { html: htmls.join('\n'), images };
}

/** Le texte d'un message Gmail : la partie texte de préférence, sinon le HTML converti ; et les noms des pièces jointes. */
export function texteDeGmail(payload: PartieGmail | undefined): { texte: string; piecesJointes: string[] } {
  const plats: string[] = [];
  const htmls: string[] = [];
  const pieces: string[] = [];
  const parcourir = (p: PartieGmail | undefined) => {
    if (!p) return;
    if (p.filename && (p.body?.attachmentId || p.body?.size)) pieces.push(p.filename);
    else if (p.body?.data && p.mimeType === 'text/plain') plats.push(depuisBase64Url(p.body.data));
    else if (p.body?.data && p.mimeType === 'text/html') htmls.push(depuisBase64Url(p.body.data));
    p.parts?.forEach(parcourir);
  };
  parcourir(payload);
  const texte = plats.length ? nettoyerTexte(plats.join('\n\n')) : htmls.length ? htmlEnTexte(htmls.join('\n')) : '';
  return { texte, piecesJointes: pieces };
}

/** Les pièces jointes d'un message Gmail. Son repère est la partie du message : l'identifiant de pièce jointe de Gmail change d'une lecture à l'autre. */
export function piecesDeGmail(payload: PartieGmail | undefined, sauf: Set<string> = new Set()): { id: string; nom: string; taille?: number; type?: string }[] {
  const out: { id: string; nom: string; taille?: number; type?: string }[] = [];
  const parcourir = (p: PartieGmail | undefined) => {
    if (!p) return;
    if (p.filename && p.partId && (p.body?.attachmentId || p.body?.size) && !sauf.has(p.filename)) out.push({ id: p.partId, nom: p.filename, ...(p.body?.size ? { taille: p.body.size } : {}), ...(p.mimeType ? { type: p.mimeType } : {}) });
    p.parts?.forEach(parcourir);
  };
  parcourir(payload);
  return out;
}

/** Une partie d'un message Gmail, par son repère. */
export function partieGmail(payload: PartieGmail | undefined, partId: string): PartieGmail | null {
  if (!payload) return null;
  if (payload.partId === partId) return payload;
  for (const p of payload.parts ?? []) {
    const x = partieGmail(p, partId);
    if (x) return x;
  }
  return null;
}
