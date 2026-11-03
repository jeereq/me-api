import { estDelimiteur, indiceSignature } from '../../commun/signature.js';
import { decoderEntites, nettoyerTexte } from './lecture.js';

/**
 * Le HTML d'un mail transformé en blocs simples que l'app dessine elle-même : paragraphes, listes, tableaux, images, signature.
 * Aucun HTML ne parvient à l'app, donc aucun script ni style du mail ne peut s'y exécuter. Module pur.
 */
export type Morceau = { v: string; g?: boolean; i?: boolean; s?: boolean; h?: string };
export type CelluleMail = { m: Morceau[]; entete?: boolean; span?: number };
export type BlocMail =
  | { t: 'p'; m: Morceau[] }
  | { t: 'titre'; m: Morceau[] }
  | { t: 'liste'; ordonnee: boolean; items: Morceau[][] }
  | { t: 'table'; lignes: CelluleMail[][] }
  | { t: 'images'; items: ImageMail[] }
  | { t: 'rangee'; cellules: BlocMail[][] }
  | { t: 'citation'; blocs: BlocMail[] }
  | { t: 'trait' };
export type ImageMail = { src: string; alt?: string; l?: number; h?: number; lien?: string };
export type CorpsRiche = { blocs: BlocMail[]; signature: BlocMail[]; cite: BlocMail[] };
/** Ce que l'app reçoit : le corps, et le texte que la voix lit (ni signature ni message cité). */
export type MailRiche = CorpsRiche & { aLire: string };

type Noeud = { nom: string; attrs: Record<string, string>; enfants: (Noeud | string)[] };

const VIDES = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'area', 'base', 'col', 'wbr']);
const SANS_RENDU = new Set(['head', 'title', 'style', 'script', 'meta', 'link', 'xml', 'noscript', 'iframe', 'object', 'embed', 'svg', 'form', 'select', 'button', 'input', 'textarea', 'template']);
const BLOCS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'center', 'address', 'pre', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'body', 'html', 'tbody', 'thead', 'tfoot', 'caption']);
const FERME_AUSSI: Record<string, string[]> = { li: ['li'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], p: ['p'], tbody: ['tr', 'td', 'th'], thead: ['tr', 'td', 'th'], tfoot: ['tr', 'td', 'th'] };
const MAX_BLOCS = 500;
const MAX_LIGNES_SIGNATURE = 14;
const MAX_HTML = 800_000;
const MAX_PROFONDEUR = 150;
const TEXTE_BRUT = new Set(['script', 'style', 'title', 'xml', 'textarea']);

