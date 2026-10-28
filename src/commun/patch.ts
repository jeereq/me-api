/**
 * Synchro par différences : au lieu de renvoyer tout l'espace à chaque enregistrement, l'appareil envoie seulement
 * ce qui a changé depuis la dernière version confirmée par le serveur (une dépense ajoutée, une relance modifiée…).
 *
 * - `differences(base, local)` : la liste des opérations qui font passer de `base` à `local` ;
 * - `appliquer(doc, operations)` : les rejoue sur le document du serveur.
 * Règle tenue par les tests : `appliquer(base, differences(base, local))` redonne `local`.
 *
 * Les listes d'éléments à identifiant (relances, tâches, dépenses…) se modifient élément par élément : seuls les éléments
 * ajoutés ou changés partent, avec les identifiants retirés, et l'ordre seulement s'il a changé autrement que par des ajouts
 * à la fin. Le reste se remplace valeur par valeur, à son chemin (`["finances", "budgets"]`).
 *
 * Ce fichier n'importe rien : il sert tel quel au serveur et à l'app.
 */

type Objet = Record<string, unknown>;
export type Chemin = string[];
export type Operation =
  /** Remplace (ou crée) la valeur à ce chemin. */
  | { op: 'mettre'; chemin: Chemin; valeur: unknown }
  /** Retire la clé à ce chemin. */
  | { op: 'retirer'; chemin: Chemin }
  /** Liste d'éléments à identifiant : éléments ajoutés ou changés, identifiants retirés, nouvel ordre s'il a changé. */
  | { op: 'liste'; chemin: Chemin; maj?: Objet[]; retirer?: string[]; ordre?: string[] };

/** Une opération que le document ne permet pas (chemin qui traverse une valeur simple, liste sans identifiants…). */
export class ErreurDifferences extends Error {}

const estObjet = (v: unknown): v is Objet => typeof v === 'object' && v !== null && !Array.isArray(v);
const possede = (o: Objet, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** Une clé à `undefined` compte comme absente : après un aller-retour JSON, elle aurait disparu. */
const defini = (o: Objet, k: string) => possede(o, k) && o[k] !== undefined;
const cles = (o: Objet) => Object.keys(o).filter((k) => o[k] !== undefined);
/** Copie profonde d'une valeur JSON. */
const copie = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
/** Clés qui toucheraient au prototype des objets : jamais acceptées dans un chemin. */
const INTERDITES = new Set(['__proto__', 'constructor', 'prototype']);

/** Égalité profonde, sans tenir compte de l'ordre des clés (la base JSON du serveur ne le garde pas). */
export function egal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => egal(x, b[i]));
  if (estObjet(a) && estObjet(b)) {
    const ka = cles(a);
    return ka.length === cles(b).length && ka.every((k) => defini(b, k) && egal(a[k], b[k]));
  }
  return false;
}

/** Liste dont chaque élément est un objet à identifiant texte, sans doublon : elle peut se modifier élément par élément. */
function listeId(v: unknown): v is Objet[] {
  if (!Array.isArray(v)) return false;
  const vus = new Set<string>();
  for (const x of v) {
    if (!estObjet(x) || typeof x.id !== 'string' || vus.has(x.id)) return false;
    vus.add(x.id);
  }
  return true;
}

/** L'ordre des identifiants qu'on obtient en appliquant `maj` et `retirer` à `base` : les ajouts vont à la fin. */
function ordreObtenu(base: Objet[], local: Objet[], retires: Set<string>): string[] {
  const deBase = new Set(base.map((x) => x.id as string));
  return [...base.map((x) => x.id as string).filter((id) => !retires.has(id)), ...local.map((x) => x.id as string).filter((id) => !deBase.has(id))];
}

