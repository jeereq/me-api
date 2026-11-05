import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mailGarde } from '../src/services/integrations/choix.js';

describe('le mail auquel répondre', () => {
  const liste = [{ id: 'b', fil: 'f1' }, { id: 'c', fil: 'f2' }];
  it('le mail lui-même, s’il est encore là', () => assert.equal(mailGarde(liste, 'c', 'f1')?.id, 'c'));
  it('sinon le dernier message de son fil', () => assert.equal(mailGarde(liste, 'a', 'f1')?.id, 'b'));
  it('rien sans fil ni mail connu', () => {
    assert.equal(mailGarde(liste, 'a'), undefined);
    assert.equal(mailGarde(liste, 'a', 'f9'), undefined);
  });
});