function lireAttrs(brut: string): Record<string, string> {
  const a: Record<string, string> = {};
  for (const m of brut.matchAll(/([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) a[m[1].toLowerCase()] = decoderEntites(m[2] ?? m[3] ?? m[4] ?? '');
  return a;
}

/** La fin d'une balise ouverte à `de`, guillemets compris ; -1 si elle ne se ferme jamais. */
function finDeBalise(html: string, de: number): number {
  let guillemet = '';
  for (let i = de; i < html.length; i++) {
    const c = html[i];
    if (guillemet) {
      if (c === guillemet) guillemet = '';
    } else if (c === '"' || c === "'") guillemet = c;
    else if (c === '>') return i;
  }
  return -1;
}

/**
 * Un arbre tolérant : les mails contiennent souvent du HTML mal fermé.
 * Lu caractère par caractère plutôt qu'avec une grande expression, pour qu'un mail piégé ne bloque pas le serveur.
 */
export function arbreHtml(html: string): Noeud {
  const racine: Noeud = { nom: 'racine', attrs: {}, enfants: [] };
  const pile = [racine];
  const bas = html.toLowerCase();
  const texte = (t: string) => {
    if (t) pile[pile.length - 1].enfants.push(decoderEntites(t));
  };
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) break;
    const suivant = html[lt + 1] ?? '';
    if (html.startsWith('<!--', lt)) {
      texte(html.slice(pos, lt));
      const fin = html.indexOf('-->', lt + 4);
      pos = fin < 0 ? html.length : fin + 3;
      continue;
    }
    if (suivant === '!' || suivant === '?') {
      texte(html.slice(pos, lt));
      const fin = html.indexOf('>', lt);
      pos = fin < 0 ? html.length : fin + 1;
      continue;
    }
    const fermante = suivant === '/';
    const nomDe = lt + (fermante ? 2 : 1);
    const m = /^[a-zA-Z][\w:-]*/.exec(html.slice(nomDe, nomDe + 40));
    if (!m) {
      // Un « < » tout seul : du texte.
      texte(html.slice(pos, lt + 1));
      pos = lt + 1;
      continue;
    }
    const fin = finDeBalise(html, nomDe + m[0].length);
    if (fin < 0) {
      // Balise jamais fermée : le reste n'est plus lisible.
      texte(html.slice(pos, lt));
      pos = html.length;
      break;
    }
    texte(html.slice(pos, lt));
    pos = fin + 1;
    const nom = m[0].toLowerCase();
    if (fermante) {
      // Une balise fermante perdue ne doit pas fermer le tableau qui l'entoure.
      for (let i = pile.length - 1; i > 0; i--) {
        if (pile[i].nom === nom) {
          pile.length = i;
          break;
        }
        if (pile[i].nom === 'table') break;
      }
      continue;
    }
    if (TEXTE_BRUT.has(nom)) {
      // Leur contenu n'est jamais affiché.
      const f = bas.indexOf(`</${nom}`, pos);
      const g = f < 0 ? -1 : html.indexOf('>', f);
      pos = g < 0 ? html.length : g + 1;
      continue;
    }
    const ferme = FERME_AUSSI[nom];
    if (ferme) {
      // Ne remonte pas au-delà d'un tableau ou d'une liste imbriqués.
      let haut = 0;
      for (let i = pile.length - 1; i > 0 && !['table', 'ul', 'ol'].includes(pile[i].nom); i--) if (ferme.includes(pile[i].nom)) haut = i;
      if (haut) pile.length = haut;
    }
    const brut = html.slice(nomDe + m[0].length, fin);
    const n: Noeud = { nom, attrs: lireAttrs(brut), enfants: [] };
    pile[pile.length - 1].enfants.push(n);
    // Au-delà d'une profondeur que personne n'écrit à la main, les balises deviennent des voisines.
    if (!VIDES.has(nom) && !brut.endsWith('/') && pile.length < MAX_PROFONDEUR) pile.push(n);
  }
  texte(html.slice(pos));
  return racine;
}

const style = (n: Noeud, prop: string) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(n.attrs.style ?? '')?.[1]?.trim().toLowerCase();
const zero = (v?: string) => !!v && /^0(\.0+)?([a-z%]+)?(\s*!important)?$/.test(v);
const cache = (n: Noeud) => {
  if ('hidden' in n.attrs || style(n, 'display')?.startsWith('none') || style(n, 'visibility')?.startsWith('hidden') || style(n, 'mso-hide')?.startsWith('all') || zero(style(n, 'max-height')) || zero(style(n, 'opacity'))) return true;
  // Une taille nulle ne masque que si le débordement est coupé. Une police à 0 seule ne masque rien : les newsletters s'en servent pour leurs colonnes.
  return !!style(n, 'overflow')?.startsWith('hidden') && (zero(style(n, 'height')) || zero(style(n, 'width')) || zero(style(n, 'max-width')));
};
const marque = (n: Noeud) => `${n.attrs.id ?? ''} ${n.attrs.class ?? ''} ${n.attrs['data-smartmail'] ?? ''}`;
const EST_SIGNATURE = /(^|[\s_-])(x_)?(signature|gmail_signature|moz-signature|applemailsignature|ms-outlook-mobile-signature|olksignature)\b|signatureContainer/i;
const EST_CITATION = /gmail_quote|gmail_attr|mail-editor-reference-message-container|moz-cite-prefix|yahoo_quoted|AppleOriginalContents/i;
/** Outlook ne met pas le message cité dans un cadre : il pose ce repère, et tout ce qui suit est cité. */
const DEBUT_CITATION = /divRplyFwdMsg|appendonsend|OLK_SRC_BODY_SECTION/i;

const lienSur = (h?: string) => {
  const t = h?.trim();
  return t && /^(https?:|mailto:|tel:)/i.test(t) ? t : undefined;
};
const nombre = (v?: string) => {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 && !/%/.test(v ?? '') ? n : undefined;
};

function lireImage(n: Noeud, lien?: string): ImageMail | null {
  const brut = n.attrs.src?.trim() ?? '';
  const src = /^http:/i.test(brut) ? `https:${brut.slice(5)}` : brut;
  if (!/^(https:|cid:|data:image\/(png|jpe?g|gif|webp);)/i.test(src)) return null;
  const l = nombre(n.attrs.width) ?? nombre(style(n, 'width'));
  const h = nombre(n.attrs.height) ?? nombre(style(n, 'height'));
  // Un point de 1 pixel n'est pas une image : c'est un mouchard d'ouverture.
  if ((l !== undefined && l <= 3) || (h !== undefined && h <= 3)) return null;
  return { src, ...(n.attrs.alt?.trim() ? { alt: n.attrs.alt.trim().slice(0, 200) } : {}), ...(l ? { l } : {}), ...(h ? { h } : {}), ...(lien ? { lien } : {}) };
}

const texteDe = (m: Morceau[], liens = false) => m.map((x) => (liens && x.h && x.h !== x.v && !x.h.startsWith('mailto:') && !x.h.startsWith('tel:') ? `${x.v} (${x.h})` : x.v)).join('');
const texteNoeud = (n: Noeud | string): string => (typeof n === 'string' ? n : n.enfants.map(texteNoeud).join(n.nom === 'br' ? '\n' : ''));

/** Regroupe les morceaux de même style, sans espaces doublés ni blancs de bord. */
function nettoyerMorceaux(m: Morceau[]): Morceau[] {
  const out: Morceau[] = [];
  for (const x of m) {
    const v = x.v.replace(/[ \t\r\n\f\u00a0]+/g, ' ');
    if (!v) continue;
    const p = out[out.length - 1];
    if (p && p.g === x.g && p.i === x.i && p.s === x.s && p.h === x.h) p.v += v;
    else out.push({ ...x, v });
  }
  for (const x of out) x.v = x.v.replace(/\u2028/g, '\n').replace(/ *\n */g, '\n').replace(/ {2,}/g, ' ');
  if (out.length) {
    out[0].v = out[0].v.replace(/^[\s]+/, '');
    out[out.length - 1].v = out[out.length - 1].v.replace(/[\s]+$/, '');
  }
  return out.filter((x) => x.v);
}

type Style = Pick<Morceau, 'g' | 'i' | 's' | 'h'>;
type Sortie = { signature: BlocMail[]; cite: BlocMail[] };

function styleDe(n: Noeud, s: Style): Style {
  const fw = style(n, 'font-weight');
  const fs = style(n, 'font-style');
  const td = style(n, 'text-decoration') ?? style(n, 'text-decoration-line');
  return {
    ...s,
    ...(n.nom === 'b' || n.nom === 'strong' || fw === 'bold' || fw === 'bolder' || (fw && Number(fw) >= 600) ? { g: true } : {}),
    ...(n.nom === 'i' || n.nom === 'em' || fs === 'italic' ? { i: true } : {}),
    ...(n.nom === 'u' || td?.includes('underline') ? { s: true } : {}),
    ...(n.nom === 'a' && lienSur(n.attrs.href) ? { h: lienSur(n.attrs.href) } : {}),
  };
}

/** Les blocs d'une suite de noeuds ; le texte et les balises en ligne s'accumulent en paragraphe. */
function versBlocs(noeuds: (Noeud | string)[], base: Style, sortie: Sortie): BlocMail[] {
  const out: BlocMail[] = [];
  let courant: Morceau[] = [];
  const vider = () => {
    const m = nettoyerMorceaux(courant);
    courant = [];
    if (m.length) out.push({ t: 'p', m });
  };
  const ajouterImage = (im: ImageMail) => {
    // Une petite icône au milieu du texte (téléphone, réseau social sans lien) ne mérite pas sa ligne.
    if ((im.l ?? 99) <= 24 && (im.h ?? 99) <= 24 && !im.lien && texteDe(courant).trim()) return;
    vider();
    const p = out[out.length - 1];
    if (p?.t === 'images') p.items.push(im);
    else out.push({ t: 'images', items: [im] });
  };
  const parcourir = (n: Noeud | string, s: Style) => {
    if (typeof n === 'string') return void courant.push({ v: n, ...s });
    if (SANS_RENDU.has(n.nom) || cache(n)) return;
    if (EST_SIGNATURE.test(marque(n))) {
      vider();
      // Un mail n'a qu'une signature : celles qui suivent viennent des messages plus anciens recopiés dessous.
      const dedans: Sortie = { signature: [], cite: [] };
      const blocs = [...versBlocs(n.enfants, base, dedans), ...dedans.signature];
      (sortie.signature.length ? sortie.cite : sortie.signature).push(...blocs);
      sortie.cite.push(...dedans.cite);
      return;
    }
    if (EST_CITATION.test(marque(n)) || (n.nom === 'blockquote' && n.attrs.type === 'cite')) {
      vider();
      // La signature d'un message cité reste avec lui.
      const dedans: Sortie = { signature: [], cite: [] };
      return void sortie.cite.push(...versBlocs(n.enfants, base, dedans), ...dedans.signature, ...dedans.cite);
    }
    switch (n.nom) {
      case 'br':
        return void courant.push({ v: '\u2028', ...s });
      case 'hr':
        vider();
        return void out.push({ t: 'trait' });
      case 'img': {
        const im = lireImage(n, s.h);
        if (im) ajouterImage(im);
        else if (n.attrs.alt?.trim() && !/^(https?:|cid:)/i.test(n.attrs.src ?? '')) courant.push({ v: n.attrs.alt.trim(), ...s });
        return;
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        vider();
        const m = nettoyerMorceaux(lignesEnLigne(n.enfants, styleDe(n, s)));
        if (m.length) out.push({ t: 'titre', m });
        return;
      }
      case 'ul':
      case 'ol': {
        vider();
        const items = n.enfants.filter((x): x is Noeud => typeof x !== 'string' && x.nom === 'li' && !cache(x)).map((li) => nettoyerMorceaux(lignesEnLigne(li.enfants, styleDe(li, s)))).filter((m) => m.length);
        if (items.length) out.push({ t: 'liste', ordonnee: n.nom === 'ol', items });
        return;
      }
      case 'blockquote': {
        vider();
        const blocs = versBlocs(n.enfants, s, sortie);
        if (blocs.length) out.push({ t: 'citation', blocs });
        return;
      }
      case 'table':
        vider();
        return void out.push(...lireTable(n, s, sortie));
      default:
        if (BLOCS.has(n.nom)) {
          vider();
          const st = styleDe(n, s);
          n.enfants.forEach((x) => parcourir(x, st));
          return vider();
        }
        {
          const st = styleDe(n, s);
          n.enfants.forEach((x) => parcourir(x, st));
        }
    }
  };
  noeuds.forEach((x) => parcourir(x, base));
  vider();
  return out;
}

/** Le contenu d'une cellule ou d'une puce, sur une seule suite de morceaux : les blocs deviennent des retours à la ligne. */
function lignesEnLigne(noeuds: (Noeud | string)[], s: Style): Morceau[] {
  const out: Morceau[] = [];
  const parcourir = (n: Noeud | string, st: Style) => {
    if (typeof n === 'string') return void out.push({ v: n, ...st });
    if (SANS_RENDU.has(n.nom) || cache(n)) return;
    if (n.nom === 'br') return void out.push({ v: '\u2028', ...st });
    const bloc = BLOCS.has(n.nom) || n.nom === 'li';
    if (bloc && out.length) out.push({ v: '\u2028', ...st });
    const suivant = styleDe(n, st);
    n.enfants.forEach((x) => parcourir(x, suivant));
  };
  noeuds.forEach((x) => parcourir(x, s));
  return out;
}

function lignesTable(t: Noeud): Noeud[] {
  const out: Noeud[] = [];
  for (const e of t.enfants) {
    if (typeof e === 'string' || cache(e)) continue;
    if (e.nom === 'tr') out.push(e);
    else if (e.nom === 'tbody' || e.nom === 'thead' || e.nom === 'tfoot') out.push(...lignesTable(e));
  }
  return out;
}
const cellules = (tr: Noeud) => tr.enfants.filter((x): x is Noeud => typeof x !== 'string' && (x.nom === 'td' || x.nom === 'th') && !cache(x));
const contient = (n: Noeud, noms: string[]): boolean => n.enfants.some((x) => typeof x !== 'string' && (noms.includes(x.nom) || contient(x, noms)));

/** Un vrai tableau de données, ou un tableau qui sert seulement à la mise en page (signatures, newsletters) ? */
export function estTableauDeDonnees(t: Noeud): boolean {
  const lignes = lignesTable(t).map(cellules).filter((l) => l.length);
  if (lignes.length < 2) return false;
  const colonnes = Math.max(...lignes.map((l) => l.length));
  if (colonnes < 2 || colonnes > 12) return false;
  const toutes = lignes.flat();
  if (toutes.some((c) => contient(c, ['table', 'img', 'ul', 'ol', 'h1', 'h2', 'h3', 'blockquote']))) return false;
  const textes = toutes.map((c) => texteNoeud(c).replace(/\s+/g, ' ').trim());
  const pleines = textes.filter(Boolean);
  if (toutes.some((c) => c.nom === 'th') || Number(t.attrs.border) > 0) return pleines.length > 0;
  return pleines.length / toutes.length >= 0.6 && pleines.every((x) => x.length <= 120);
}

function lireTable(t: Noeud, s: Style, sortie: Sortie): BlocMail[] {
  if (cache(t)) return [];
  if (estTableauDeDonnees(t)) {
    const lignes = lignesTable(t)
      .map((tr) =>
        cellules(tr).map((c): CelluleMail => {
          const span = Number(c.attrs.colspan) > 1 ? Number(c.attrs.colspan) : undefined;
          const m = nettoyerMorceaux(lignesEnLigne(c.enfants, styleDe(c, s)));
          const entete = c.nom === 'th' || (m.length > 0 && m.every((x) => x.g));
          return { m, ...(entete ? { entete: true } : {}), ...(span ? { span } : {}) };
        }),
      )
      .filter((l) => l.length);
    return [{ t: 'table', lignes }];
  }
  const out: BlocMail[] = [];
  for (const tr of lignesTable(t)) {
    const cs = cellules(tr).map((c) => versBlocs(c.enfants, styleDe(c, s), sortie)).filter((b) => b.length);
    if (cs.length === 1) out.push(...cs[0]);
    else if (cs.length > 1) out.push({ t: 'rangee', cellules: cs });
  }
  return out;
}

const compter = (b: BlocMail[]): number => b.reduce((n, x) => n + 1 + (x.t === 'table' ? x.lignes.length : x.t === 'rangee' ? x.cellules.reduce((m, c) => m + compter(c), 0) : x.t === 'citation' ? compter(x.blocs) : 0), 0);

/** Sépare à la main ce que le HTML n'a pas marqué : l'en-tête d'un mail transféré, puis la signature. */
function decouperFin(blocs: BlocMail[], sortie: Sortie): BlocMail[] {
  let corps = blocs;
  const i = corps.findIndex((b) => b.t === 'p' && (/^(De|From)\s*:[\s\S]*\b(Envoy[ée]|Sent|Date)\s*:/i.test(texteDe(b.m)) || /^(Le|On)\s[\s\S]{5,120}(a écrit|wrote)\s*:\s*$/i.test(texteDe(b.m))));
  if (i >= 0) {
    const avant = i > 0 && corps[i - 1].t === 'trait' ? i - 1 : i;
    sortie.cite.unshift(...corps.slice(i));
    corps = corps.slice(0, avant);
  }
  // Un bloc cité tout à la fin est un ancien message, pas une citation au milieu d'une réponse.
  while (corps.length > 1 && corps[corps.length - 1].t === 'citation') {
    const b = corps[corps.length - 1] as Extract<BlocMail, { t: 'citation' }>;
    sortie.cite.unshift(...b.blocs);
    corps = corps.slice(0, -1);
  }
  if (sortie.signature.length) return sansSignatureRecopiee(corps, sortie.signature);
  // Une ligne par ligne de texte ; une image est courte, un tableau de données ne fait pas partie d'une signature.
  const places: { b: number; l: number }[] = [];
  const lignes: string[] = [];
  corps.forEach((b, n) => {
    if (b.t === 'p' || b.t === 'titre') texteDe(b.m).split('\n').forEach((x, l) => (places.push({ b: n, l }), lignes.push(x)));
    else {
      places.push({ b: n, l: 0 });
      lignes.push(b.t === 'images' ? 'image' : b.t === 'trait' ? '' : b.t === 'rangee' ? texteDeBlocs(b.cellules.flat()).replace(/\n/g, ' ') : 'x'.repeat(200));
    }
    places.push({ b: n, l: -1 });
    lignes.push('');
  });
  const k = indiceSignature(lignes, 2 * MAX_LIGNES_SIGNATURE);
  if (k <= 0) return corps;
  const { b: bb, l } = places[k];
  // La coupure tombe sur la ligne vide après un bloc : la signature commence au bloc suivant.
  const b = l < 0 ? bb + 1 : bb;
  const bloc = corps[b];
  if (l > 0 && bloc.t === 'p') {
    const [garde, part] = couperMorceaux(bloc.m, l);
    sortie.signature.push({ t: 'p', m: part }, ...corps.slice(b + 1));
    retirerDelimiteur(sortie);
    return [...corps.slice(0, b), { t: 'p', m: garde }];
  }
  sortie.signature.push(...corps.slice(b));
  retirerDelimiteur(sortie);
  return corps.slice(0, b);
}

const retirerDelimiteur = (s: Sortie) => {
  const p = s.signature[0];
  if (p?.t === 'p' && estDelimiteur(texteDe(p.m))) s.signature.shift();
};

function couperMorceaux(m: Morceau[], ligne: number): [Morceau[], Morceau[]] {
  const a: Morceau[] = [];
  const z: Morceau[] = [];
  let n = 0;
  for (const x of m) {
    const parts = x.v.split('\n');
    parts.forEach((p, i) => {
      if (i) n++;
      const cible = n < ligne ? a : z;
      const v = (i && n !== ligne && cible === a ? '\n' : i && n > ligne ? '\n' : '') + p;
      if (v) cible.push({ ...x, v });
    });
  }
  return [nettoyerMorceaux(a.map((x) => ({ ...x, v: x.v.replace(/\n/g, '\u2028') }))), nettoyerMorceaux(z.map((x) => ({ ...x, v: x.v.replace(/\n/g, '\u2028') })))];
}

const EN_TETE_CITE = /^(De|From)\s*:[\s\S]*?\b(Envoy[ée]|Sent|Date)\s*:/i;
const ECRIT_PAR = /^(Le|On)\s[\s\S]{5,160}(a écrit|wrote)\s*:$/i;

/** Le début du texte d'un noeud, sans parcourir tout ce qu'il contient. */
function debutTexte(n: Noeud, max: number): string {
  let t = '';
  const lire = (x: Noeud | string) => {
    if (t.length >= max) return;
    if (typeof x === 'string') t += x;
    else if (x.nom === 'br') t += ' ';
    else if (!SANS_RENDU.has(x.nom)) x.enfants.forEach(lire);
  };
  n.enfants.forEach(lire);
  return t.replace(/[\s ]+/g, ' ').trim();
}

/** Là où commence le message cité : le repère d'Outlook, ou l'en-tête « De : … Envoyé : … » de tout client. */
function debutCitation(n: Noeud): boolean {
  if (DEBUT_CITATION.test(marque(n))) return true;
  if (n.nom !== 'p' && n.nom !== 'div') return false;
  const t = debutTexte(n, 500);
  return EN_TETE_CITE.test(t) || (t.length <= 220 && ECRIT_PAR.test(t));
}

/** Retire de l'arbre le début du message cité et tout ce qui le suit, et le rend : ses signatures ne se mêlent pas à celle du mail. */
function couperApres(n: Noeud): (Noeud | string)[] {
  for (let i = 0; i < n.enfants.length; i++) {
    const e = n.enfants[i];
    if (typeof e === 'string') continue;
    if (debutCitation(e)) return n.enfants.splice(i);
    const dedans = couperApres(e);
    if (dedans.length) return [...dedans, ...n.enfants.splice(i + 1)];
  }
  return [];
}

/** Les classes que la feuille de style du mail masque. Celles des @media ne comptent pas : l'app n'est pas l'écran visé. */
export function classesCachees(html: string): Set<string> {
  const out = new Set<string>();
  const bas = html.toLowerCase();
  for (let de = bas.indexOf('<style'); de >= 0; de = bas.indexOf('<style', de + 6)) {
    const debut = bas.indexOf('>', de);
    if (debut < 0) break;
    const fin = bas.indexOf('</style', debut);
    const css = html.slice(debut + 1, fin < 0 ? undefined : fin).replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->/g, '');
    let i = 0;
    while (i < css.length) {
      const o = css.indexOf('{', i);
      if (o < 0) break;
      const selecteur = css.slice(i, o).trim();
      let prof = 1;
      let j = o + 1;
      while (j < css.length && prof) {
        if (css[j] === '{') prof++;
        else if (css[j] === '}') prof--;
        j++;
      }
      if (!selecteur.startsWith('@') && /(^|;|\s)(display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)/i.test(css.slice(o + 1, j - 1))) {
        for (const x of selecteur.split(',')) {
          const m = /^[a-z0-9]*\.([\w-]+)$/i.exec(x.trim());
          if (m) out.add(m[1].toLowerCase());
        }
      }
      i = j;
    }
    if (fin < 0) break;
  }
  return out;
}

