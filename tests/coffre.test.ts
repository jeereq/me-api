import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { enCoffre, horsCoffre } from '../src/utils/coffre.js';

describe('coffre des données de mails', () => {
  let avant: string | undefined;
  before(() => {
    avant = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'c'.repeat(40);
  });
  after(() => {
    if (avant === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = avant;
  });

  const mails = { mails: [{ id: '1', sujet: 'Salaire de novembre', contact: 'Zoé', extrait: 'Bonjour Zoé' }] };

  it('rien de lisible en base, et la valeur revient intacte', () => {
    const c = enCoffre(mails);
    assert.ok(!JSON.stringify(c).includes('Salaire'));
    assert.deepEqual(horsCoffre(c), mails);
  });
  it('lit encore ce qui a été écrit en clair', () => {
    assert.deepEqual(horsCoffre(mails), mails);
    assert.equal(horsCoffre(null), null);
    assert.equal(horsCoffre(undefined), null);
  });
  it('illisible : rien plutôt qu’une erreur', () => {
    const c = enCoffre(mails);
    process.env.ENCRYPTION_KEY = 'd'.repeat(40);
    assert.equal(horsCoffre(c), null);
    process.env.ENCRYPTION_KEY = 'c'.repeat(40);
    assert.equal(horsCoffre({ chiffre: 'abîmé' }), null);
  });
});
