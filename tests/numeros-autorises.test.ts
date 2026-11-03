import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { numeroOuvert } from '../src/services/sms/numeros.js';

describe('numéros autorisés', () => {
  it('ouvre toujours la RD Congo', () => {
    assert.equal(numeroOuvert('243812345678', []), true);
  });
  it('ferme le reste par défaut', () => {
    assert.equal(numeroOuvert('33612345678', []), false);
  });
  it('ouvre un pays entier', () => {
    const lignes = [{ indicatif: '33', numero: '' }];
    assert.equal(numeroOuvert('33612345678', lignes), true);
    assert.equal(numeroOuvert('32412345678', lignes), false);
  });
  it('ouvre un seul numéro', () => {
    const lignes = [{ indicatif: '33', numero: '612345678' }];
    assert.equal(numeroOuvert('33612345678', lignes), true);
    assert.equal(numeroOuvert('33699999999', lignes), false);
  });
});