function elaguer(n: Noeud, classes: Set<string>) {
  n.enfants = n.enfants.filter((e) => typeof e === 'string' || !(e.attrs.class ?? '').toLowerCase().split(/\s+/).some((c) => classes.has(c)));
  for (const e of n.enfants) if (typeof e !== 'string') elaguer(e, classes);
}

const cleDe = (b: BlocMail) => texteDeBlocs([b]).replace(/\s+/g, ' ').trim().toLowerCase();

/** Une signature ne dit pas deux fois la même chose : version bureau et version mobile, logo répété. */
function sansDoublons(blocs: BlocMail[]): BlocMail[] {
  const vus = new Set<string>();
  const nouveau = (k: string) => {
    if (vus.has(k)) return false;
    vus.add(k);
    return true;
  };
  return blocs.flatMap((b): BlocMail[] => {
    if (b.t === 'trait') return [b];
    if (b.t === 'images') {
      const items = b.items.filter((x) => nouveau(x.src));
      return items.length ? [{ ...b, items }] : [];
    }
    return nouveau(cleDe(b) || JSON.stringify(b)) ? [b] : [];
  });
}

/** Le corps finit parfois par le texte que la signature marquée redit : on ne le garde qu'une fois. */
function sansSignatureRecopiee(corps: BlocMail[], signature: BlocMail[]): BlocMail[] {
  const dans = new Set(signature.map(cleDe).filter(Boolean));
  let fin = corps.length;
  while (fin > 1 && dans.has(cleDe(corps[fin - 1]))) fin--;
  return corps.slice(0, fin);
}

