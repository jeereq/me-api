/**
 * Modes de rappel configurables.
 *
 * Chaque mode (passif, normal, agressif, coach, bilan hebdo) est décrit par quelques règles que l'admin peut changer
 * dans la configuration : à quelles heures rappeler le jour J, combien de jours avant, si l'on insiste après l'échéance,
 * s'il faut un message du soir qui regroupe les habitudes, et un éventuel bilan de la semaine.
 * Une règle absente de la configuration prend la valeur d'origine, donc les anciennes configurations continuent de marcher.
 *
 * Code commun (voir src/commun/README.md) : l'app en reçoit une copie exacte, vérifiée par sa CI.
 */
export type Mode = 'passif' | 'normal' | 'agressif' | 'coach' | 'hebdo';

export type ReglesMode = {
  /** Heures du rappel le jour J : « matin » (briefing), « soir » (rappel du soir) ou « HH:MM ». Deux heures ou plus : on insiste. */
  jourJ: string[];
  /** Rappels à l'avance, en jours avant l'échéance (ex. [3, 1]). */
  avant: number[];
  /** Un rappel chaque jour après l'échéance tant que ce n'est pas fait. */
  retard: boolean;
  /** Heure des rappels « à l'avance » et « en retard ». */
  heure: string;
  /** Les habitudes du jour sont regroupées en un seul message le soir, au lieu d'un rappel chacune. */
  resume: boolean;
  /** Bilan de la semaine : jour (0 = dimanche … 6 = samedi) et heure (« matin », « soir » ou « HH:MM »). Null : pas de bilan. */
  bilan: { jour: number; heure: string } | null;
};
export type ModeConfig = { actif?: boolean; desc?: string } & Partial<ReglesMode>;
export type ConfigModes = { agressifJMoins?: number; modes?: Partial<Record<Mode, ModeConfig>> };

export const MODES_LISTE: Mode[] = ['passif', 'normal', 'agressif', 'coach', 'hebdo'];
export const JOURS_SEMAINE = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

const base: ReglesMode = { jourJ: [], avant: [], retard: false, heure: '09:00', resume: false, bilan: null };
export const REGLES_DEFAUT: Record<Mode, ReglesMode> = {
  passif: { ...base },
  normal: { ...base, jourJ: ['09:00'] },
  agressif: { ...base, jourJ: ['matin', 'soir'], avant: [3, 1], retard: true },
  coach: { ...base, jourJ: ['09:00'], resume: true },
  hebdo: { ...base, bilan: { jour: 0, heure: 'soir' } },
};

const HEURE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const normaliserHeure = (s: string) => {
  const m = HEURE.exec(s.trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};
/** Une heure valide : « matin », « soir » ou « HH:MM » ; null sinon. */
export const lireHeure = (s: unknown): string | null => {
  if (typeof s !== 'string') return null;
  const t = s.trim().toLowerCase();
  return t === 'matin' || t === 'soir' ? t : normaliserHeure(t);
};
/** « matin, 12:30 soir » → ['matin', '12:30', 'soir'] (sans doublon, dans l'ordre saisi). */
export function lireHeures(texte: string): string[] {
  const vues = new Set<string>();
  for (const part of texte.split(/[\s,;]+/)) {
    const h = lireHeure(part.replace(/^(\d{1,2})h(\d{2})?$/i, (_, hh, mm) => `${hh}:${mm || '00'}`));
    if (h) vues.add(h);
  }
  return [...vues];
}
/** « 3, 1 » → [3, 1] (jours entiers de 1 à 30, sans doublon, du plus loin au plus proche). */
export function lireJours(texte: string): number[] {
  const nombres = texte.split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 30);
  return [...new Set(nombres)].sort((a, b) => b - a);
}

/** Heure réelle (« HH:MM ») d'une valeur de règle, selon les heures du briefing du matin et du rappel du soir. */
export function heureDe(h: string, matin: string, soir: string): string {
  return h === 'matin' ? matin : h === 'soir' ? soir : h;
}

/** Les règles d'un mode : celles de la configuration, complétées par les valeurs d'origine. */
export function reglesDuMode(c: ConfigModes | undefined, mode: Mode): ReglesMode {
  const d = REGLES_DEFAUT[mode];
  const m = c?.modes?.[mode] ?? {};
  const jourJ = Array.isArray(m.jourJ) ? m.jourJ.map(lireHeure).filter((x): x is string => !!x) : d.jourJ;
  const avantDefaut = mode === 'agressif' && c?.agressifJMoins ? [c.agressifJMoins, 1] : d.avant;
  const avant = Array.isArray(m.avant) ? m.avant.filter((n) => Number.isInteger(n) && n >= 1 && n <= 30) : avantDefaut;
  const bilan = m.bilan === null ? null : m.bilan && Number.isInteger(m.bilan.jour) && m.bilan.jour >= 0 && m.bilan.jour <= 6 && lireHeure(m.bilan.heure) ? { jour: m.bilan.jour, heure: lireHeure(m.bilan.heure)! } : d.bilan;
  return { jourJ, avant, retard: typeof m.retard === 'boolean' ? m.retard : d.retard, heure: (typeof m.heure === 'string' && normaliserHeure(m.heure)) || d.heure, resume: typeof m.resume === 'boolean' ? m.resume : d.resume, bilan };
}

const nomHeure = (h: string, matin: string, soir: string) => {
  const reel = heureDe(h, matin, soir).replace(/^0/, '').replace(':00', ' h').replace(':', ' h ');
  return h === 'matin' ? `le matin (${reel})` : h === 'soir' ? `le soir (${reel})` : `à ${reel}`;
};
const liste = (t: string[]) => (t.length <= 1 ? t.join('') : `${t.slice(0, -1).join(', ')} et ${t[t.length - 1]}`);

/** Ce que fait un mode, en une phrase lisible : affichée dans la configuration pour que l'admin voie l'effet de ses réglages. */
export function decrireMode(r: ReglesMode, matin: string, soir: string): string {
  const morceaux: string[] = [];
  if (r.jourJ.length === 1) morceaux.push(`un rappel le jour J ${nomHeure(r.jourJ[0], matin, soir)}`);
  else if (r.jourJ.length > 1) morceaux.push(`des rappels le jour J ${liste(r.jourJ.map((h) => nomHeure(h, matin, soir)))}`);
  const h = heureDe(r.heure, matin, soir).replace(/^0/, '').replace(':00', ' h').replace(':', ' h ');
  if (r.avant.length) morceaux.push(`un rappel ${liste(r.avant.map((j) => `${j} j`))} avant l'échéance`);
  if (r.retard) morceaux.push('un rappel chaque jour de retard');
  if (r.resume) morceaux.push(`un message du soir (${soir.replace(/^0/, '').replace(':00', ' h').replace(':', ' h ')}) qui regroupe les habitudes du jour`);
  if (r.bilan) morceaux.push(`un bilan de la semaine le ${JOURS_SEMAINE[r.bilan.jour]} ${nomHeure(r.bilan.heure, matin, soir)}`);
  const precision = r.avant.length || r.retard ? ` Les rappels à l'avance et en retard partent à ${h}.` : '';
  return morceaux.length ? `Envoie ${liste(morceaux)}.${precision}` : 'Aucune notification : visible seulement dans l’app et dans le briefing du matin.';
}
