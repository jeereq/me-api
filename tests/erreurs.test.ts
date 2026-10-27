import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diagnostiquer } from '../src/services/integrations/erreurs.js';

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