/** Le corps d'un mail HTML, découpé pour l'écran. Null s'il n'y a rien de lisible : l'app garde alors le texte. */
export function htmlEnBlocs(html: string): CorpsRiche | null {
  if (!html || html.length > MAX_HTML) return null;
  try {
    const sortie: Sortie = { signature: [], cite: [] };
    const racine = arbreHtml(html);
    const cachees = classesCachees(html);
    if (cachees.size) elaguer(racine, cachees);
    const suite = couperApres(racine);
    if (suite.length) {
      const dedans: Sortie = { signature: [], cite: [] };
      sortie.cite.push(...versBlocs(suite, {}, dedans), ...dedans.signature, ...dedans.cite);
    }
    const brut = versBlocs(racine.enfants, {}, sortie);
    let blocs = decouperFin(brut, sortie);
    sortie.signature = sansDoublons(sortie.signature);
    // Un mail transféré sans un mot : le message transféré est le mail, on ne le replie pas.
    if (!blocs.length && sortie.cite.length) {
      blocs = sortie.cite;
      sortie.cite = [];
    }
    if (!blocs.length && !sortie.signature.length && !sortie.cite.length) return null;
    if (compter(blocs) + compter(sortie.signature) + compter(sortie.cite) > MAX_BLOCS) return null;
    return { blocs, signature: sortie.signature, cite: sortie.cite };
  } catch (e) {
    // Une imbrication sans fin ne doit pas empêcher de lire le mail : l'app garde alors le texte.
    console.error('Mail HTML illisible', (e as Error).message);
    return null;
  }
}

