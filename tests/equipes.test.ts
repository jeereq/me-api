import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertPeutEcrire, assertPeutGerer, assertResteUnProprietaire, peutEcrire, peutGerer } from '../src/services/equipes/droits.js';
import { creerEquipeSchema, inviterEquipeSchema, roleMembreSchema } from '../src/validators/schemas.js';

describe('Droits dans une équipe', () => {
  it('un lecteur voit tout mais n’écrit rien', () => {
    assert.equal(peutEcrire('LECTEUR'), false);
    assert.equal(peutEcrire('MEMBRE'), true);
    assert.equal(peutEcrire('PROPRIETAIRE'), true);
    assert.throws(() => assertPeutEcrire('LECTEUR'), /lecteur/i);
  });

  it('seul un propriétaire gère l’équipe', () => {
    assert.equal(peutGerer('PROPRIETAIRE'), true);
    assert.equal(peutGerer('MEMBRE'), false);
    assert.throws(() => assertPeutGerer('MEMBRE'), /propriétaire/i);
  });
});

describe('Une équipe garde au moins un propriétaire', () => {
  it('refuse de rétrograder le dernier propriétaire', () => {
    assert.throws(() => assertResteUnProprietaire(['PROPRIETAIRE', 'MEMBRE'], 0, 'MEMBRE'), /propriétaire/i);
  });

  it('refuse de retirer le dernier propriétaire', () => {
    assert.throws(() => assertResteUnProprietaire(['PROPRIETAIRE', 'LECTEUR'], 0, null), /propriétaire/i);
  });

  it('laisse partir un propriétaire quand il en reste un autre', () => {
    assert.doesNotThrow(() => assertResteUnProprietaire(['PROPRIETAIRE', 'PROPRIETAIRE'], 0, null));
    assert.doesNotThrow(() => assertResteUnProprietaire(['PROPRIETAIRE', 'PROPRIETAIRE'], 1, 'MEMBRE'));
  });

  it('laisse nommer un nouveau propriétaire', () => {
    assert.doesNotThrow(() => assertResteUnProprietaire(['PROPRIETAIRE', 'MEMBRE'], 1, 'PROPRIETAIRE'));
  });
});

describe('Validation des équipes', () => {
  it('exige un nom non vide et limite l’emoji', () => {
    assert.equal(creerEquipeSchema.safeParse({ body: { nom: 'Maison' } }).success, true);
    assert.equal(creerEquipeSchema.safeParse({ body: { nom: '   ' } }).success, false);
    assert.equal(creerEquipeSchema.safeParse({ body: { nom: 'Maison', emoji: '🏠' } }).success, true);
    assert.equal(creerEquipeSchema.safeParse({ body: { nom: 'x'.repeat(61) } }).success, false);
  });

  it('nettoie l’email d’invitation et refuse un rôle inconnu', () => {
    const r = inviterEquipeSchema.safeParse({ params: { id: 'e1' }, body: { email: '  Paul@Exemple.FR ', role: 'MEMBRE' } });
    assert.equal(r.success, true);
    assert.equal(r.success && r.data.body.email, 'paul@exemple.fr');
    assert.equal(inviterEquipeSchema.safeParse({ params: { id: 'e1' }, body: { email: 'paul@exemple.fr', role: 'INVITE' } }).success, false);
    assert.equal(inviterEquipeSchema.safeParse({ params: { id: 'e1' }, body: { email: 'pas-un-email', role: 'MEMBRE' } }).success, false);
  });

  it('exige l’équipe, le membre et le rôle pour un changement de rôle', () => {
    assert.equal(roleMembreSchema.safeParse({ params: { id: 'e1', membreId: 'u1' }, body: { role: 'PROPRIETAIRE' } }).success, true);
    assert.equal(roleMembreSchema.safeParse({ params: { id: 'e1' }, body: { role: 'MEMBRE' } }).success, false);
    assert.equal(roleMembreSchema.safeParse({ params: { id: 'e1', membreId: 'u1' }, body: {} }).success, false);
  });
});
