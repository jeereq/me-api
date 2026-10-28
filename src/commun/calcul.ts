import { type ConfigModes, heureDe, type Mode, reglesDuMode, MODES_LISTE } from './modes.js';
import { addDays, doneIn, type Frequence, habitDue, habitToday, parse, pastDue, periodKey } from './jours.js';
import { estTacheDeProjet, resumes, tachesActives, type TacheProjet } from './projets.js';
import { alertesObjectifs } from './objectifs.js';
import { alertesFinances, type FinancesRappels } from './previsions.js';

export type { Mode } from './modes.js';
export { addDays } from './jours.js';

/**
 * Calcul des rappels, le même pour le serveur (push et email) et pour l'app (notifications du téléphone).
 * Tout est en heure locale de l'utilisateur, sous forme de texte : « AAAA-MM-JJ » et « AAAA-MM-JJTHH:MM ».
 */

type Habitude = { id: string; nom: string; frequence: Frequence; jour: number | null; mode: Mode; coches: string[] };
type Relance = { id: string; contact: string; sujet: string; date: string; statut: string; mode: Mode; reponduLe?: string | null; derniereRelance?: string | null };
/**
 * Une relance qui attend une action à sa date : à faire, ou déjà relancée depuis que l'app reprogramme la suivante
 * (`derniereRelance`). Les anciennes relances « Relancé » sans cette date ne reviennent pas d'un coup en retard.
 */
export const relanceAttendue = (r: Pick<Relance, 'statut' | 'derniereRelance'>) => r.statut === 'a_faire' || (r.statut === 'relance' && !!r.derniereRelance);
const titreRelance = (r: Relance) => `${r.statut === 'relance' ? 'Relancer à nouveau' : 'Relancer'} ${r.contact}`;
type Tache = { id: string; titre: string; echeance: string | null; statut: string; mode: Mode; priorite?: string; faitLe?: string | null } & Partial<TacheProjet>;
type Jeu = { gains?: Record<string, { d: string; p: number }>; joursSauves?: string[]; jokers?: number };
export type EspaceRappels = { relances?: Relance[]; taches?: Tache[]; projets?: { id: string }[]; habitudes?: Habitude[]; jeu?: Jeu; notifs?: { recompenses?: boolean }; finances?: FinancesRappels };
export type ConfigRappels = ConfigModes & { routineHeure?: string; rappelSoir?: string };
/** canaux : pour couper le push ou l'email d'un rappel précis (alertes de budget) ; absent = selon les réglages du compte. */
export type Rappel = { quand: string; titre: string; corps: string; mode: Mode | 'briefing'; cle: string; canaux?: { push: boolean; email: boolean } };

// Points de la mission, comme dans l'app (me-mobile/src/lib/jeu.ts et mission.ts).
const POINTS = { habitude: 10, relance: 15, tache: 15, tacheHaute: 20, ponctuel: 5, parfait: 50 };

