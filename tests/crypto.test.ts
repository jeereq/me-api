import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { chiffrer, dechiffrer } from '../src/utils/crypto.js';

const CLE = 'a'.repeat(40);
let avant: string | undefined;
beforeEach(() => {
  avant = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = CLE;
});
afterEach(() => {
  if (avant === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = avant;
});

describe('chiffrement des jetons', () => {
  it('redonne le texte d’origine, accents et symboles compris', () => {
    for (const t of ['ya29.a0Af-jeton', 'été ✓ — 日本', '']) assert.equal(dechiffrer(chiffrer(t)), t);
  });

  it('ne laisse pas voir le jeton et change à chaque chiffrement (IV aléatoire)', () => {
    const a = chiffrer('secret-token');
    assert.ok(!a.includes('secret-token'));
    assert.notEqual(a, chiffrer('secret-token'));
    assert.equal(a.split('.').length, 3);
  });

  it('refuse une valeur modifiée (authentification GCM)', () => {
    const [iv, tag, data] = chiffrer('secret-token').split('.');
    const abime = Buffer.from(data, 'base64url');
    abime[0] ^= 1;
    assert.throws(() => dechiffrer([iv, tag, abime.toString('base64url')].join('.')));
    assert.throws(() => dechiffrer('nimporte.quoi.ici'));
  });

  it('refuse de déchiffrer avec une autre clé', () => {
    const c = chiffrer('secret-token');
    process.env.ENCRYPTION_KEY = 'b'.repeat(40);
    assert.throws(() => dechiffrer(c));
  });

  it('exige une clé d’au moins 32 caractères', () => {
    process.env.ENCRYPTION_KEY = 'trop-courte';
    assert.throws(() => chiffrer('x'), /ENCRYPTION_KEY/);
    delete process.env.ENCRYPTION_KEY;
    assert.throws(() => chiffrer('x'), /ENCRYPTION_KEY/);
  });
});
