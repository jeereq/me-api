import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addDays, missionDuJour, rappelsDuJour, serieDuJour, type ConfigRappels, type EspaceRappels } from '../src/services/rappels/calcul.js';

// Le 26 octobre 2026 est un lundi : le 25 est un dimanche, le 1er novembre aussi.
const LUNDI = '2026-10-26';
const DIMANCHE = '2026-11-01';
const cfg: ConfigRappels = {};
const tache = (o: Record<string, unknown>) => ({ id: 't1', titre: 'Payer la facture', echeance: null, statut: 'a_faire', mode: 'normal', ...o });
const relance = (o: Record<string, unknown>) => ({ id: 'r1', contact: 'Marie', sujet: 'Devis', date: LUNDI, statut: 'a_faire', mode: 'normal', ...o });
const espace = (e: Record<string, unknown>) => e as EspaceRappels;
const titres = (r: { titre: string }[]) => r.map((x) => x.titre);

describe('addDays', () => {
  it('passe les fins de mois, d’année et les années bissextiles', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2027-02-28', 1), '2027-03-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });
});

describe('rappelsDuJour : briefing', () => {
  it('envoie toujours un briefing le matin, à l’heure de la configuration', () => {
    const r = rappelsDuJour({}, cfg, LUNDI);
    assert.equal(r.length, 1);
    assert.equal(r[0].mode, 'briefing');
    assert.equal(r[0].quand, `${LUNDI}T07:00`);
    assert.equal(rappelsDuJour({}, { routineHeure: '06:30' }, LUNDI)[0].quand, `${LUNDI}T06:30`);
  });

  it('garde la même clé quand le texte change, pour ne partir qu’une fois', () => {
    const vide = rappelsDuJour({}, cfg, LUNDI)[0];
    const avecTache = rappelsDuJour(espace({ taches: [tache({ echeance: LUNDI, priorite: 'haute' })] }), cfg, LUNDI).find((x) => x.mode === 'briefing')!;
    assert.notEqual(vide.titre, avecTache.titre);
    assert.equal(vide.cle, avecTache.cle);
  });

  it('est déterministe : deux calculs donnent les mêmes clés', () => {
    const e = espace({ taches: [tache({ echeance: LUNDI })], relances: [relance({ mode: 'agressif' })] });
    assert.deepEqual(rappelsDuJour(e, cfg, LUNDI).map((x) => x.cle), rappelsDuJour(e, cfg, LUNDI).map((x) => x.cle));
  });

  it('donne une clé différente chaque jour, sauf pour les alertes de budget', () => {
    assert.notEqual(rappelsDuJour({}, cfg, LUNDI)[0].cle, rappelsDuJour({}, cfg, addDays(LUNDI, 1))[0].cle);
  });
});

