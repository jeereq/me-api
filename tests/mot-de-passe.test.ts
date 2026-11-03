import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { forceMotDePasse, MDP_MAX, refusMotDePasse } from '../src/commun/mot-de-passe.js';

describe('mots de passe', () => {
  it('refuse le trop court et le trop long', () => {
    assert.ok(refusMotDePasse('Ab1!'));
    assert.ok(refusMotDePasse('a'.repeat(MDP_MAX) + 'bc'));
  });
  it('refuse les mots courants, même décorés', () => {
    for (const m of ['password', 'motdepasse1', 'Azerty123', 'MotDePasse!!', '12345678', '123456789', 'aaaaaaaa', 'abababab', 'kinshasa2026']) assert.ok(refusMotDePasse(m), m);
  });
  it('refuse le nom, l’adresse et le numéro', () => {
    const c = { email: 'jeereq@x.com', nom: 'Jean Paul', telephone: '243817125577' };
    assert.ok(refusMotDePasse('jeereq2026', c));
    assert.ok(refusMotDePasse('JEANPAUL-77', c));
    assert.ok(refusMotDePasse('x817125577x', c));
  });
  it('accepte une phrase facile à retenir, sans symbole imposé', () => {
    assert.equal(refusMotDePasse('le chat dort au soleil'), null);
    assert.equal(refusMotDePasse('tigre-bleu-42'), null);
  });
  it('mesure surtout la longueur', () => {
    assert.equal(forceMotDePasse('password'), 0);
    assert.equal(forceMotDePasse('tigrebleu'), 1);
    assert.equal(forceMotDePasse('tigrebleus1'), 2);
    assert.equal(forceMotDePasse('le chat dort au soleil'), 3);
  });
});
