import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rappelsDuJour } from '../src/commun/calcul.js';
import { alerteBilan, alertesEcheances, alertesPrets, bilanMois, echeancesAVenir, moisPrecedent, suiviPret, totauxPrets, type Pret } from '../src/commun/prets.js';

const pret = (p: Partial<Pret>): Pret => ({ id: 'p1', personne: 'Paul', sens: 'prete', montant: 50, date: '2026-10-03', echeance: '2026-11-05', remboursements: [], ...p });

describe('prêts entre personnes', () => {
  it('suit ce qui est rendu et ce qui reste', () => {
    const s = suiviPret(pret({ remboursements: [{ id: 'r', date: '2026-10-20', montant: 20 }] }), '2026-11-01');
    assert.equal(s.rendu, 20);
    assert.equal(s.reste, 30);
    assert.equal(s.etat, 'bientot');
    assert.equal(suiviPret(pret({}), '2026-11-06').etat, 'en_retard');
    assert.equal(suiviPret(pret({ remboursements: [{ id: 'r', date: '2026-10-20', montant: 50 }] }), '2026-11-06').etat, 'rembourse');
    assert.equal(suiviPret(pret({ echeance: null }), '2027-01-01').etat, 'en_cours');
  });

  it('additionne ce qu’on me doit et ce que je dois', () => {
    const t = totauxPrets([pret({}), pret({ id: 'p2', sens: 'emprunte', montant: 30, echeance: '2026-10-01' }), pret({ id: 'p3', archive: true })], '2026-11-01');
    assert.deepEqual(t, { onMeDoit: 50, jeDois: 30, net: 20, enRetard: 1 });
  });

  it('rappelle la veille, le jour J, puis chaque lundi tant que ce n’est pas rendu', () => {
    const f = { devise: 'USD', prets: [pret({}), pret({ id: 'p2', sens: 'emprunte', personne: 'Awa', echeance: '2026-11-05' })] };
    const veille = alertesPrets(f, '2026-11-04', '19:00');
    assert.equal(veille.length, 2);
    assert.match(veille[0].titre, /Demain, Paul doit te rendre 50 USD/);
    assert.match(veille[1].titre, /Demain : rendre 50 USD à Awa/);
    assert.match(alertesPrets(f, '2026-11-05', '19:00')[0].titre, /Aujourd'hui/);
    // Le 9 novembre 2026 est un lundi ; le 10 non.
    assert.match(alertesPrets(f, '2026-11-09', '19:00')[0].titre, /Paul te doit encore/);
    assert.equal(alertesPrets(f, '2026-11-10', '19:00').length, 0);
    assert.equal(alertesPrets({ ...f, alertes: { prets: false } }, '2026-11-04', '19:00').length, 0);
  });
});

describe('paiements à venir', () => {
  const loyer = { id: 'loyer', genre: 'depense' as const, montant: 300, note: 'Loyer', frequence: 'mois' as const, debut: '2026-01-31', derniere: '2026-10-31' };

  it('liste les prochaines échéances, sans celles déjà ajoutées', () => {
    const l = echeancesAVenir([loyer, { ...loyer, id: 'net', note: 'Internet', montant: 25, frequence: 'semaine', debut: '2026-11-02', derniere: null, fin: '2026-11-20' }], '2026-11-01', 30);
    assert.deepEqual(
      l.map((e) => `${e.note} ${e.date}`),
      ['Internet 2026-11-02', 'Internet 2026-11-09', 'Internet 2026-11-16', 'Loyer 2026-11-30'],
    );
  });

  it('prévient la veille d’une dépense récurrente', () => {
    const a = alertesEcheances({ devise: 'USD', recurrences: [loyer] }, '2026-11-29', '19:00');
    assert.equal(a.length, 1);
    assert.match(a[0].titre, /Demain : Loyer, 300 USD/);
    assert.equal(alertesEcheances({ devise: 'USD', recurrences: [loyer] }, '2026-11-28', '19:00').length, 0);
  });
});

describe('bilan du mois', () => {
  const f = {
    devise: 'USD',
    depenses: [
      { id: 'a', montant: 120, date: '2026-10-05', categories: ['Courses'], note: 'Marché' },
      { id: 'b', montant: 30, date: '2026-10-12', categories: ['Transport'], note: 'Taxi' },
      { id: 'c', montant: 50, date: '2026-10-15', lien: 'v1', note: 'Virement' },
      { id: 'd', montant: 100, date: '2026-09-10', note: '' },
    ],
    revenus: [{ id: 'r', montant: 400, date: '2026-10-01' }],
  };

  it('compte dépenses, revenus et postes, sans les virements', () => {
    const b = bilanMois(f, '2026-10');
    assert.equal(b.depenses, 150);
    assert.equal(b.revenus, 400);
    assert.equal(b.solde, 250);
    assert.equal(b.categories[0].categorie, 'Courses');
    assert.equal(b.categories[0].part, 80);
    assert.equal(b.plusGrosse?.note, 'Marché');
    assert.equal(b.precedent.depenses, 100);
    assert.equal(moisPrecedent('2026-01'), '2025-12');
  });

  it('envoie le bilan le 1er du mois, au matin', () => {
    const a = alerteBilan(f, '2026-11-01', '07:00');
    assert.equal(a.length, 1);
    assert.match(a[0].titre, /octobre 2026/);
    assert.match(a[0].corps, /250 USD de côté/);
    assert.equal(alerteBilan(f, '2026-11-02', '07:00').length, 0);
  });

  it('entre dans les rappels du jour seulement avec les finances avancées', () => {
    const e = { finances: { ...f, depenses: f.depenses.map((x) => ({ ...x, budget: null })), budgets: [] } };
    const avec = rappelsDuJour(e, {}, '2026-11-01');
    assert.ok(avec.some((r) => r.cle === 'bilan|2026-10' && r.famille === 'finances'));
    assert.ok(!rappelsDuJour(e, {}, '2026-11-01', { financesAvancees: false }).some((r) => r.cle.startsWith('bilan')));
  });
});