describe('rappelsDuJour : modes des tâches et relances', () => {
  it('mode normal : une notification à 9 h le jour J, rien un autre jour', () => {
    const e = espace({ taches: [tache({ echeance: LUNDI })] });
    const r = rappelsDuJour(e, cfg, LUNDI).filter((x) => x.mode === 'normal');
    assert.deepEqual(titres(r), ['Payer la facture']);
    assert.equal(r[0].quand, `${LUNDI}T09:00`);
    assert.equal(rappelsDuJour(e, cfg, addDays(LUNDI, -1)).filter((x) => x.mode === 'normal').length, 0);
  });

  it('mode passif : aucun rappel propre à l’élément', () => {
    const e = espace({ taches: [tache({ echeance: LUNDI, mode: 'passif' })], relances: [relance({ mode: 'passif' })] });
    // Ni notification normale ni agressive : seuls restent le briefing et le message de mission, qui viennent du système de récompenses.
    assert.deepEqual(rappelsDuJour(e, cfg, LUNDI).map((x) => x.mode).sort(), ['briefing', 'coach']);
    // Avec les récompenses coupées, il ne reste que le briefing du matin.
    const sansJeu = espace({ ...e, notifs: { recompenses: false } });
    assert.deepEqual(rappelsDuJour(sansJeu, cfg, LUNDI).map((x) => x.mode), ['briefing']);
  });

  it('une tâche faite ne rappelle plus rien', () => {
    const e = espace({ taches: [tache({ echeance: LUNDI, statut: 'fait', faitLe: LUNDI })] });
    assert.equal(rappelsDuJour(e, cfg, LUNDI).filter((x) => x.mode === 'normal').length, 0);
  });

  it('un mode désactivé en configuration coupe ses rappels', () => {
    const e = espace({ taches: [tache({ echeance: LUNDI })] });
    assert.equal(rappelsDuJour(e, { modes: { normal: { actif: false } } }, LUNDI).filter((x) => x.mode === 'normal').length, 0);
  });

  it('mode agressif : prévenu à J-3 et J-1, matin et soir du jour J, puis « en retard » chaque jour', () => {
    const e = espace({ relances: [relance({ mode: 'agressif', date: addDays(LUNDI, 3) })] });
    assert.deepEqual(titres(rappelsDuJour(e, cfg, LUNDI).filter((x) => x.mode === 'agressif')), ['Dans 3 j : Relancer Marie']);
    assert.deepEqual(titres(rappelsDuJour(e, cfg, addDays(LUNDI, 2)).filter((x) => x.mode === 'agressif')), ['Dans 1 j : Relancer Marie']);
    assert.equal(rappelsDuJour(e, cfg, addDays(LUNDI, 1)).filter((x) => x.mode === 'agressif').length, 0);

    const jourJ = rappelsDuJour(e, cfg, addDays(LUNDI, 3)).filter((x) => x.mode === 'agressif');
    assert.deepEqual(jourJ.map((x) => x.quand.slice(-5)), ['07:00', '19:00']);
    assert.match(jourJ[0].titre, /^Aujourd'hui/);
    assert.match(jourJ[1].titre, /^Pas encore fait/);

    const retard = rappelsDuJour(e, cfg, addDays(LUNDI, 5)).filter((x) => x.mode === 'agressif');
    assert.match(retard[0].titre, /^En retard/);
  });

  it('une relance déjà répondue ne rappelle plus', () => {
    const e = espace({ relances: [relance({ mode: 'agressif', statut: 'repondu', reponduLe: LUNDI })] });
    assert.equal(rappelsDuJour(e, cfg, LUNDI).filter((x) => x.mode === 'agressif').length, 0);
  });
});

describe('rappelsDuJour : habitudes et bilan', () => {
  const habitude = (o: Record<string, unknown>) => ({ id: 'h1', nom: 'Sport', frequence: 'quotidien', jour: null, mode: 'coach', coches: [] as string[], ...o });

  it('coach : un message le soir avec les habitudes du jour, sauf si elles sont cochées', () => {
    const e = espace({ habitudes: [habitude({}), habitude({ id: 'h2', nom: 'Lecture' })] });
    const coach = rappelsDuJour(e, cfg, LUNDI).find((x) => x.titre === 'Coach me')!;
    assert.equal(coach.quand, `${LUNDI}T19:00`);
    assert.match(coach.corps, /2 habitudes/);
    const faites = espace({ habitudes: [habitude({ coches: [LUNDI] })] });
    assert.equal(rappelsDuJour(faites, cfg, LUNDI).some((x) => x.titre === 'Coach me'), false);
  });

  it('une habitude mensuelle tombe le bon jour, et le dernier jour d’un mois court', () => {
    const e = espace({ habitudes: [habitude({ frequence: 'mensuel', jour: 31, mode: 'normal' })] });
    assert.equal(rappelsDuJour(e, cfg, '2026-02-28').some((x) => x.titre === 'Sport'), true);
    assert.equal(rappelsDuJour(e, cfg, '2026-02-27').some((x) => x.titre === 'Sport'), false);
  });

  it('bilan hebdo : seulement le dimanche soir', () => {
    const e = espace({ taches: [tache({ mode: 'hebdo', echeance: addDays(DIMANCHE, 2) })] });
    const dimanche = rappelsDuJour(e, cfg, DIMANCHE).find((x) => x.titre === 'Ton bilan de la semaine')!;
    assert.equal(dimanche.quand, `${DIMANCHE}T19:00`);
    assert.equal(rappelsDuJour(e, cfg, LUNDI).some((x) => x.titre === 'Ton bilan de la semaine'), false);
  });
});

describe('missionDuJour et serieDuJour', () => {
  it('reprend les relances échues, les tâches urgentes ou à venir, et signale ce qui est fait', () => {
    const e = espace({
      relances: [relance({ date: addDays(LUNDI, -2) }), relance({ id: 'r2', contact: 'Paul', date: addDays(LUNDI, 5) })],
      taches: [tache({ id: 'a', titre: 'Haute', priorite: 'haute' }), tache({ id: 'b', titre: 'Dans 2 jours', echeance: addDays(LUNDI, 2) }), tache({ id: 'c', titre: 'Loin', echeance: addDays(LUNDI, 9) }), tache({ id: 'd', titre: 'Faite', statut: 'fait', faitLe: LUNDI })],
    });
    const m = missionDuJour(e, LUNDI);
    assert.deepEqual(m.map((x) => x.titre).sort(), ['Dans 2 jours', 'Faite', 'Haute', 'Relancer Marie']);
    assert.equal(m.find((x) => x.titre === 'Faite')!.fait, true);
    assert.equal(m.find((x) => x.titre === 'Haute')!.points, 20);
  });

  it('compte la série de jours actifs jusqu’à hier, et protège un jour avec un joker', () => {
    const gains = { a: { d: addDays(LUNDI, -1), p: 10 }, b: { d: addDays(LUNDI, -2), p: 10 }, c: { d: addDays(LUNDI, -4), p: 10 } };
    assert.deepEqual(serieDuJour(espace({ jeu: { gains } }), LUNDI), { serie: 2, pointsDuJour: 0, jokers: 0 });
    const sauve = serieDuJour(espace({ jeu: { gains, joursSauves: [addDays(LUNDI, -3)], jokers: 1 } }), LUNDI);
    assert.equal(sauve.serie, 4);
    assert.equal(sauve.jokers, 1);
  });

  it('additionne les points d’aujourd’hui et compte aujourd’hui dans la série', () => {
    const r = serieDuJour(espace({ jeu: { gains: { a: { d: LUNDI, p: 15 }, b: { d: LUNDI, p: 10 } } } }), LUNDI);
    assert.deepEqual(r, { serie: 1, pointsDuJour: 25, jokers: 0 });
  });
});

describe('alertes de budget', () => {
  const finances = (depense: number) => ({ devise: '€', budgets: [{ id: 'g', nom: 'Mois', emoji: '💶', montant: 100, periode: 'mois', global: true }], depenses: [{ id: 'd1', montant: depense, budget: null, note: '', date: '2026-10-05', creeLe: '2026-10-05T10:00:00Z' }] });

  it('ne dit rien tant que le budget est tenu', () => {
    const r = rappelsDuJour(espace({ finances: finances(10) }), cfg, LUNDI);
    assert.equal(r.filter((x) => x.mode === 'agressif' || x.mode === 'hebdo').length, 0);
  });

  it('prévient une seule fois par période : même identifiant deux jours de suite', () => {
    const alertes = (jour: string) => rappelsDuJour(espace({ finances: finances(150) }), cfg, jour).filter((x) => x.cle.includes('|') === false || x.mode !== 'briefing').filter((x) => x.canaux);
    const a = alertes(LUNDI);
    const b = alertes(addDays(LUNDI, 1));
    assert.ok(a.length >= 1, 'une alerte de dépassement est attendue');
    assert.deepEqual(a.map((x) => x.cle), b.map((x) => x.cle));
  });
});
