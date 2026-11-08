/**
 * Lire un tableur joint à un mail (CSV ou Excel .xlsx) pour en montrer les données dans l'app.
 * Rien d'externe : un .xlsx est une archive ZIP de fichiers XML, lue ici avec zlib.
 */
import { inflateRawSync } from 'node:zlib';

export type Tableau = { colonnes: string[]; lignes: string[][]; totalLignes: number; feuille: string | null };

export const MAX_LIGNES = 200;
export const MAX_COLONNES = 20;
const MAX_CELLULE = 200;
/** Une archive qui se déplie au-delà est refusée : rien ne doit remplir la mémoire du serveur. */
const MAX_DEPLIE = 30 * 1024 * 1024;

const propre = (v: string) => v.replace(/\s+/g, ' ').trim().slice(0, MAX_CELLULE);

/** La première ligne devient l'en-tête quand elle ne contient que du texte, sans chiffre seul. */
function mettreEnForme(brut: string[][], feuille: string | null): Tableau | null {
  const pleines = brut.map((l) => l.map(propre)).filter((l) => l.some((c) => c));
  if (!pleines.length) return null;
  const largeur = Math.min(MAX_COLONNES, Math.max(...pleines.map((l) => l.length)));
  const egales = pleines.map((l) => Array.from({ length: largeur }, (_, i) => l[i] ?? ''));
  const entete = egales[0].every((c) => c && !/^-?[\d\s.,]+$/.test(c));
  const lettres = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
  const colonnes = entete ? egales[0] : egales[0].map((_, i) => lettres(i));
  const lignes = entete ? egales.slice(1) : egales;
  return { colonnes, lignes: lignes.slice(0, MAX_LIGNES), totalLignes: lignes.length, feuille };
}

/** CSV : séparateur deviné (virgule, point-virgule ou tabulation), guillemets respectés. */
export function lireCsv(texte: string): Tableau | null {
  const t = texte.replace(/^﻿/, '');
  const premiere = t.split(/\r?\n/, 1)[0] ?? '';
  const sep = [';', '\t', ','].map((s) => ({ s, n: premiere.split(s).length })).sort((a, b) => b.n - a.n)[0].s;
  const lignes: string[][] = [];
  let ligne: string[] = [];
  let cellule = '';
  let guillemets = false;
  for (let i = 0; i < t.length && lignes.length <= MAX_LIGNES + 1; i++) {
    const ch = t[i];
    if (guillemets) {
      if (ch === '"' && t[i + 1] === '"') {
        cellule += '"';
        i++;
      } else if (ch === '"') guillemets = false;
      else cellule += ch;
    } else if (ch === '"') guillemets = true;
    else if (ch === sep) {
      ligne.push(cellule);
      cellule = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      ligne.push(cellule);
      lignes.push(ligne);
      ligne = [];
      cellule = '';
    } else cellule += ch;
  }
  if (cellule || ligne.length) lignes.push([...ligne, cellule]);
  const total = t.split(/\r?\n/).filter((l) => l.trim()).length;
  const tab = mettreEnForme(lignes, null);
  return tab && { ...tab, totalLignes: Math.max(tab.totalLignes, total - (tab.colonnes[0] === 'A' ? 0 : 1)) };
}

/** Les fichiers d'une archive ZIP, dépliés à la demande. */
function lireZip(octets: Buffer) {
  let fin = -1;
  for (let i = octets.length - 22; i >= Math.max(0, octets.length - 65_557); i--)
    if (octets.readUInt32LE(i) === 0x06054b50) {
      fin = i;
      break;
    }
  if (fin < 0) throw new Error('Archive illisible');
  const nombre = octets.readUInt16LE(fin + 10);
  let p = octets.readUInt32LE(fin + 16);
  const fichiers = new Map<string, () => Buffer>();
  for (let n = 0; n < nombre; n++) {
    if (octets.readUInt32LE(p) !== 0x02014b50) throw new Error('Archive illisible');
    const methode = octets.readUInt16LE(p + 10);
    const taille = octets.readUInt32LE(p + 20);
    const longNom = octets.readUInt16LE(p + 28);
    const longExtra = octets.readUInt16LE(p + 30);
    const longComm = octets.readUInt16LE(p + 32);
    const local = octets.readUInt32LE(p + 42);
    const nom = octets.subarray(p + 46, p + 46 + longNom).toString('utf8');
    fichiers.set(nom, () => {
      const debut = local + 30 + octets.readUInt16LE(local + 26) + octets.readUInt16LE(local + 28);
      const donnees = octets.subarray(debut, debut + taille);
      if (methode === 0) return donnees;
      if (methode === 8) return inflateRawSync(donnees, { maxOutputLength: MAX_DEPLIE });
      throw new Error('Compression inconnue');
    });
    p += 46 + longNom + longExtra + longComm;
  }
  return fichiers;
}

const XML = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
const textes = (bloc: string) => [...bloc.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => XML(m[1])).join('');
const colonne = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** Excel .xlsx : la première feuille, valeurs telles qu'enregistrées (une date Excel reste un nombre de jours). */
export function lireXlsx(octets: Buffer): Tableau | null {
  const zip = lireZip(octets);
  const lire = (nom: string) => zip.get(nom)?.().toString('utf8');
  const partages = [...(lire('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textes(m[1]));
  const classeur = lire('xl/workbook.xml') ?? '';
  const balise = /<sheet\b[^>]*>/.exec(classeur)?.[0] ?? '';
  const nomFeuille = /\bname="([^"]*)"/.exec(balise)?.[1] ?? null;
  const rid = /\br:id="([^"]+)"/.exec(balise)?.[1];
  const liens = lire('xl/_rels/workbook.xml.rels') ?? '';
  const relation = rid ? [...liens.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((b) => b.includes(`Id="${rid}"`)) : undefined;
  const cible = relation ? /\bTarget="([^"]+)"/.exec(relation)?.[1] : undefined;
  const chemin = cible ? (cible.startsWith('/') ? cible.slice(1) : `xl/${cible}`) : 'xl/worksheets/sheet1.xml';
  const feuille = lire(chemin) ?? lire('xl/worksheets/sheet1.xml');
  if (!feuille) return null;
  const lignes: string[][] = [];
  for (const r of feuille.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (lignes.length > MAX_LIGNES + 1) break;
    const l: string[] = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const i = ref ? colonne(ref) : l.length;
      if (i >= MAX_COLONNES) continue;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? '')?.[1];
      l[i] = type === 's' ? (partages[Number(v)] ?? '') : type === 'inlineStr' ? textes(c[2] ?? '') : type === 'b' ? (v === '1' ? 'VRAI' : 'FAUX') : XML(v ?? '');
    }
    lignes.push(Array.from(l, (x) => x ?? ''));
  }
  const total = (feuille.match(/<row\b/g) ?? []).length;
  const tab = mettreEnForme(lignes, nomFeuille ? XML(nomFeuille) : null);
  return tab && { ...tab, totalLignes: Math.max(tab.totalLignes, total - (tab.colonnes[0] === 'A' ? 0 : 1)) };
}

/** Le tableau en texte pour l'IA : l'en-tête et les premières lignes, séparés par des tabulations. */
export function tableauEnTexte(t: Tableau, max = 80) {
  return [t.colonnes, ...t.lignes.slice(0, max)].map((l) => l.join('\t')).join('\n');
}
