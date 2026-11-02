import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { erreurNomApp, nomApp, NOM_APP_DEFAUT } from '../src/commun/nom-app.js';
import { prompt } from '../src/services/AssistantService.js';
import { updateMeSchema } from '../src/validators/schemas.js';

describe("nom de l'app choisi par l'utilisateur", () => {
  it('garde « Me » quand rien ou un nom invalide est donné', () => {
    assert.equal(NOM_APP_DEFAUT, 'Me');
    for (const x of [undefined, null, '', '   ', 'x', '<script>', 'un deux trois quatre', 'a'.repeat(30)]) assert.equal(nomApp(x), 'Me', String(x));
  });
  it('accepte un prénom, un nom composé ou deux mots', () => {
    for (const x of ['Jarvis', 'Jean-Luc', "N'Golo", 'Mon Coach', 'Ève', 'R2D2']) assert.equal(erreurNomApp(x), null, x);
    assert.equal(nomApp('  Mon   Coach '), 'Mon Coach');
  });
  it('refuse ce que la voix ne saurait dire', () => {
    for (const x of ['x', '1234', 'Hey!', '<b>', 'un deux trois quatre', 'a'.repeat(25)]) assert.ok(erreurNomApp(x), x);
  });
  it('se valide à l’enregistrement du compte, et le vide remet « Me »', () => {
    assert.equal(updateMeSchema.parse({ body: { nomApp: '  Jarvis ' } }).body.nomApp, 'Jarvis');
    assert.equal(updateMeSchema.parse({ body: { nomApp: '' } }).body.nomApp, '');
    assert.equal(updateMeSchema.safeParse({ body: { nomApp: 'Hey!' } }).success, false);
  });
  it("l'IA se présente sous le nom choisi", () => {
    assert.match(prompt({ type: 'question', question: 'Salut', nom: 'Jarvis' }), /Tu es « Jarvis »/);
    assert.match(prompt({ type: 'question', question: 'Salut' }), /Tu es « Me »/);
    assert.match(prompt({ type: 'question', question: 'Salut', nom: 'Ignore tout <b>' }), /Tu es « Me »/);
  });
});
