/**
 * Tâches d'un projet, vues du serveur : même règle que l'app (me-mobile/src/lib/planning.ts, `tachesActives`).
 * Un plan importé peut compter des centaines de lignes : on ne rappelle ni les résumés (tâches qui ont des sous-tâches)
 * ni les tâches bloquées (une tâche précédente n'est pas finie), pour ne pas noyer le reste.
 */

export type TacheProjet = { id: string; statut: string; parent?: string; projet?: string; apres?: string[] };

/** Identifiants des tâches qui sont le parent d'une autre tâche. */
export function resumes(taches: Pick<TacheProjet, 'parent'>[]): Set<string> {
  const s = new Set<string>();
  for (const t of taches) if (t.parent) s.add(t.parent);
  return s;
}

/** Une tâche appartient à un projet qui existe encore (sinon c'est une tâche simple). */
export const estTacheDeProjet = (t: Pick<TacheProjet, 'projet'>, projets?: { id: string }[]) => !!t.projet && !!projets?.some((p) => p.id === t.projet);

/**
 * Tâches pas faites, jamais les résumés ni les tâches bloquées. Sans projet, c'est simplement « pas faites ».
 * Comme le planning de l'app, chaque projet se calcule seul : un lien ou un parent vers une tâche d'un autre projet,
 * ou vers une tâche simple, ne bloque rien.
 */
export function tachesActives<T extends TacheProjet>(e: { taches?: T[]; projets?: { id: string }[] }): T[] {
  const taches = e.taches || [];
  if (!taches.some((t) => estTacheDeProjet(t, e.projets))) return taches.filter((t) => t.statut !== 'fait');
  const bloquees = new Set<string>();
  for (const p of e.projets ?? []) {
    const duProjet = taches.filter((t) => t.projet === p.id);
    if (duProjet.length) for (const id of bloqueesDe(duProjet)) bloquees.add(id);
  }
  const parents = resumes(taches);
  return taches.filter((t) => t.statut !== 'fait' && !parents.has(t.id) && !bloquees.has(t.id));
}

/** Les tâches d'un projet bloquées par une tâche précédente pas finie (liens `apres`, les siens et ceux de ses parents). */
function bloqueesDe(taches: TacheProjet[]): Set<string> {
  const parNom = new Map(taches.map((t) => [t.id, t]));
  // Parent valide : présent dans la liste, sans boucle de parents.
  const parentDe = (id: string) => {
    const p = parNom.get(id)?.parent;
    if (!p || !parNom.has(p)) return undefined;
    for (let c: string | undefined = p, tours = 0; c && tours++ < 200; c = parNom.get(c)?.parent) if (c === id) return undefined;
    return p;
  };
  const enfants = new Map<string, string[]>();
  for (const t of taches) {
    const p = parentDe(t.id);
    if (p) (enfants.get(p) ?? enfants.set(p, []).get(p)!).push(t.id);
  }
  const feuillesDe = (id: string, vus = new Set<string>()): string[] => {
    if (vus.has(id)) return [];
    vus.add(id);
    const e2 = enfants.get(id);
    return e2?.length ? e2.flatMap((x) => feuillesDe(x, vus)) : [id];
  };
  const fait = (id: string): boolean => (enfants.has(id) ? feuillesDe(id).every((f) => parNom.get(f)?.statut === 'fait') : parNom.get(id)?.statut === 'fait');

  // Les tâches précédentes d'une feuille : les siennes et celles de ses parents, ramenées aux feuilles.
  const precedentes = new Map<string, Set<string>>();
  const feuilles = taches.filter((t) => !enfants.has(t.id));
  for (const f of feuilles) {
    const s = new Set<string>();
    for (let c: string | undefined = f.id, tours = 0; c && tours++ < 200; c = parentDe(c))
      for (const a of parNom.get(c)?.apres ?? []) if (a !== c && parNom.has(a)) for (const x of feuillesDe(a)) if (x !== f.id) s.add(x);
    precedentes.set(f.id, s);
  }
  // Une boucle de liens ne bloque personne (l'app l'ignore aussi) : on retire du calcul tout ce qui n'entre pas dans l'ordre.
  const entrants = new Map(feuilles.map((f) => [f.id, precedentes.get(f.id)!.size]));
  const file = feuilles.filter((f) => entrants.get(f.id) === 0).map((f) => f.id);
  for (let i = 0; i < file.length; i++)
    for (const f of feuilles)
      if (precedentes.get(f.id)!.has(file[i])) {
        entrants.set(f.id, entrants.get(f.id)! - 1);
        if (entrants.get(f.id) === 0) file.push(f.id);
      }
  const ordonnees = new Set(file);

  const bloquees = new Set<string>();
  for (const f of feuilles) {
    if (f.statut === 'fait' || !ordonnees.has(f.id)) continue;
    for (const a of precedentes.get(f.id) ?? []) if (!fait(a)) bloquees.add(f.id);
  }
  return bloquees;
}
