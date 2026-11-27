import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { avisAbsence } from '../src/services/rappels-absence.js';

const o = (derniereVue: string, aujourdhui: string, relances = 0, taches = 0) => avisAbsence({ derniereVue, aujourdhui, relances, taches });

describe('rappel d’absence', () => {
  it('rien avant deux jours', () => {
    assert.equal(o('2026-11-26', '2026-11-26'), null);
    assert.equal(o('2026-11-26', '2026-11-27'), null);
  });
  it('un message à deux jours, avec ce qui attend', () => {
    const a = o('2026-11-25', '2026-11-27', 2, 1)!;
    assert.equal(a.jours, 2);
    assert.equal(a.titre, 'Ça fait 2 jours que tu n\'as pas ouvert Me');
    assert.match(a.corps, /2 relances et 1 tâche attendent déjà/);
  });
  it('le singulier s’accorde, et sans rien en attente le briefing est annoncé', () => {
    assert.match(o('2026-11-20', '2026-11-27', 0, 1)!.corps, /^1 tâche attend déjà/);
    assert.match(o('2026-11-20', '2026-11-27')!.corps, /briefing du jour est prêt/);
  });
  it('une seule fois par seuil : même clé les jours entre deux seuils, nouvelle clé au seuil suivant', () => {
    const k = (j: string) => o('2026-11-01', j)!.cle;
    assert.equal(k('2026-11-03'), k('2026-11-04'));
    assert.equal(k('2026-11-06'), k('2026-11-08'));
    assert.notEqual(k('2026-11-04'), k('2026-11-06'));
    assert.notEqual(k('2026-11-10'), k('2026-11-11'));
  });
  it('une nouvelle absence après une visite a de nouvelles clés', () => {
    assert.notEqual(o('2026-11-01', '2026-11-03')!.cle, o('2026-11-10', '2026-11-12')!.cle);
  });
  it('passe le changement de mois', () => {
    assert.equal(o('2026-11-29', '2026-12-02')!.jours, 3);
  });
});
