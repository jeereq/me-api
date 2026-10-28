import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aDesAffectations, MAX_AVIS_PAR_ENREGISTREMENT, nouvellesAffectations } from '../src/services/equipes/affectations.ts';

const membres = new Set(['alice', 'bob', 'chloe']);
const tache = (id: string, extra: Record<string, unknown> = {}) => ({ id, titre: `Tâche ${id}`, statut: 'en_attente', echeance: null, ...extra });
const espace = (...taches: Record<string, unknown>[]) => ({ taches });

test('une tâche confiée à un autre membre prévient ce membre', () => {
  const r = nouvellesAffectations(espace(tache('t1')), espace(tache('t1', { affecteA: 'bob', echeance: '2026-11-05' })), 'alice', membres);
  assert.deepEqual(r, [{ genre: 'tache', id: 't1', titre: 'Tâche t1', echeance: '2026-11-05', userId: 'bob' }]);
});

test('une tâche créée déjà affectée prévient aussi, même sans ancienne version', () => {
  assert.equal(nouvellesAffectations(null, espace(tache('t1', { affecteA: 'bob' })), 'alice', membres).length, 1);
  assert.equal(nouvellesAffectations(undefined, espace(tache('t1', { affecteA: 'bob' })), 'alice', membres).length, 1);
});

test('rien à signaler quand l’affectation n’a pas changé', () => {
  const avant = espace(tache('t1', { affecteA: 'bob' }));
  assert.deepEqual(nouvellesAffectations(avant, espace(tache('t1', { affecteA: 'bob', titre: 'Autre titre' })), 'alice', membres), []);
});

test('changer de personne prévient la nouvelle, pas l’ancienne', () => {
  const r = nouvellesAffectations(espace(tache('t1', { affecteA: 'bob' })), espace(tache('t1', { affecteA: 'chloe' })), 'alice', membres);
  assert.deepEqual(r.map((x) => x.userId), ['chloe']);
});

test('on ne prévient pas celui qui s’affecte lui-même', () => {
  assert.deepEqual(nouvellesAffectations(espace(tache('t1')), espace(tache('t1', { affecteA: 'alice' })), 'alice', membres), []);
});

test('ni quelqu’un qui n’est pas membre de l’équipe', () => {
  assert.deepEqual(nouvellesAffectations(espace(tache('t1')), espace(tache('t1', { affecteA: 'intrus' })), 'alice', membres), []);
});

test('ni une tâche déjà faite', () => {
  assert.deepEqual(nouvellesAffectations(espace(tache('t1')), espace(tache('t1', { affecteA: 'bob', statut: 'fait' })), 'alice', membres), []);
});

test('plusieurs tâches pour la même personne : une entrée par tâche', () => {
  const r = nouvellesAffectations(espace(), espace(tache('t1', { affecteA: 'bob' }), tache('t2', { affecteA: 'bob' }), tache('t3', { affecteA: 'chloe' })), 'alice', membres);
  assert.deepEqual(r.map((x) => [x.id, x.userId]), [['t1', 'bob'], ['t2', 'bob'], ['t3', 'chloe']]);
});

test('une échéance qui n’est pas une date est ignorée, un titre trop long est coupé', () => {
  const r = nouvellesAffectations(null, espace(tache('t1', { affecteA: 'bob', echeance: 'demain', titre: 'x'.repeat(500) })), 'alice', membres);
  assert.equal(r[0].echeance, null);
  assert.equal(r[0].titre.length, 200);
});

test('le nombre d’avis par enregistrement est plafonné', () => {
  const beaucoup = Array.from({ length: 100 }, (_, i) => tache(`t${i}`, { affecteA: 'bob' }));
  assert.equal(nouvellesAffectations(null, espace(...beaucoup), 'alice', membres).length, MAX_AVIS_PAR_ENREGISTREMENT);
});

test('un document sans liste de tâches, ou mal formé, ne casse rien', () => {
  for (const x of [null, undefined, 42, 'texte', {}, { taches: 'non' }, { taches: [null, 3, 'a'] }]) {
    assert.deepEqual(nouvellesAffectations(x, x, 'alice', membres), []);
    assert.equal(aDesAffectations(x), false);
  }
});

test('aDesAffectations repère une tâche affectée', () => {
  assert.equal(aDesAffectations(espace(tache('t1'), tache('t2', { affecteA: 'bob' }))), true);
  assert.equal(aDesAffectations(espace(tache('t1', { affecteA: '' }))), false);
});

test('une relance confiée à un membre prévient ce membre, sauf si elle est déjà obtenue', () => {
  const relance = (id: string, extra: Record<string, unknown> = {}) => ({ id, contact: 'Marie', sujet: 'Devis du site', date: '2026-11-03', statut: 'a_faire', ...extra });
  const r = nouvellesAffectations({ relances: [relance('r1')] }, { relances: [relance('r1', { affecteA: 'bob' })] }, 'alice', membres);
  assert.deepEqual(r, [{ genre: 'relance', id: 'r1', titre: 'Marie · Devis du site', echeance: '2026-11-03', userId: 'bob' }]);
  assert.deepEqual(nouvellesAffectations(null, { relances: [relance('r1', { affecteA: 'bob', statut: 'repondu' })] }, 'alice', membres), []);
  // Sans changement, ou à soi-même : rien.
  assert.deepEqual(nouvellesAffectations({ relances: [relance('r1', { affecteA: 'bob' })] }, { relances: [relance('r1', { affecteA: 'bob', sujet: 'Autre' })] }, 'alice', membres), []);
  assert.deepEqual(nouvellesAffectations(null, { relances: [relance('r1', { affecteA: 'alice' })] }, 'alice', membres), []);
});

test('un rendez-vous affecté prévient ce membre, avec son jour', () => {
  const agenda = (extra: Record<string, unknown> = {}) => ({ agenda: { '2026-11-04': [{ id: 'me:1', debut: '09:00', titre: 'Point client', ...extra }], '2026-11-05': [] } });
  const r = nouvellesAffectations(agenda(), agenda({ affecteA: 'chloe' }), 'alice', membres);
  assert.deepEqual(r, [{ genre: 'rdv', id: 'me:1', titre: 'Point client', echeance: '2026-11-04', userId: 'chloe' }]);
  assert.deepEqual(nouvellesAffectations(agenda({ affecteA: 'chloe' }), agenda({ affecteA: 'chloe' }), 'alice', membres), []);
  // Un rendez-vous sans identifiant (importé d'un agenda) ne peut pas être suivi : il est ignoré.
  assert.deepEqual(nouvellesAffectations(null, { agenda: { '2026-11-04': [{ titre: 'X', affecteA: 'bob' }] } }, 'alice', membres), []);
});

test('une tâche, une relance et un rendez-vous de même identifiant ne se confondent pas', () => {
  const apres = { taches: [tache('x', { affecteA: 'bob' })], relances: [{ id: 'x', contact: 'Marie', sujet: '', date: null, statut: 'a_faire', affecteA: 'bob' }], agenda: { '2026-11-04': [{ id: 'x', titre: 'RDV', affecteA: 'bob' }] } };
  assert.deepEqual(nouvellesAffectations(null, apres, 'alice', membres).map((x) => x.genre), ['tache', 'relance', 'rdv']);
  assert.equal(aDesAffectations({ relances: apres.relances }), true);
  assert.equal(aDesAffectations({ agenda: apres.agenda }), true);
  assert.equal(aDesAffectations({ agenda: { '2026-11-04': [{ id: 'x', titre: 'RDV' }] } }), false);
});
