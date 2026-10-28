import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diagnostiquer, expliquerRefus } from '../src/services/integrations/erreurs.js';

describe('diagnostiquer', () => {
  it('API non activée dans Google Cloud : reconnecter ne sert à rien', () => {
    const d = diagnostiquer('Google Agenda', 403, { error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'accessNotConfigured' }] } });
    assert.equal(d.auth, false);
    assert.match(d.message, /pas activée dans Google Cloud/);
    const d2 = diagnostiquer('Google', 403, { error: { details: [{ reason: 'SERVICE_DISABLED' }] } });
    assert.equal(d2.auth, false);
  });

  it('autorisation retirée ou expirée : demander de reconnecter', () => {
    const d = diagnostiquer('Google', 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    assert.equal(d.auth, true);
    assert.match(d.message, /expiré|retirée/);
  });

  it('autorisations insuffisantes : demander de reconnecter', () => {
    const d = diagnostiquer('Gmail', 403, { error: { errors: [{ reason: 'insufficientPermissions' }], status: 'PERMISSION_DENIED' } });
    assert.equal(d.auth, true);
    assert.match(d.message, /insuffisantes/);
  });

  it('401 et 403 sans détail : reconnecter ; limite de débit : réessayer', () => {
    assert.equal(diagnostiquer('Google', 401, {}).auth, true);
    assert.equal(diagnostiquer('Google', 403, {}).message, 'Accès refusé : reconnecte ce compte.');
    const d = diagnostiquer('Google', 403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } });
    assert.equal(d.auth, false);
    assert.match(d.message, /réessaie/);
  });

  it('autres erreurs : le code reste visible', () => {
    assert.deepEqual(diagnostiquer('Gmail', 500, {}), { message: 'Gmail a répondu 500.', auth: false });
  });
});

describe('expliquerRefus (comptes d’un autre domaine)', () => {
  it('compte d’un autre annuaire : l’application Azure doit être multi-annuaires', () => {
    const m = expliquerRefus('AADSTS50020: User account \'x@autre.com\' from identity provider does not exist in tenant');
    assert.match(m ?? '', /autre domaine/);
    assert.match(m ?? '', /common/);
    assert.match(expliquerRefus('AADSTS700016: Application with identifier was not found in the directory') ?? '', /autre domaine/);
  });

  it('consentement administrateur, accès conditionnel, droit d’usage', () => {
    assert.match(expliquerRefus('AADSTS65001: The user or administrator has not consented to use the application') ?? '', /administrateur de ce domaine/);
    assert.match(expliquerRefus('AADSTS90094: Admin consent is required') ?? '', /consentement administrateur/);
    assert.match(expliquerRefus('AADSTS53003: Access has been blocked by Conditional Access policies') ?? '', /accès conditionnel/);
    assert.match(expliquerRefus('AADSTS50105: user is not assigned to a role') ?? '', /droit d’utiliser/);
  });

  it('configuration du serveur : adresse de retour, secret', () => {
    assert.match(expliquerRefus('AADSTS50011: The redirect URI does not match') ?? '', /adresse de retour/);
    assert.match(expliquerRefus('AADSTS7000222: client secret keys are expired') ?? '', /secret/);
  });

  it('Google : application interne, accès bloqué par l’administrateur', () => {
    assert.match(expliquerRefus('Error 403: org_internal') ?? '', /un seul domaine/);
    assert.match(expliquerRefus('admin_policy_enforced') ?? '', /bloque/);
  });

  it('une erreur inconnue n’est pas inventée ; diagnostiquer s’en sert pour un refus de domaine', () => {
    assert.equal(expliquerRefus('Connexion annulée.'), null);
    assert.equal(expliquerRefus(''), null);
    const d = diagnostiquer('Microsoft', 400, { error: 'invalid_request', error_description: 'AADSTS65001: consent' });
    assert.equal(d.auth, false);
    assert.match(d.message, /administrateur/);
  });
});
