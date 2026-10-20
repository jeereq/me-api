import { alertesFinances, type FinancesRappels } from './previsions.js';

/**
 * Calcul des rappels, repris de l'app (me-mobile/src/lib/reminders.ts) pour les envoyer depuis le serveur.
 * Tout est en heure locale de l'utilisateur, sous forme de texte : « AAAA-MM-JJ » et « AAAA-MM-JJTHH:MM ».
 */

export type Mode = 'passif' | 'normal' | 'agressif' | 'coach' | 'hebdo';
type Frequence = 'quotidien' | 'hebdo' | 'mensuel';
type Habitude = { id: string; nom: string; frequence: Frequence; jour: number | null; mode: Mode; coches: string[] };
type Relance = { id: string; contact: string; sujet: string; date: string; statut: string; mode: Mode; reponduLe?: string };
type Tache = { id: string; titre: string; echeance: string | null; statut: string; mode: Mode; priorite?: string; faitLe?: string | null };
type Jeu = { gains?: Record<string, { d: string; p: number }>; joursSauves?: string[]; jokers?: number };
export type EspaceRappels = { relances?: Relance[]; taches?: Tache[]; habitudes?: Habitude[]; jeu?: Jeu; notifs?: { recompenses?: boolean }; finances?: FinancesRappels };
export type ConfigRappels = { routineHeure?: string; rappelSoir?: string; agressifJMoins?: number; modes?: Partial<Record<Mode, { actif?: boolean }>> };
/** canaux : pour couper le push ou l'email d'un rappel précis (alertes de budget) ; absent = selon les réglages du compte. */
export type Rappel = { quand: string; titre: string; corps: string; mode: Mode | 'briefing'; cle: string; canaux?: { push: boolean; email: boolean } };

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
const habitToday = (h: Habitude, s: string) => habitDue(h, s) || (!doneIn(h, s) && h.frequence !== 'quotidien' && h.mode === 'agressif' && pastDue(h, s));

// Points de la mission, comme dans l'app (me-mobile/src/lib/jeu.ts et mission.ts).
const POINTS = { habitude: 10, relance: 15, tache: 15, tacheHaute: 20, ponctuel: 5, parfait: 50 };

/** La mission du jour de l'app : relances arrivées à échéance, tâches urgentes, habitudes prévues (faites ou non). */
export function missionDuJour(e: EspaceRappels, jour: string) {
  const bientot = addDays(jour, 2);
  const out: { titre: string; fait: boolean; points: number }[] = [];
  for (const r of e.relances || [])
    if ((r.statut === 'a_faire' && r.date <= jour) || (r.statut === 'repondu' && r.reponduLe === jour)) out.push({ titre: `Relancer ${r.contact}`, fait: r.statut === 'repondu', points: POINTS.relance });
  for (const t of e.taches || [])
    if ((t.statut !== 'fait' && (t.priorite === 'haute' || (t.echeance && t.echeance <= bientot))) || (t.statut === 'fait' && t.faitLe === jour))
      out.push({ titre: t.titre, fait: t.statut === 'fait', points: (t.priorite === 'haute' ? POINTS.tacheHaute : POINTS.tache) + (t.echeance && jour <= t.echeance ? POINTS.ponctuel : 0) });
  for (const h of e.habitudes || []) if (habitToday(h, jour) || (h.coches || []).includes(jour)) out.push({ titre: h.nom, fait: doneIn(h, jour), points: POINTS.habitude });
  return out;
}

/** Série de jours actifs (au moins un point gagné ou jour sauvé par un joker) jusqu'à aujourd'hui, et points du jour. */
export function serieDuJour(e: EspaceRappels, jour: string) {
  const gains = Object.values(e.jeu?.gains || {});
  const actifs = new Set([...gains.map((g) => g.d), ...(e.jeu?.joursSauves || [])]);
  let cur = actifs.has(jour) ? jour : addDays(jour, -1);
  let serie = 0;
  while (actifs.has(cur)) {
    serie++;
    cur = addDays(cur, -1);
  }
  return { serie, pointsDuJour: gains.reduce((s, g) => s + (g.d === jour ? g.p : 0), 0), jokers: e.jeu?.jokers || 0 };
}
const pluriel = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;

/** Rappels d'une journée (heure locale), avec les mêmes règles que les notifications du téléphone. */
export function rappelsDuJour(e: EspaceRappels, c: ConfigRappels, jour: string): Rappel[] {
  const out: Rappel[] = [];
  const actif = (m: Mode) => c.modes?.[m]?.actif !== false;
  const matin = c.routineHeure || '07:00';
  const soir = c.rappelSoir || '19:00';
  const jMoins = c.agressifJMoins || 3;
  // Une clé « stable » ne dépend pas du titre : le rappel part une seule fois, même si son texte change entre deux passages.
  const add = (heure: string, titre: string, corps: string, mode: Rappel['mode'], id: string, stable = false) =>
    out.push({ quand: `${jour}T${heure}`, titre, corps, mode, cle: `${jour}T${heure}|${id}${stable ? '' : `|${titre}`}` });

  const jeu = e.notifs?.recompenses !== false;
  const mission = jeu ? missionDuJour(e, jour) : [];
  const restants = mission.filter((m) => !m.fait);
  const { serie, pointsDuJour, jokers } = serieDuJour(e, jour);
  const fin = alertesFinances(e.finances, jour, soir);
  const budget = fin.budgetDuJour ? ` Budget du jour : ${fin.budgetDuJour}.` : '';

  // Matin : la mission du jour, avec les points à gagner et la série à tenir.
  if (restants.length) {
    const pts = restants.reduce((s, m) => s + m.points, 0) + POINTS.parfait;
    const suite = pointsDuJour ? `Déjà ${pointsDuJour} pts aujourd'hui.` : serie ? `Série de ${pluriel(serie, 'jour', 'jours')} à tenir.` : `Pour commencer : ${restants[0].titre}.`;
    add(matin, 'Ta mission du jour est prête', `${pluriel(restants.length, 'action', 'actions')}, jusqu'à ${pts} pts à gagner. ${suite}${budget}`, 'briefing', 'briefing', true);
  } else add(matin, 'Ton briefing me est prêt', `Agenda, relances, tâches et habitudes du jour.${budget}`, 'briefing', 'briefing', true);

  // Alertes de budget : une seule fois par période et par niveau, d'où une clé sans date du jour.
  for (const a of fin.alertes) out.push({ quand: `${jour}T${a.heure}`, titre: a.titre, corps: a.corps, mode: a.mode, cle: a.id, canaux: a.canaux });

  // Soir : un coup de pouce seulement s'il change quelque chose (série en danger, journée parfaite toute proche).
  if (jeu && !pointsDuJour && serie)
    add(soir, `Ta série de ${pluriel(serie, 'jour', 'jours')} est en danger`, `Une seule action avant minuit suffit pour la garder.${jokers ? ' Sinon, un joker la protégera.' : ''}`, 'coach', 'serie', true);
  else if (jeu && !pointsDuJour && restants.length) add(soir, "Ta mission t'attend", `Coche une action ce soir, par exemple « ${restants[0].titre} », pour lancer ta série.`, 'coach', 'serie', true);
  else if (jeu && pointsDuJour && restants.length && restants.length <= 3)
    add(soir, 'Presque une journée parfaite', `Encore ${pluriel(restants.length, 'action', 'actions')} : ${restants.map((m) => m.titre).join(', ')}. Bonus de ${POINTS.parfait} pts à la clé.`, 'coach', 'serie', true);

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
