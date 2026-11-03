import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lirePlage } from '../src/services/voix/eve.js';

describe('Eve : plages audio', () => {
  it('lit les demandes des lecteurs', () => {
    assert.deepEqual(lirePlage('bytes=0-1', 100), { debut: 0, fin: 1 });
    assert.deepEqual(lirePlage('bytes=10-', 100), { debut: 10, fin: 99 });
    assert.deepEqual(lirePlage('bytes=-5', 100), { debut: 95, fin: 99 });
    assert.deepEqual(lirePlage('bytes=90-500', 100), { debut: 90, fin: 99 });
  });
  it('ignore le reste', () => {
    for (const x of [undefined, 'bytes=-', 'octets=0-1', 'bytes=200-300', 'bytes=5-2']) assert.equal(lirePlage(x, 100), null, String(x));
  });
});
