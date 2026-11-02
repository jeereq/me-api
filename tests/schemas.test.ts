import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { actionAbonnementSchema, gestionMembresSchema, putEspaceSchema } from '../src/validators/schemas.js';

const ok = (body: unknown) => putEspaceSchema.safeParse({ body }).success;

describe('PUT /espace : baseRevision', () => {
  it('reste facultatif pour les anciennes versions de l’app', () => {
    assert.equal(ok({ data: { taches: [] } }), true);
  });
  it('accepte 0 (premier enregistrement) et un entier positif', () => {
    assert.equal(ok({ data: {}, baseRevision: 0 }), true);
    assert.equal(ok({ data: {}, baseRevision: 42 }), true);
  });
  it('refuse un négatif, un décimal ou un texte', () => {
    for (const baseRevision of [-1, 1.5, '3', null]) assert.equal(ok({ data: {}, baseRevision }), false);
  });
  it('refuse un document qui n’est pas un objet', () => {
    for (const data of [[], 'texte', null, 3]) assert.equal(ok({ data }), false);
  });
});

describe('onglet Utilisateurs de l’admin', () => {
  const action = (body: unknown) => actionAbonnementSchema.safeParse({ params: { id: 'u1' }, body }).success;
  it('accepte les trois gestes', () => {
    assert.equal(action({ action: 'offrir', formule: 'pro', palier: 2, mois: 3, note: 'espèces' }), true);
    assert.equal(action({ action: 'essai', jours: 14 }), true);
    assert.equal(action({ action: 'retirer' }), true);
  });
  it('refuse un geste inconnu ou des valeurs hors limites', () => {
    assert.equal(action({ action: 'effacer' }), false);
    assert.equal(action({ action: 'offrir', formule: 'gold', mois: 1 }), false);
    assert.equal(action({ action: 'offrir', formule: 'pro', palier: 4, mois: 1 }), false);
    assert.equal(action({ action: 'offrir', formule: 'pro', mois: 25 }), false);
    assert.equal(action({ action: 'essai', jours: 0 }), false);
    assert.equal(action({ action: 'essai', jours: 91 }), false);
  });
  it('lit la liste avec des valeurs par défaut', () => {
    assert.deepEqual(gestionMembresSchema.parse({ query: {} }).query, { filtre: 'tous', q: '', page: 1 });
    assert.equal(gestionMembresSchema.parse({ query: { page: '3' } }).query.page, 3);
    assert.equal(gestionMembresSchema.safeParse({ query: { filtre: 'autre' } }).success, false);
  });
});
