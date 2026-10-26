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

describe('budgets jusqu’à une date', () => {
  const jour = '2026-11-10';
  it('ne compte plus un budget après sa date de fin', () => {
    const b = [{ id: 'v', nom: 'Vacances', emoji: '🏖️', montant: 300, periode: 'mois' as const, fin: '2026-10-31' }];
    const p = prevision({ budgets: b, depenses: [{ id: 'a', montant: 50, budget: 'v', date: jour }] }, 'mois', jour);
    assert.equal(p?.plafond, 0);
  });
  it('répartit une enveloppe sur toute sa durée', () => {
    // 600 du 1er au 30 novembre puis rien : le mois de novembre porte tout, la semaine en porte 7/30.
    const b = [{ id: 'e', nom: 'Travaux', emoji: '🔨', montant: 600, periode: 'mois' as const, debut: '2026-11-01', fin: '2026-11-30', enveloppe: true }];
    assert.equal(prevision({ budgets: b, depenses: [] }, 'mois', jour)?.plafond, 600);
    assert.equal(prevision({ budgets: b, depenses: [] }, 'semaine', jour)?.plafond, 140);
  });
  it('prorate un budget qui s’arrête en cours de mois', () => {
    const b = [{ id: 'c', nom: 'Courses', emoji: '🛒', montant: 300, periode: 'mois' as const, fin: '2026-11-15' }];
    assert.equal(prevision({ budgets: b, depenses: [] }, 'mois', jour)?.plafond, 150);
  });
  it('ne range plus par catégorie dans un budget terminé', () => {
    const b = [
      { id: 'g', nom: 'Total', emoji: '💰', montant: 1000, periode: 'mois' as const, global: true },
      { id: 'r', nom: 'Restos', emoji: '🍽️', montant: 10, periode: 'mois' as const, categories: ['sortie'], fin: '2026-10-31' },
    ];
    const p = prevision({ budgets: b, depenses: [{ id: 'a', montant: 80, budget: null, categories: ['sortie'], date: jour }] }, 'mois', jour);
    assert.equal(p?.budgets.length, 0);
  });
});
