import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { prevision } from '../src/services/rappels/previsions.js';

// Les mêmes cas que l'app (me-mobile/tests/reports.test.ts) : le serveur doit donner les mêmes chiffres.
const parJour = { id: 'g', nom: 'Budget du jour', emoji: '💰', montant: 20, periode: 'jour' as const, global: true };
const mardi = '2026-10-27';
const mercredi = '2026-10-28';
const depenses = [{ id: 'a', montant: 12, budget: null, date: mardi }];
const de = { budget: 'g', periode: 'jour' as const, debut: mardi };

describe('restes reportés', () => {
  it('baisse le budget du jour de départ et monte celui d’arrivée', () => {
    const f = { budgets: [parJour], depenses, reports: [{ id: 'r1', montant: 8, de, vers: { budget: 'g', periode: 'jour' as const, debut: mercredi } }] };
    assert.equal(prevision(f, 'jour', mardi)?.plafond, 12);
    assert.equal(prevision(f, 'jour', mercredi)?.plafond, 28);
  });
  it('répartit un reste reporté sur une semaine', () => {
    const f = { budgets: [parJour], depenses, reports: [{ id: 'r2', montant: 7, de, vers: { budget: 'g', periode: 'semaine' as const, debut: '2026-11-02' } }] };
    assert.equal(prevision(f, 'jour', '2026-11-03')?.plafond, 21);
    assert.equal(prevision(f, 'semaine', '2026-11-03')?.plafond, 147);
  });
  it('retire des budgets un reste versé sur un objectif, tant que le versement existe', () => {
    const report = { id: 'r3', montant: 8, de, vers: { objectif: 'o' } };
    const objectif = (versements: { id: string; date: string; montant: number; report?: string }[]) => ({ id: 'o', nom: 'Voyage', emoji: '✈️', genre: 'epargne' as const, cible: 500, debut: '2026-10-01', echeance: '2027-06-01', versements });
    const avec = { budgets: [parJour], depenses, reports: [report], objectifs: [objectif([{ id: 'rep:r3', date: mardi, montant: 8, report: 'r3' }])] };
    assert.equal(prevision(avec, 'jour', mardi)?.plafond, 12);
    const sans = { ...avec, objectifs: [objectif([])] };
    assert.equal(prevision(sans, 'jour', mardi)?.plafond, 20);
  });
  it('ne répartit plus sur les jours suivants le reste d’un jour versé ailleurs (budget au mois)', () => {
    const mois = { id: 'c', nom: 'Courses', emoji: '🛒', montant: 300, periode: 'mois' as const };
    const report = { id: 'r4', montant: 10, de: { budget: 'c', periode: 'jour' as const, debut: '2026-11-01' }, vers: { objectif: 'o' } };
    const f = { budgets: [mois], depenses: [], reports: [report], objectifs: [{ id: 'o', nom: 'Voyage', emoji: '✈️', genre: 'epargne' as const, cible: 500, debut: '2026-10-01', echeance: '2027-06-01', versements: [{ id: 'rep:r4', date: '2026-11-02', montant: 10, report: 'r4' }] }] };
    assert.equal(prevision(f, 'jour', '2026-11-02')?.plafond, 10);
  });
});
