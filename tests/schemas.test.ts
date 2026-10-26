import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { putEspaceSchema } from '../src/validators/schemas.js';

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
