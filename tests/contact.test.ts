import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adresseContact, emailContact } from '../src/services/contact.js';

describe('formulaire de contact', () => {
  const base = { nom: 'Paul', email: 'paul@x.com', message: 'Bonjour, une question.' };
  it('met le téléphone seulement s’il est donné', () => {
    assert.equal(emailContact(base).texte.includes('Téléphone'), false);
    assert.match(emailContact({ ...base, telephone: '+243 81' }).texte, /Téléphone : \+243 81/);
  });
  it('échappe le HTML du visiteur', () => {
    const m = emailContact({ ...base, nom: '<b>x</b>', message: '<script>alert(1)</script>' });
    assert.equal(m.html.includes('<script>'), false);
    assert.equal(m.html.includes('<b>x'), false);
  });
  it('garde l’objet sur une seule ligne et court', () => {
    const m = emailContact({ ...base, nom: `a\r\nBcc: x@y.z ${'b'.repeat(200)}` });
    assert.equal(/[\r\n]/.test(m.sujet), false);
    assert.ok(m.sujet.length <= 120);
  });
  it('envoie à l’adresse configurée, sinon à celle du site', () => {
    assert.equal(adresseContact({ CONTACT_EMAIL: ' a@b.c ' }), 'a@b.c');
    assert.equal(adresseContact({}), 'mingandajeereq@gmail.com');
  });
});
