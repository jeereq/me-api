/**
 * Jours sous forme de texte « AAAA-MM-JJ », calculés en UTC : seules les chaînes comptent, le fuseau de la machine n'intervient pas.
 * Mêmes règles que l'app (me-mobile/src/lib/dates.ts) pour les habitudes : jour prévu, retard, période cochée.
 */

export type Frequence = 'quotidien' | 'hebdo' | 'mensuel';
export type HabitudeJours = { frequence: Frequence; jour: number | null; mode: string; coches: string[] };

const pad = (n: number) => String(n).padStart(2, '0');
export const parse = (s: string) => new Date(`${s}T00:00:00Z`);
export const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
export function weekKey(s: string) {
  const t = parse(s);
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - y0.getTime()) / 864e5 + 1) / 7)}`;
}
export const periodKey = (f: Frequence, s: string) => (f === 'mensuel' ? s.slice(0, 7) : f === 'hebdo' ? weekKey(s) : s);
export function habitDue(h: HabitudeJours, s: string) {
  const d = parse(s);
  if (h.frequence === 'hebdo') return d.getUTCDay() === (h.jour ?? 1);
  if (h.frequence === 'mensuel') {
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return d.getUTCDate() === Math.min(h.jour || 1, last);
  }
  return true;
}
export function pastDue(h: HabitudeJours, s: string) {
  const d = parse(s);
  if (h.frequence === 'mensuel') return d.getUTCDate() > (h.jour || 1);
  if (h.frequence === 'hebdo') return (d.getUTCDay() || 7) > ((h.jour ?? 1) || 7);
  return false;
}
export const doneIn = (h: HabitudeJours, s: string) => (h.coches || []).some((c) => periodKey(h.frequence, c) === periodKey(h.frequence, s));
export const habitToday = (h: HabitudeJours, s: string) => habitDue(h, s) || (!doneIn(h, s) && h.frequence !== 'quotidien' && h.mode === 'agressif' && pastDue(h, s));
