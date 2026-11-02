import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dureeComptee } from '../src/services/ReunionService.js';

const Mo = 1024 * 1024;

describe('durée comptée d\'un enregistrement', () => {
  it('compte la durée annoncée, à la minute supérieure', () => {
    // 1 h d'AAC mono 32 kbit/s ≈ 14,4 Mo.
    assert.equal(dureeComptee(14.4 * Mo, 3600), 3600);
    assert.equal(dureeComptee(2 * Mo, 301), 360);
  });
  it('compte une minute au moins', () => {
    assert.equal(dureeComptee(1000, 3), 60);
  });
  it('gonfle une durée trop courte pour le poids du fichier', () => {
    // 14 Mo annoncés pour 5 minutes : impossible, même à 128 kbit/s cela fait ~15 minutes.
    const d = dureeComptee(14 * Mo, 300);
    assert.ok(d >= Math.floor(14 * Mo / 16000), String(d));
  });
  it('ramène une durée trop longue pour le poids du fichier', () => {
    // 1 Mo annoncé pour 10 heures : on ne compte pas plus que ce que le poids permet.
    assert.ok(dureeComptee(1 * Mo, 36000) <= Math.ceil((1 * Mo) / 2000) + 60);
  });
  it('compte le maximum crédible sans durée annoncée', () => {
    assert.equal(dureeComptee(2 * Mo, null), Math.ceil(Math.ceil((2 * Mo) / 2000) / 60) * 60);
    assert.equal(dureeComptee(2 * Mo, Number.NaN), dureeComptee(2 * Mo, null));
  });
});
