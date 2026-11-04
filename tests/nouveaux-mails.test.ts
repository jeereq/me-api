import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { annonceMails, mailsAAnnoncer, type MailImporte } from '../src/services/integrations/choix.js';

const m = (id: string, x: Partial<MailImporte> = {}): MailImporte => ({ id, sujet: `Sujet ${id}`, contact: 'Paul', adresse: 'paul@x.fr', date: '2026-11-04', heure: '15:00', sens: 'recu', nonLu: true, source: 'gmail', ...x });
const DEPUIS = '2026-11-04T14:50';

describe('quels mails annoncer', () => {
  it('garde un mail reçu, non lu, nouveau et récent', () => {
    assert.deepEqual(mailsAAnnoncer([], [m('a')], DEPUIS).map((x) => x.id), ['a']);
  });
  it('écarte ce qui était déjà là, lu ou envoyé', () => {
    assert.deepEqual(mailsAAnnoncer([m('a')], [m('a'), m('b', { nonLu: false }), m('c', { sens: 'envoye' })], DEPUIS), []);
  });
  it('écarte un vieux mail qui revient dans la liste', () => {
    assert.deepEqual(mailsAAnnoncer([], [m('vieux', { date: '2026-10-01' }), m('matin', { heure: '09:00' })], DEPUIS), []);
  });
  it('écarte les robots', () => {
    assert.deepEqual(mailsAAnnoncer([], [m('a', { adresse: 'noreply@x.fr' }), m('b', { contact: 'dependabot[bot]' }), m('c', { adresse: 'newsletter@x.fr' })], DEPUIS), []);
  });
  it('un mail sans heure aujourd’hui reste annoncé', () => {
    assert.equal(mailsAAnnoncer([], [m('a', { heure: undefined })], DEPUIS).length, 1);
  });
  it('met le plus récent d’abord', () => {
    assert.deepEqual(mailsAAnnoncer([], [m('a', { heure: '15:00' }), m('b', { heure: '15:30' })], DEPUIS).map((x) => x.id), ['b', 'a']);
  });
});

describe('ce que dit la notification', () => {
  it('un seul mail : qui, l’objet et le lien vers lui', () => {
    assert.deepEqual(annonceMails('g1', [m('a')]), { cle: 'mail:g1:a', titre: 'Nouveau mail de Paul', corps: 'Sujet a', url: '/messages?lire=ext%3Ag1%3Aa' });
  });
  it('tient sans nom ni objet', () => {
    const a = annonceMails('g1', [m('a', { contact: '', sujet: '' })]);
    assert.equal(a.titre, 'Nouveau mail de quelqu’un');
    assert.equal(a.corps, '(sans objet)');
  });
  it('plusieurs mails : un seul message, qui résume', () => {
    assert.equal(annonceMails('g1', [m('a'), m('b')]).corps, 'Paul');
    assert.equal(annonceMails('g1', [m('a'), m('b', { contact: 'Ana' })]).corps, 'Paul et Ana');
    const a = annonceMails('g1', [m('a'), m('b', { contact: 'Ana' }), m('c', { contact: 'Awa' }), m('d', { contact: 'Zoé' })]);
    assert.equal(a.titre, '4 nouveaux mails');
    assert.equal(a.corps, 'Paul, Ana et 2 autres');
    assert.equal(a.url, '/messages');
    assert.equal(a.cle, 'mail:g1:a');
  });
});