/** La mission du jour de l'app : relances arrivées à échéance, tâches urgentes, habitudes prévues (faites ou non). */
export function missionDuJour(e: EspaceRappels, jour: string) {
  const bientot = addDays(jour, 2);
  const out: { titre: string; fait: boolean; points: number }[] = [];
  for (const r of e.relances || [])
    if ((relanceAttendue(r) && r.date <= jour) || (r.statut === 'repondu' && r.reponduLe === jour)) out.push({ titre: titreRelance(r), fait: r.statut === 'repondu', points: POINTS.relance });
  // Tâches de projet : seulement celles à faire bientôt et pas bloquées ; jamais les résumés (voir projets.ts).
  const urgentes = new Set(
    tachesActives(e)
      .filter((t) => {
        const proche = !!t.echeance && t.echeance <= bientot;
        return estTacheDeProjet(t, e.projets) ? proche : t.priorite === 'haute' || proche;
      })
      .map((t) => t.id),
  );
  const parents = resumes(e.taches || []);
  for (const t of e.taches || [])
    if (!parents.has(t.id) && (urgentes.has(t.id) || (t.statut === 'fait' && t.faitLe === jour)))
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
  const matin = c.routineHeure || '07:00';
  const soir = c.rappelSoir || '19:00';
  // Une clé « stable » ne dépend pas du titre : le rappel part une seule fois, même si son texte change entre deux passages.
  const add = (heure: string, titre: string, corps: string, mode: Rappel['mode'], id: string, stable = false) =>
    out.push({ quand: `${jour}T${heure}`, titre, corps, mode, cle: `${jour}T${heure}|${id}${stable ? '' : `|${titre}`}` });

  const jeu = e.notifs?.recompenses !== false;
  const mission = jeu ? missionDuJour(e, jour) : [];
  const restants = mission.filter((m) => !m.fait);
  const { serie, pointsDuJour, jokers } = serieDuJour(e, jour);
  const fin = alertesFinances(e.finances, jour, soir);
  const budget = fin.resteBudgets ? ` ${fin.resteBudgets}.` : '';

  // Matin : la mission du jour, avec les points à gagner et la série à tenir.
  if (restants.length) {
    const pts = restants.reduce((s, m) => s + m.points, 0) + POINTS.parfait;
    const suite = pointsDuJour ? `Déjà ${pointsDuJour} pts aujourd'hui.` : serie ? `Série de ${pluriel(serie, 'jour', 'jours')} à tenir.` : `Pour commencer : ${restants[0].titre}.`;
    add(matin, 'Ta mission du jour est prête', `${pluriel(restants.length, 'action', 'actions')}, jusqu'à ${pts} pts à gagner. ${suite}${budget}`, 'briefing', 'briefing', true);
  } else add(matin, 'Ton briefing Me est prêt', `Agenda, relances, tâches et habitudes du jour.${budget}`, 'briefing', 'briefing', true);

  // Alertes de budget : une seule fois par période et par niveau, d'où une clé sans date du jour.
  for (const a of fin.alertes) out.push({ quand: `${jour}T${a.heure}`, titre: a.titre, corps: a.corps, mode: a.mode, cle: a.id, canaux: a.canaux });
  // Objectifs : versement du jour, retard, échéance passée, objectif atteint (clé sans date du jour, sauf le versement).
  for (const a of alertesObjectifs(e.finances, jour, soir)) out.push({ quand: `${jour}T${a.heure}`, titre: a.titre, corps: a.corps, mode: a.mode, cle: a.id, canaux: a.canaux });

  // Soir : un coup de pouce seulement s'il change quelque chose (série en danger, journée parfaite toute proche).
  if (jeu && !pointsDuJour && serie)
    add(soir, `Ta série de ${pluriel(serie, 'jour', 'jours')} est en danger`, `Une seule action avant minuit suffit pour la garder.${jokers ? ' Sinon, un joker la protégera.' : ''}`, 'coach', 'serie', true);
  else if (jeu && !pointsDuJour && restants.length) add(soir, "Ta mission t'attend", `Coche une action ce soir, par exemple « ${restants[0].titre} », pour lancer ta série.`, 'coach', 'serie', true);
  else if (jeu && pointsDuJour && restants.length && restants.length <= 3)
    add(soir, 'Presque une journée parfaite', `Encore ${pluriel(restants.length, 'action', 'actions')} : ${restants.map((m) => m.titre).join(', ')}. Bonus de ${POINTS.parfait} pts à la clé.`, 'coach', 'serie', true);

  for (const x of rappelsDesElements(e, c, jour)) add(x.heure, x.titre, x.corps, x.mode, x.id);
  return out;
}

/** Un rappel d'un élément suivi (relance, tâche, habitude, résumé ou bilan d'un mode), sans le jour : l'heure seule. */
export type RappelElement = { heure: string; titre: string; corps: string; mode: Mode; id: string };

/**
 * Les rappels des relances, tâches et habitudes pour `jour`, selon le mode de chacun et ses règles (voir `modes.ts`).
 * `aujourdhui` sert quand on calcule à l'avance (l'app programme trois semaines de notifications) : les vieux retards
 * de projet et les périodes d'habitude se jugent depuis aujourd'hui. Le serveur, qui calcule le jour même, l'omet.
 */
