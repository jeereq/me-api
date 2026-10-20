/**
 * Calcul des rappels, repris de l'app (me-mobile/src/lib/reminders.ts) pour les envoyer depuis le serveur.
 * Tout est en heure locale de l'utilisateur, sous forme de texte : « AAAA-MM-JJ » et « AAAA-MM-JJTHH:MM ».
 */

export type Mode = 'passif' | 'normal' | 'agressif' | 'coach' | 'hebdo';
type Frequence = 'quotidien' | 'hebdo' | 'mensuel';
type Habitude = { id: string; nom: string; frequence: Frequence; jour: number | null; mode: Mode; coches: string[] };
type Relance = { id: string; contact: string; sujet: string; date: string; statut: string; mode: Mode };
type Tache = { id: string; titre: string; echeance: string | null; statut: string; mode: Mode };
export type EspaceRappels = { relances?: Relance[]; taches?: Tache[]; habitudes?: Habitude[] };
export type ConfigRappels = { routineHeure?: string; rappelSoir?: string; agressifJMoins?: number; modes?: Partial<Record<Mode, { actif?: boolean }>> };
export type Rappel = { quand: string; titre: string; corps: string; mode: Mode | 'briefing'; cle: string };

const pad = (n: number) => String(n).padStart(2, '0');
// Dates calculées en UTC : seules les chaînes comptent, le fuseau du serveur n'intervient pas.
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
function weekKey(s: string) {
  const t = parse(s);
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - y0.getTime()) / 864e5 + 1) / 7)}`;
}
const periodKey = (f: Frequence, s: string) => (f === 'mensuel' ? s.slice(0, 7) : f === 'hebdo' ? weekKey(s) : s);
function habitDue(h: Habitude, s: string) {
  const d = parse(s);
  if (h.frequence === 'hebdo') return d.getUTCDay() === (h.jour ?? 1);
  if (h.frequence === 'mensuel') {
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return d.getUTCDate() === Math.min(h.jour || 1, last);
  }
  return true;
}
function pastDue(h: Habitude, s: string) {
  const d = parse(s);
  if (h.frequence === 'mensuel') return d.getUTCDate() > (h.jour || 1);
  if (h.frequence === 'hebdo') return (d.getUTCDay() || 7) > ((h.jour ?? 1) || 7);
  return false;
}
const doneIn = (h: Habitude, s: string) => (h.coches || []).some((c) => periodKey(h.frequence, c) === periodKey(h.frequence, s));

/** Rappels d'une journée (heure locale), avec les mêmes règles que les notifications du téléphone. */
export function rappelsDuJour(e: EspaceRappels, c: ConfigRappels, jour: string): Rappel[] {
  const out: Rappel[] = [];
  const actif = (m: Mode) => c.modes?.[m]?.actif !== false;
  const matin = c.routineHeure || '07:00';
  const soir = c.rappelSoir || '19:00';
  const jMoins = c.agressifJMoins || 3;
  const add = (heure: string, titre: string, corps: string, mode: Rappel['mode'], id: string) =>
    out.push({ quand: `${jour}T${heure}`, titre, corps, mode, cle: `${jour}T${heure}|${id}|${titre}` });

  add(matin, 'Ton briefing me est prêt', 'Agenda, relances, tâches et habitudes du jour.', 'briefing', 'briefing');

  const dates = [
    ...(e.relances || []).filter((r) => r.statut === 'a_faire' && r.date).map((r) => ({ id: r.id, titre: `Relancer ${r.contact}`, detail: r.sujet, date: r.date, mode: r.mode })),
    ...(e.taches || []).filter((t) => t.statut !== 'fait' && t.echeance).map((t) => ({ id: t.id, titre: t.titre, detail: 'Tâche à faire', date: t.echeance as string, mode: t.mode })),
  ];
  for (const x of dates) {
    if (!actif(x.mode)) continue;
    if ((x.mode === 'normal' || x.mode === 'coach') && x.date === jour) add('09:00', x.titre, x.detail, x.mode, x.id);
    if (x.mode === 'agressif') {
      if (x.date === jour) {
        add(matin, `Aujourd'hui : ${x.titre}`, x.detail, x.mode, x.id);
        add(soir, `Pas encore fait : ${x.titre}`, x.detail, x.mode, x.id);
      } else if (jour > x.date) add('09:00', `En retard : ${x.titre}`, `Prévu le ${x.date}. ${x.detail}`, x.mode, x.id);
      else for (const j of [jMoins, 1]) if (addDays(jour, j) === x.date) add('09:00', `Dans ${j} j : ${x.titre}`, x.detail, x.mode, x.id);
    }
  }

  const coach: string[] = [];
  for (const h of e.habitudes || []) {
    if (!actif(h.mode) || h.mode === 'passif' || doneIn(h, jour)) continue;
    const due = habitDue(h, jour);
    if (h.mode === 'normal' && due) add('09:00', h.nom, "C'est le jour.", h.mode, h.id);
    if (h.mode === 'agressif') {
      if (due) {
        add(matin, `Aujourd'hui : ${h.nom}`, 'À faire avant ce soir.', h.mode, h.id);
        add(soir, `Pas encore fait : ${h.nom}`, 'Coche-le dans me dès que c’est fait.', h.mode, h.id);
      } else if (h.frequence !== 'quotidien' && pastDue(h, jour)) add('09:00', `En retard : ${h.nom}`, 'Toujours pas coché pour cette période.', h.mode, h.id);
      else for (const j of [jMoins, 1]) if (h.frequence !== 'quotidien' && habitDue(h, addDays(jour, j))) add('09:00', `Dans ${j} j : ${h.nom}`, 'Prépare-toi.', h.mode, h.id);
    }
    if (h.mode === 'coach' && due) coach.push(h.nom);
  }
  if (coach.length) add(soir, 'Coach me', `${coach.length > 1 ? `${coach.length} habitudes` : '1 habitude'} à tenir aujourd'hui : ${coach.slice(0, 3).join(', ')}. Ne casse pas ta série.`, 'coach', 'coach');

  // Bilan hebdo : le dimanche soir, ce qui est suivi en mode « bilan hebdo » pour la semaine à venir.
  if (parse(jour).getUTCDay() === 0) {
    const hebdo = [
      ...dates.filter((x) => x.mode === 'hebdo' && x.date >= jour && x.date <= addDays(jour, 7)).map((x) => x.titre),
      ...(e.habitudes || []).filter((h) => h.mode === 'hebdo' && Array.from({ length: 7 }, (_, i) => addDays(jour, i + 1)).some((d) => habitDue(h, d))).map((h) => h.nom),
    ];
    if (hebdo.length && actif('hebdo')) add(soir, 'Ton bilan de la semaine', `${hebdo.length} élément(s) à suivre : ${hebdo.slice(0, 4).join(', ')}.`, 'hebdo', 'hebdo');
  }
  return out;
}
