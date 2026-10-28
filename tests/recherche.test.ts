import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { domaineNu, requeteGmail, requeteOutlook } from '../src/services/integrations/recherche.js';

describe('recherche de mails pour le copilote', () => {
  it('ramène un domaine à sa forme nue', () => {
    for (const s of ['@ovh.com', 'ovh.com', 'https://www.ovh.com/fr/', 'facturation@OVH.com']) assert.equal(domaineNu(s), 'ovh.com', s);
  });
  it('traduit la demande pour Gmail, bornes incluses', () => {
    assert.equal(requeteGmail({ domaine: '@ovh.com', depuis: '2026-10-01', jusqua: '2026-10-31' }), 'from:ovh.com after:2026/10/01 before:2026/11/01');
    assert.equal(requeteGmail({ de: 'Paul Dubois' }), 'from:"Paul Dubois"');
    assert.equal(requeteGmail({}), '');
  });
  it('Outlook : $search pour un expéditeur, la période vérifiée ensuite', () => {
    const { params, garder } = requeteOutlook({ domaine: 'ovh.com', depuis: '2026-10-01', jusqua: '2026-10-31', max: 50 }, 'subject');
    assert.equal(params.get('$search'), '"from:ovh.com"');
    assert.equal(params.has('$filter'), false);
    assert.equal(garder('2026-10-31T22:00:00Z'), true);
    assert.equal(garder('2026-11-01T00:00:00Z'), false);
    assert.equal(garder('2026-09-30T23:59:00Z'), false);
  });
  it('Outlook : un filtre trié sur la date sans expéditeur', () => {
    const { params } = requeteOutlook({ depuis: '2026-10-01', max: 50, suivant: '50' }, 'subject');
    assert.equal(params.get('$filter'), 'receivedDateTime ge 2026-10-01T00:00:00Z');
    assert.equal(params.get('$orderby'), 'receivedDateTime desc');
    assert.equal(params.get('$skip'), '50');
  });
});
