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

describe('budgets qui suivent des catégories', () => {
  const avecCat = [
    { id: 'g', nom: 'Total', emoji: '💰', montant: 1000, periode: 'jour' as const, global: true },
    { id: 'resto', nom: 'Restos', emoji: '🍽️', montant: 20, periode: 'jour' as const, categories: ['sortie'] },
  ];
  const jour = '2026-10-26';
  it('range une dépense dans le budget qui suit sa catégorie', () => {
    const p = prevision({ budgets: avecCat, depenses: [{ id: 'a', montant: 30, budget: null, categories: ['sortie'], date: jour }] }, 'jour', jour);
    assert.equal(p?.budgets.find((b) => b.nom.includes('Restos'))?.depense, 30);
    assert.equal(p?.budgets.find((b) => b.nom.includes('Restos'))?.etat, 'depasse');
  });
  it('garde le budget choisi à la main, même si une catégorie en suit un autre', () => {
    const deux = [...avecCat, { id: 'autre', nom: 'Autre', emoji: '📦', montant: 50, periode: 'jour' as const }];
    const p = prevision({ budgets: deux, depenses: [{ id: 'a', montant: 30, budget: 'autre', categories: ['sortie'], date: jour }] }, 'jour', jour);
    assert.equal(p?.budgets.find((b) => b.nom.includes('Restos'))?.depense ?? 0, 0);
  });
  it('ne range pas une dépense sans catégorie ni budget', () => {
    const p = prevision({ budgets: avecCat, depenses: [{ id: 'a', montant: 30, budget: null, date: jour }] }, 'jour', jour);
    assert.equal(p?.budgets.find((b) => b.nom.includes('Restos'))?.depense ?? 0, 0);
  });
});
