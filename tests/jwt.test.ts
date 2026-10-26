import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import jwt from 'jsonwebtoken';

import { generateToken, verifyToken } from '../src/utils/jwt.js';

const SECRET = 's'.repeat(40);
let avant: string | undefined;
beforeEach(() => {
  avant = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
});
afterEach(() => {
  if (avant === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = avant;
});

describe('sessions JWT', () => {
  it('relit l’identifiant du compte et la date d’émission', () => {
    const t = verifyToken(generateToken({ userId: 'u1' }));
    assert.equal(t.userId, 'u1');
    assert.equal(typeof t.iat, 'number');
  });

  it('refuse un jeton signé avec une autre clé ou modifié', () => {
    const faux = jwt.sign({ userId: 'u1' }, 'autre-cle'.repeat(5));
    assert.throws(() => verifyToken(faux));
    const [h, , s] = generateToken({ userId: 'u1' }).split('.');
    const autre = Buffer.from(JSON.stringify({ userId: 'admin', iat: 1 })).toString('base64url');
    assert.throws(() => verifyToken([h, autre, s].join('.')));
  });

  it('refuse un jeton expiré et un jeton sans signature (alg none)', () => {
    assert.throws(() => verifyToken(jwt.sign({ userId: 'u1' }, SECRET, { expiresIn: -10 })), /expired/);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"userId":"u1"}').toString('base64url')}.`;
    assert.throws(() => verifyToken(none));
  });
});
