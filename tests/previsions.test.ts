import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { alertesFinances, prevision, resteDesBudgets } from '../src/commun/previsions.js';

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
    assert.equal(prevision({ budgets: b, depenses: [{ id: 'a', montant: 50, budget: 'v', date: jour }] }, 'mois', jour), null);
  });
  it('suit une enveloppe sur toute sa durée, sans la répartir', () => {
    const b = [{ id: 'e', nom: 'Travaux', emoji: '🔨', montant: 600, periode: 'mois' as const, debut: '2026-11-01', fin: '2026-11-30', enveloppe: true }];
    const p = prevision({ budgets: b, depenses: [{ id: 'a', montant: 150, budget: 'e', date: '2026-11-03' }] }, 'mois', jour);
    assert.equal(p?.plafond, 600);
    assert.equal(p?.reste, 450);
  });
  it('garde tout le montant d’un budget qui s’arrête en cours de mois', () => {
    const b = [{ id: 'c', nom: 'Courses', emoji: '🛒', montant: 300, periode: 'mois' as const, fin: '2026-11-15' }];
    assert.equal(prevision({ budgets: b, depenses: [] }, 'mois', jour)?.plafond, 300);
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

// Mêmes cas que l'app (me-mobile/tests/budget-du-jour.test.ts) : les alertes annoncent le chiffre affiché à l'écran.
describe('seulement les dépenses notées, rien de supposé', () => {
  const courses = { id: 'c', nom: 'Courses', emoji: '🛒', montant: 300, periode: 'mois' as const };
  const f = { budgets: [courses], depenses: [{ id: 'a', montant: 100, budget: 'c', date: '2026-11-05' }, { id: 'b', montant: 20, budget: 'c', date: '2026-11-11' }] };
  it('suit un budget au mois sur son mois : montant moins dépenses', () => {
    const p = prevision(f, 'mois', '2026-11-11');
    assert.equal(p?.plafond, 300);
    assert.equal(p?.depense, 120);
    assert.equal(p?.reste, 180);
  });
  it('ne tire pas de budget du jour d’un budget au mois', () => {
    assert.equal(prevision(f, 'jour', '2026-11-11'), null);
    assert.equal(prevision(f, 'semaine', '2026-11-11'), null);
  });
  it('ne prévient pas d’un dépassement « à ce rythme » tant que les dépenses tiennent', () => {
    // 290 dépensés dès le 2 : l'ancien calcul projetait 4 350 sur le mois. Le budget n'est pas dépassé.
    const g = { budgets: [courses], depenses: [{ id: 'a', montant: 290, budget: 'c', date: '2026-11-02' }] };
    assert.equal(prevision(g, 'mois', '2026-11-02')?.etat, 'ok');
    assert.equal(prevision(g, 'mois', '2026-11-02', 0.8)?.etat, 'risque');
  });
  it('un budget de 40 $ pour un besoin : 40 moins ce qui y est noté', () => {
    const besoin = { id: 'n', nom: 'Cadeau', emoji: '🎁', montant: 40, periode: 'mois' as const, debut: '2026-11-01', fin: '2026-11-30', enveloppe: true };
    const h = { budgets: [besoin], depenses: [{ id: 'a', montant: 15, budget: 'n', date: '2026-11-04' }, { id: 'b', montant: 99, budget: null, date: '2026-11-05' }] };
    assert.equal(prevision(h, 'mois', '2026-11-20')?.reste, 25);
    assert.equal(resteDesBudgets(h, '2026-11-20'), 25);
  });
  it('donne le montant fixé pour un budget par jour', () => {
    const g = { budgets: [{ id: 'g', nom: 'Budget du jour', emoji: '💰', montant: 25, periode: 'jour' as const, global: true }], depenses: [{ id: 'a', montant: 40, budget: null, date: '2026-11-10' }] };
    assert.equal(prevision(g, 'jour', '2026-11-11')?.plafond, 25);
    assert.equal(prevision(g, 'jour', '2026-11-10')?.etat, 'depasse');
  });
  it('ne compte pas le hors budget sans budget global', () => {
    const h = { budgets: [courses], depenses: [{ id: 'a', montant: 100, budget: 'c', date: '2026-11-05' }, { id: 'h', montant: 50, budget: null, date: '2026-11-06' }] };
    assert.equal(prevision(h, 'mois', '2026-11-11')?.depense, 100);
  });
});

describe('alertes et briefing', () => {
  const courses = { id: 'c', nom: 'Courses', emoji: '🛒', montant: 300, periode: 'mois' as const };
  it('annonce le matin le reste des budgets, pas un budget du jour', () => {
    const f = { devise: '$', budgets: [courses], depenses: [{ id: 'a', montant: 120, budget: 'c', date: '2026-11-05' }] };
    assert.equal(alertesFinances(f, '2026-11-11', '19:00').resteBudgets, 'Reste sur tes budgets du mois : 180 $');
  });
  it('n’alerte qu’une fois le budget réellement dépassé', () => {
    const f = { devise: '$', budgets: [courses], depenses: [{ id: 'a', montant: 310, budget: 'c', date: '2026-11-05' }] };
    const [a] = alertesFinances(f, '2026-11-11', '19:00').alertes;
    assert.equal(a.titre, 'Budget du mois dépassé');
    assert.equal(a.corps, '310 $ dépensés pour 300 $ prévus.');
    assert.equal(alertesFinances({ ...f, depenses: [{ id: 'a', montant: 200, budget: 'c', date: '2026-11-02' }] }, '2026-11-02', '19:00').alertes.length, 0);
  });
});

// Mêmes chiffres que l'écran Finances (me-mobile, `bilan`) : un seul calcul pour l'écran, les alertes et le briefing.
describe('même total que l’écran Finances', () => {
  const budgets = [
    { id: 'c', nom: 'Courses', emoji: '🛒', montant: 400, periode: 'mois' as const },
    { id: 's', nom: 'Sorties', emoji: '🎉', montant: 50, periode: 'semaine' as const },
    { id: 'v', nom: 'Vacances', emoji: '✈️', montant: 1500, periode: 'annee' as const },
    { id: 't', nom: 'Travaux', emoji: '🔨', montant: 900, periode: 'mois' as const, debut: '2026-11-01', fin: '2027-01-31', enveloppe: true },
  ];
  const f = { budgets, depenses: [{ id: 'd', montant: 100, budget: 'c', date: '2026-11-03' }] };
  it('additionne les semaines du mois et laisse de côté l’enveloppe qui déborde et le budget annuel', () => {
    // Courses 400 + Sorties 5 semaines × 50 (celles qui commencent en novembre).
    assert.equal(prevision(f, 'mois', '2026-11-05')?.plafond, 650);
    assert.equal(resteDesBudgets(f, '2026-11-05'), 550);
  });
  it('ne surveille dans le mois que les budgets au mois', () => {
    const g = { budgets, depenses: [{ id: 'd', montant: 70, budget: 's', date: '2026-11-03' }] };
    assert.deepEqual(prevision(g, 'mois', '2026-11-05')?.budgets.map((b) => b.nom), []);
    assert.deepEqual(prevision(g, 'semaine', '2026-11-05')?.budgets.map((b) => b.nom), ['Sorties']);
  });
  it('ne compte pas une dépense versée sur un objectif', () => {
    const g = {
      budgets: [{ id: 'g', nom: 'Tout', emoji: '💰', montant: 100, periode: 'mois' as const, global: true }],
      depenses: [{ id: 'e', montant: 80, budget: null, date: '2026-11-01' }],
      objectifs: [{ id: 'o', nom: 'Voyage', cible: 500, debut: '2026-10-01', echeance: '2027-06-01', versements: [{ id: 'v', date: '2026-11-01', montant: 80, depense: 'e' }] }],
    };
    assert.equal(prevision(g, 'mois', '2026-11-02')?.depense, 0);
    assert.equal(alertesFinances({ ...g, alertes: { seuil: 0.8 } }, '2026-11-02', '19:00').alertes.length, 0);
  });
});
