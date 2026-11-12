import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { budgetPaquets } from '../src/services/analyses/budget-paquets.js';

describe('budget des paquets d’analyse', () => {
  it('un seul paquet ne coûte rien de plus', () => {
    const b = budgetPaquets(2);
    for (let i = 0; i < 50; i++) assert.equal(b.depenser('a', 1, 0), true);
  });
  it('les paquets supplémentaires sont comptés par compte', () => {
    const b = budgetPaquets(10, 1000);
    assert.equal(b.depenser('a', 6, 0), true); // 5
    assert.equal(b.depenser('a', 6, 10), true); // 10
    assert.equal(b.depenser('a', 2, 20), false);
    assert.equal(b.depenser('b', 6, 20), true);
  });
  it('un refus ne réserve rien', () => {
    const b = budgetPaquets(5, 1000);
    assert.equal(b.depenser('a', 4, 0), true); // 3
    assert.equal(b.depenser('a', 5, 1), false); // 4 de plus : refusé
    assert.equal(b.depenser('a', 3, 2), true); // 2 de plus : il restait de la place
  });
  it('la place revient quand la fenêtre est passée', () => {
    const b = budgetPaquets(5, 1000);
    assert.equal(b.depenser('a', 6, 0), true);
    assert.equal(b.depenser('a', 2, 500), false);
    assert.equal(b.depenser('a', 6, 1001), true);
  });
});
