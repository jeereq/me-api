import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { etatInvitation, invitationPourApp, invitationsAffichables, memeAdresse } from '../src/services/equipes/invitations.js';

const inv = (extra = {}) => ({ id: 'i1', email: 'paul@exemple.fr', role: 'MEMBRE', parNom: 'Alice', expireLe: new Date('2026-11-04T10:00:00Z'), ouverteLe: null as Date | null, ouvertePar: null as string | null, ...extra });

describe('adresses', () => {
  it('se comparent sans majuscules ni espaces', () => {
    assert.equal(memeAdresse('Paul@Exemple.fr', ' paul@exemple.fr '), true);
    assert.equal(memeAdresse('paul@exemple.fr', 'pierre@exemple.fr'), false);
  });
});

describe('état d’une invitation en attente', () => {
  it('envoyée tant que personne n’a ouvert le lien', () => {
    assert.equal(etatInvitation(inv()), 'envoyee');
  });
  it('ouverte avec le compte invité : elle attend le clic sur « Rejoindre »', () => {
    assert.equal(etatInvitation(inv({ ouverteLe: new Date(), ouvertePar: 'Paul@exemple.fr' })), 'ouverte');
    assert.equal(etatInvitation(inv({ ouverteLe: new Date(), ouvertePar: null })), 'ouverte');
  });
  it('ouverte avec une autre adresse : elle ne pourra jamais être acceptée telle quelle', () => {
    assert.equal(etatInvitation(inv({ ouverteLe: new Date(), ouvertePar: 'paul.perso@gmail.com' })), 'autre_compte');
  });
});

describe('invitations montrées au propriétaire', () => {
  it('celle d’une adresse déjà membre disparaît de la liste', () => {
    const l = [inv(), inv({ id: 'i2', email: 'zoe@exemple.fr' })];
    assert.deepEqual(invitationsAffichables(l, ['PAUL@exemple.fr', 'alice@exemple.fr']).map((x) => x.id), ['i2']);
    assert.equal(invitationsAffichables(l, []).length, 2);
  });

  it('l’app reçoit l’état, l’ouverture, et l’autre adresse seulement quand c’en est une', () => {
    assert.deepEqual(invitationPourApp(inv()), { id: 'i1', email: 'paul@exemple.fr', role: 'MEMBRE', parNom: 'Alice', expireLe: '2026-11-04T10:00:00.000Z', etat: 'envoyee' });
    const ouvre = new Date('2026-10-30T08:00:00Z');
    const a = invitationPourApp(inv({ ouverteLe: ouvre, ouvertePar: 'paul.perso@gmail.com' }));
    assert.equal(a.etat, 'autre_compte');
    assert.equal(a.ouvertePar, 'paul.perso@gmail.com');
    assert.equal(a.ouverteLe, '2026-10-30T08:00:00.000Z');
    const b = invitationPourApp(inv({ ouverteLe: ouvre, ouvertePar: 'paul@exemple.fr' }));
    assert.equal(b.etat, 'ouverte');
    assert.equal('ouvertePar' in b, false);
  });
});
