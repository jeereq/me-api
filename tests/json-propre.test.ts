import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jsonPropre, textePropre } from '../src/utils/json.js';

// Un aperçu de mail coupé au milieu d'un emoji faisait échouer toute la synchronisation (« unexpected end of hex escape »).
test('une moitié d’emoji isolée est remplacée', () => {
  const coupe = 'Bonjour 😀'.slice(0, -1);
  assert.equal(textePropre(coupe), 'Bonjour �');
  assert.equal(textePropre('\uDE00 fin'), '� fin');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(textePropre(coupe))));
});

test('les emojis entiers et le texte normal restent intacts', () => {
  assert.equal(textePropre('Café 😀 ok'), 'Café 😀 ok');
});

test('le caractère nul est retiré', () => {
  assert.equal(textePropre('a\u0000b'), 'ab');
});

test('nettoie en profondeur sans toucher aux autres valeurs', () => {
  const d = { mails: [{ id: 'm1', apercu: 'x\uD83D', lu: true, n: 3, vide: null }], agenda: [] };
  assert.deepEqual(jsonPropre(d), { mails: [{ id: 'm1', apercu: 'x�', lu: true, n: 3, vide: null }], agenda: [] });
});
