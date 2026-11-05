import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { personnesTrouvees, requetePersonneGmail, requetePersonneOutlook } from '../src/services/integrations/personnes.js';

const nina = { nom: 'Nina Kabila', adresse: 'nina@x.fr' };

describe('trouver une personne dans les mails', () => {
  it('cherche en expéditeur, destinataire et copie', () => {
    assert.equal(requetePersonneGmail('nina'), '{from:nina to:nina cc:nina}');
    assert.equal(requetePersonneGmail('Nina K'), '{from:"Nina K" to:"Nina K" cc:"Nina K"}');
    assert.equal(requetePersonneOutlook('ni"na'), '"participants:nina"');
  });
  it('garde qui correspond, sans doublon ni accent', () => {
    assert.deepEqual(personnesTrouvees([[nina, { adresse: 'NINA@x.fr' }], [{ nom: 'Éric', adresse: 'e@x.fr' }]], 'nin', []), [nina]);
    assert.deepEqual(personnesTrouvees([[{ nom: 'Éric', adresse: 'e@x.fr' }]], 'eri', []), [{ nom: 'Éric', adresse: 'e@x.fr' }]);
  });
  it('retient le nom quand une autre ligne le donne', () => {
    assert.deepEqual(personnesTrouvees([[{ adresse: 'nina@x.fr' }, nina]], 'nina', []), [nina]);
  });
  it('écarte mes adresses et les robots', () => {
    assert.deepEqual(personnesTrouvees([[nina, { adresse: 'no-reply@nina.fr' }]], 'nina', ['NINA@x.fr']), []);
  });
  it('met le début de mot avant le milieu, puis les plus présents', () => {
    const milieu = { adresse: 'martinez@x.fr' };
    const debut = { adresse: 'tina@x.fr' };
    const souvent = { adresse: 'tin@y.fr' };
    assert.deepEqual(personnesTrouvees([[milieu, milieu, debut, souvent, souvent]], 'tin', []), [souvent, debut, milieu]);
  });
  it('attend deux lettres', () => {
    assert.deepEqual(personnesTrouvees([[nina]], 'n', []), []);
  });
});
