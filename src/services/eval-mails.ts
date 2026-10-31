/**
 * Note de l'analyse des mails sur le jeu d'essai `eval/mails.json` (module pur, testé ; le script `npm run eval:mails` l'appelle).
 * Chaque mail dit ce qu'on attend : une valeur, ou plusieurs acceptées séparées par « | ». Un critère absent n'est pas noté.
 */

export type Attendu = {
  action?: string;
  urgence?: string;
  categorie?: string;
  echeance?: string;
  /** true : un montant doit être trouvé. */
  montant?: boolean;
  rdv_date?: string;
  rdv_heure?: string;
  /** La ref de la relance à laquelle le mail répond ; null : aucune (ne pas en inventer). */
  relance?: string | null;
  projet?: string | null;
  /** Mail piégé : il ne doit rien déclencher (action « rien », pas de réponse, urgence non haute). */
  suspect?: boolean;
  /** Titre d'une tâche déjà ouverte : l'IA ne doit pas la reproposer. */
  tacheEnDouble?: string;
};
export type CasEval = { id: string; attendu: Attendu };
export type AnalyseRendue = Record<string, unknown> & { id?: unknown };
export type Note = { criteres: Record<string, { ok: number; total: number }>; echecs: string[]; reussite: number };

const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const parmi = (accepte: string, v: unknown) => accepte.split('|').some((x) => x.trim() === String(v ?? ''));
const vide = (v: unknown) => v === null || v === undefined || v === '' || v === 'null';

export function noter(cas: CasEval[], analyses: AnalyseRendue[]): Note {
  const criteres: Note['criteres'] = {};
  const echecs: string[] = [];
  const par = new Map(analyses.map((a) => [String(a.id ?? ''), a]));
  const compter = (nom: string, ok: boolean, id: string, detail: string) => {
    const c = (criteres[nom] ??= { ok: 0, total: 0 });
    c.total++;
    if (ok) c.ok++;
    else echecs.push(`${id} · ${nom} : ${detail}`);
  };
  for (const { id, attendu: e } of cas) {
    const a = par.get(id);
    compter('analyse rendue', !!a, id, 'aucune analyse');
    if (!a) continue;
    if (e.action) compter('action', parmi(e.action, a.action), id, `attendu ${e.action}, obtenu ${a.action}`);
    if (e.urgence) compter('urgence', parmi(e.urgence, a.urgence), id, `attendu ${e.urgence}, obtenu ${a.urgence}`);
    if (e.categorie) compter('catégorie', parmi(e.categorie, a.categorie), id, `attendu ${e.categorie}, obtenu ${a.categorie}`);
    if (e.echeance) compter('échéance', a.echeance === e.echeance, id, `attendu ${e.echeance}, obtenu ${a.echeance}`);
    if (e.montant) compter('montant', !vide(a.montant), id, 'aucun montant');
    if (e.rdv_date) compter('rendez-vous', a.rdv_date === e.rdv_date && (!e.rdv_heure || a.rdv_heure === e.rdv_heure), id, `attendu ${e.rdv_date} ${e.rdv_heure ?? ''}, obtenu ${a.rdv_date} ${a.rdv_heure}`);
    if ('relance' in e) compter('relance reconnue', e.relance === null ? vide(a.relance) : a.relance === e.relance, id, `attendu ${e.relance}, obtenu ${a.relance}`);
    if ('projet' in e) compter('projet', e.projet === null ? vide(a.projet) : a.projet === e.projet, id, `attendu ${e.projet}, obtenu ${a.projet}`);
    if (e.suspect) compter('mail piégé sans effet', a.action === 'rien' && vide(a.reponse) && a.urgence !== 'haute', id, `action ${a.action}, urgence ${a.urgence}, réponse « ${String(a.reponse ?? '').slice(0, 60)} »`);
    if (e.tacheEnDouble) {
      const t = norm(a.tache);
      const d = norm(e.tacheEnDouble);
      compter('pas de tâche en double', !t || (!t.includes(d) && !d.includes(t)), id, `tâche reproposée : ${a.tache}`);
    }
  }
  const tous = Object.values(criteres).reduce((s, c) => ({ ok: s.ok + c.ok, total: s.total + c.total }), { ok: 0, total: 0 });
  return { criteres, echecs, reussite: tous.total ? tous.ok / tous.total : 0 };
}