/** Les opérations qui font passer de `base` à `local`. Aucune si les deux sont égaux. */
export function differences(base: unknown, local: unknown, chemin: Chemin = []): Operation[] {
  if (egal(base, local)) return [];
  if (estObjet(base) && estObjet(local)) {
    const ops: Operation[] = [];
    for (const k of new Set([...cles(base), ...cles(local)])) {
      if (!defini(local, k)) ops.push({ op: 'retirer', chemin: [...chemin, k] });
      else if (!defini(base, k)) ops.push({ op: 'mettre', chemin: [...chemin, k], valeur: local[k] });
      else ops.push(...differences(base[k], local[k], [...chemin, k]));
    }
    return ops;
  }
  if (listeId(base) && listeId(local)) {
    const avant = new Map(base.map((x) => [x.id as string, x]));
    const ids = new Set(local.map((x) => x.id as string));
    const maj = local.filter((x) => !egal(avant.get(x.id as string), x));
    const retirer = base.map((x) => x.id as string).filter((id) => !ids.has(id));
    const voulu = local.map((x) => x.id as string);
    const obtenu = ordreObtenu(base, local, new Set(retirer));
    const op: Operation = { op: 'liste', chemin };
    if (maj.length) op.maj = maj;
    if (retirer.length) op.retirer = retirer;
    if (!egal(obtenu, voulu)) op.ordre = voulu;
    return [op];
  }
  return [{ op: 'mettre', chemin, valeur: local }];
}

function verifierChemin(chemin: Chemin) {
  if (!Array.isArray(chemin) || chemin.some((k) => typeof k !== 'string' || INTERDITES.has(k))) throw new ErreurDifferences('Chemin invalide.');
}

/** L'objet qui contient la dernière clé du chemin, créé au besoin. */
function parent(doc: Objet, chemin: Chemin): Objet {
  let o = doc;
  for (const k of chemin.slice(0, -1)) {
    if (!defini(o, k)) o[k] = {};
    const suivant = o[k];
    if (!estObjet(suivant)) throw new ErreurDifferences(`« ${chemin.join('.')} » traverse une valeur qui n'est pas un objet.`);
    o = suivant;
  }
  return o;
}

function appliquerListe(actuelle: unknown, op: Extract<Operation, { op: 'liste' }>): Objet[] {
  const liste = actuelle === undefined ? [] : actuelle;
  if (!listeId(liste)) throw new ErreurDifferences(`« ${op.chemin.join('.')} » n'est pas une liste d'éléments à identifiant.`);
  const retires = new Set(op.retirer ?? []);
  const sortie = liste.filter((x) => !retires.has(x.id as string));
  const rang = new Map(sortie.map((x, i) => [x.id as string, i]));
  for (const x of op.maj ?? []) {
    if (!estObjet(x) || typeof x.id !== 'string') throw new ErreurDifferences(`« ${op.chemin.join('.')} » : élément sans identifiant.`);
    const i = rang.get(x.id);
    if (i === undefined) {
      rang.set(x.id, sortie.length);
      sortie.push(x);
    } else sortie[i] = x;
  }
  if (!op.ordre) return sortie;
  const parId = new Map(sortie.map((x) => [x.id as string, x]));
  const rangees = op.ordre.filter((id) => parId.has(id)).map((id) => parId.get(id)!);
  const places = new Set(rangees.map((x) => x.id as string));
  // Un élément que l'ordre ne cite pas (ajouté par un autre appareil entre-temps) n'est jamais perdu : il passe à la fin.
  return [...rangees, ...sortie.filter((x) => !places.has(x.id as string))];
}

/** Rejoue les opérations sur une copie de `doc` et renvoie le résultat. `doc` n'est pas modifié. */
export function appliquer(doc: unknown, operations: Operation[]): unknown {
  let racine: unknown = copie(doc);
  for (const op of operations) {
    verifierChemin(op.chemin);
    if (!op.chemin.length) {
      if (op.op === 'mettre') racine = copie(op.valeur);
      else if (op.op === 'liste') racine = appliquerListe(racine, op);
      else throw new ErreurDifferences('Impossible de retirer tout le document.');
      continue;
    }
    if (!estObjet(racine)) throw new ErreurDifferences("Le document n'est pas un objet.");
    const o = parent(racine, op.chemin);
    const k = op.chemin[op.chemin.length - 1];
    if (op.op === 'mettre') o[k] = copie(op.valeur);
    else if (op.op === 'retirer') delete o[k];
    else o[k] = appliquerListe(o[k], op);
  }
  return racine;
}
