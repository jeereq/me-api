import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { prevision } from '../src/services/rappels/previsions.js';

const budgets = [{ id: 'b', nom: 'Total', emoji: '💰', montant: 100, periode: 'jour' as const, global: true }];

describe('prévisions de dépenses', () => {
  it('compte les dépenses du jour', () => {
    const p = prevision({ budgets, depenses: [{ id: 'a', montant: 30, budget: null, date: '2026-10-26' }] }, 'jour', '2026-10-26');
    assert.equal(p?.depense, 30);
  });
  it('ignore une moitié de virement entre deux comptes : ce n’est pas une dépense', () => {
    const p = prevision({ budgets, depenses: [{ id: 'a', montant: 30, budget: null, date: '2026-10-26' }, { id: 'v', montant: 500, budget: null, date: '2026-10-26', lien: 'v-v-r' }] }, 'jour', '2026-10-26');
    assert.equal(p?.depense, 30);
    assert.notEqual(p?.etat, 'depasse');
  });
});
