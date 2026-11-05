import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emailRappels } from '../src/services/rappels-email.js';

describe('email des rappels', () => {
  const r = { titre: 'Relancer <Marie>', corps: 'Devis.', mode: 'normal' as const };
  it('ajoute le lien vers l’écran, et échappe le texte', () => {
    const m = emailRappels([r], 'Jeereq', undefined, 'https://me.neevo.app/relances');
    assert.equal(m.sujet, 'Relancer <Marie>');
    assert.match(m.html, /href="https:\/\/me\.neevo\.app\/relances"/);
    assert.match(m.html, /Relancer &lt;Marie&gt;/);
    assert.match(m.texte, /Ouvrir dans Me : https:\/\/me\.neevo\.app\/relances/);
  });
  it('sans adresse de l’app : pas de bouton vide', () => {
    assert.doesNotMatch(emailRappels([r], '').html, /Ouvrir dans Me/);
  });
});