export function rappelsDesElements(e: EspaceRappels, c: ConfigRappels, jour: string, aujourdhui = jour): RappelElement[] {
  const out: RappelElement[] = [];
  const actif = (m: Mode) => c.modes?.[m]?.actif !== false;
  const matin = c.routineHeure || '07:00';
  const soir = c.rappelSoir || '19:00';
  const pousser = (heure: string, titre: string, corps: string, mode: Mode, id: string) => out.push({ heure, titre, corps, mode, id });

  const dates = [
    ...(e.relances || []).filter((r) => relanceAttendue(r) && r.date).map((r) => ({ id: r.id, titre: titreRelance(r), detail: r.sujet, date: r.date, mode: r.mode })),
    // Tâches de projet : pas les résumés ni les tâches bloquées, et pas de rappel quotidien pour un vieux retard.
    ...tachesActives(e).filter((t) => t.echeance && (!estTacheDeProjet(t, e.projets) || t.echeance >= addDays(aujourdhui, -3))).map((t) => ({ id: t.id, titre: t.titre, detail: 'Tâche à faire', date: t.echeance as string, mode: t.mode })),
  ];
  const heure = (t: string) => heureDe(t, matin, soir);
  for (const x of dates) {
    if (!actif(x.mode)) continue;
    const r = reglesDuMode(c, x.mode);
    if (x.date === jour) {
      // Une seule heure : le titre tel quel ; plusieurs : on insiste (« Aujourd'hui », puis « Pas encore fait »).
      r.jourJ.forEach((t, i) => pousser(heure(t), r.jourJ.length === 1 ? x.titre : i === 0 ? `Aujourd'hui : ${x.titre}` : `Pas encore fait : ${x.titre}`, x.detail, x.mode, x.id));
    } else if (jour > x.date) {
      if (r.retard) pousser(heure(r.heure), `En retard : ${x.titre}`, `Prévu le ${x.date}. ${x.detail}`, x.mode, x.id);
    } else for (const j of r.avant) if (addDays(jour, j) === x.date) pousser(heure(r.heure), `Dans ${j} j : ${x.titre}`, x.detail, x.mode, x.id);
  }

  // Habitudes : rappel individuel, ou message du soir regroupé pour les modes à « résumé ».
  const resumes: Partial<Record<Mode, string[]>> = {};
  for (const h of e.habitudes || []) {
    if (!actif(h.mode) || doneIn(h, jour)) continue;
    const r = reglesDuMode(c, h.mode);
    if (habitDue(h, jour)) {
      if (r.resume) (resumes[h.mode] ||= []).push(h.nom);
      else r.jourJ.forEach((t, i) => (r.jourJ.length === 1 ? pousser(heure(t), h.nom, "C'est le jour.", h.mode, h.id) : i === 0 ? pousser(heure(t), `Aujourd'hui : ${h.nom}`, 'À faire avant ce soir.', h.mode, h.id) : pousser(heure(t), `Pas encore fait : ${h.nom}`, 'Coche-le dans Me dès que c’est fait.', h.mode, h.id)));
    } else if (!r.resume && h.frequence !== 'quotidien') {
      // Dans la période en cours seulement : un jour d'une période à venir n'est pas encore en retard.
      if (periodKey(h.frequence, jour) === periodKey(h.frequence, aujourdhui) && pastDue(h, jour)) {
        if (r.retard) pousser(heure(r.heure), `En retard : ${h.nom}`, 'Toujours pas coché pour cette période.', h.mode, h.id);
      } else for (const j of r.avant) if (habitDue(h, addDays(jour, j))) pousser(heure(r.heure), `Dans ${j} j : ${h.nom}`, 'Prépare-toi.', h.mode, h.id);
    }
  }
  for (const m of MODES_LISTE) {
    const noms = resumes[m];
    if (!noms?.length) continue;
    const corps = `${noms.length > 1 ? `${noms.length} habitudes` : '1 habitude'} à tenir aujourd'hui : ${noms.slice(0, 3).join(', ')}.`;
    if (m === 'coach') pousser(soir, 'Coach Me', `${corps} Ne casse pas ta série.`, 'coach', 'coach');
    else pousser(soir, 'Tes habitudes du jour', corps, m, `resume-${m}`);
  }

  // Bilan de la semaine : le jour choisi pour le mode (le dimanche soir pour « bilan hebdo »), ce qui est suivi dans ce mode pour la semaine à venir.
  for (const m of MODES_LISTE) {
    const r = reglesDuMode(c, m);
    if (!actif(m) || !r.bilan || parse(jour).getUTCDay() !== r.bilan.jour) continue;
    const suivis = [
      ...dates.filter((x) => x.mode === m && x.date >= jour && x.date <= addDays(jour, 7)).map((x) => x.titre),
      ...(e.habitudes || []).filter((h) => h.mode === m && Array.from({ length: 7 }, (_, i) => addDays(jour, i + 1)).some((d) => habitDue(h, d))).map((h) => h.nom),
    ];
    if (suivis.length) pousser(heure(r.bilan.heure), 'Ton bilan de la semaine', `${suivis.length} élément(s) à suivre : ${suivis.slice(0, 4).join(', ')}.`, m, m === 'hebdo' ? 'hebdo' : `bilan-${m}`);
  }
  return out;
}