/** Le texte d'une suite de blocs : `liens` ajoute l'adresse des liens, inutile à voix haute. */
export function texteDeBlocs(blocs: BlocMail[], liens = false): string {
  return blocs
    .map((b): string => {
      switch (b.t) {
        case 'p':
        case 'titre':
          return texteDe(b.m, liens);
        case 'liste':
          return b.items.map((m) => `${liens ? '• ' : ''}${texteDe(m, liens)}`).join('\n');
        case 'table':
          return b.lignes.map((l) => l.map((c) => texteDe(c.m, liens)).filter(Boolean).join(liens ? ' | ' : ', ')).join('\n');
        case 'rangee':
          return b.cellules.map((c) => texteDeBlocs(c, liens)).join('\n');
        case 'citation':
          return texteDeBlocs(b.blocs, liens);
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Le mail entier en texte, pour le copilote et pour répondre. */
export const texteComplet = (c: CorpsRiche) => nettoyerTexte([c.blocs, c.signature, c.cite].map((b) => texteDeBlocs(b, true)).filter(Boolean).join('\n\n'));

export const enMailRiche = (c: CorpsRiche): MailRiche => ({ ...c, aLire: texteDeBlocs(c.blocs) });

/**
 * Un ancien message d'un fil, découpé comme le mail ouvert : sa signature à part, son message seul.
 * Ses images jointes ne sont pas chargées, et ce qu'il cite est déjà dans le fil.
 */
export function messageDuFil(html: string, riche?: boolean): { texte: string; message: string; riche?: MailRiche } | null {
  const c = htmlEnBlocs(html);
  if (!c) return null;
  return { texte: texteComplet(c), message: texteDeBlocs(c.blocs), ...(riche ? { riche: enMailRiche(poserImages({ ...c, cite: [] }, new Map())) } : {}) };
}

const visiter = (blocs: BlocMail[], f: (im: ImageMail) => void) => {
  for (const b of blocs) {
    if (b.t === 'images') b.items.forEach(f);
    else if (b.t === 'rangee') b.cellules.forEach((c) => visiter(c, f));
    else if (b.t === 'citation') visiter(b.blocs, f);
  }
};

const estCid = (src: string) => src.toLowerCase().startsWith('cid:');
/** Un identifiant d'image jointe, tel qu'il figure dans le HTML (« cid:a%40b ») ou dans la pièce jointe (« <a@b> »). */
export function normaliserCid(cid: string): string {
  const net = cid.trim().replace(/^<|>$/g, '');
  try {
    return decodeURIComponent(net).toLowerCase();
  } catch {
    return net.toLowerCase();
  }
}

/** Les images jointes au mail (« cid: ») que ce corps affiche. */
export function cidsDe(c: CorpsRiche): string[] {
  const out = new Set<string>();
  for (const blocs of [c.blocs, c.signature, c.cite]) visiter(blocs, (im) => estCid(im.src) && out.add(normaliserCid(im.src.slice(4))));
  return [...out];
}

const sansImagesVides = (blocs: BlocMail[]): BlocMail[] =>
  blocs.flatMap((b): BlocMail[] => {
    if (b.t === 'images') {
      const items = b.items.filter((x) => !estCid(x.src));
      return items.length ? [{ ...b, items }] : [];
    }
    if (b.t === 'rangee') {
      const cellules = b.cellules.map(sansImagesVides).filter((c) => c.length);
      return cellules.length ? [{ ...b, cellules }] : [];
    }
    if (b.t === 'citation') return [{ ...b, blocs: sansImagesVides(b.blocs) }];
    return [b];
  });

/** Remplace les « cid: » par les images fournies ; celles qui manquent disparaissent. Les images ne quittent jamais le serveur que dans cette réponse. */
export function poserImages(c: CorpsRiche, images: Map<string, string>): CorpsRiche {
  for (const blocs of [c.blocs, c.signature, c.cite]) {
    visiter(blocs, (im) => {
      if (!estCid(im.src)) return;
      const d = images.get(normaliserCid(im.src.slice(4)));
      if (d) im.src = d;
    });
  }
  return { blocs: sansImagesVides(c.blocs), signature: sansImagesVides(c.signature), cite: sansImagesVides(c.cite) };
}

/** Va chercher les images jointes que le corps affiche, dans une limite de poids : une image trop lourde disparaît, le mail reste léger. */
export async function remplirImages(c: CorpsRiche, lire: (cid: string) => Promise<ImageJointe | null> | ImageJointe | null): Promise<CorpsRiche> {
  const cids = cidsDe(c).slice(0, MAX_IMAGES);
  const lues = await Promise.all(cids.map(async (cid) => {
    try {
      return await lire(cid);
    } catch {
      return null;
    }
  }));
  const images = new Map<string, string>();
  let total = 0;
  cids.forEach((cid, i) => {
    const im = lues[i];
    if (!im?.base64 || !TYPES_IMAGE.test(im.type ?? '') || im.base64.length > MAX_IMAGE_B64 || total + im.base64.length > MAX_IMAGES_B64) return;
    total += im.base64.length;
    images.set(cid, `data:${(im.type ?? '').toLowerCase().split(';')[0]};base64,${im.base64.replace(/\s/g, '')}`);
  });
  return poserImages(c, images);
}

export type ImageJointe = { type?: string; base64: string };
const TYPES_IMAGE = /^image\/(png|jpe?g|gif|webp)\b/i;
export const MAX_IMAGES = 15;
/** En base64 : le poids réel est un tiers de moins. */
const MAX_IMAGE_B64 = 700_000;
const MAX_IMAGES_B64 = 3_000_000;
/** Le poids au-delà duquel une pièce jointe n'est même pas téléchargée. */
export const MAX_IMAGE_OCTETS = 520_000;
