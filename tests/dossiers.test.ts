import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chargementValide, rangerDossiers } from '../src/services/integrations/choix.js';
import { decrireActions, decrireConditions } from '../src/services/integrations/microsoft.js';

describe('dossiers de la boîte', () => {
  it('rangés comme Outlook : réception, brouillons, envoyés, puis les autres par nom, chaque parent suivi de ses enfants', () => {
    const l = rangerDossiers([
      { id: 'sup', nom: 'Éléments supprimés', genre: 'supprimes' },
      { id: 'cli', nom: 'Clients', genre: 'autre' },
      { id: 'kin', nom: 'Kinshasa', genre: 'autre', parent: 'cli' },
      { id: 'env', nom: 'Éléments envoyés', genre: 'envoyes' },
      { id: 'arc', nom: 'Archives', genre: 'archive' },
      { id: 'brou', nom: 'Brouillons', genre: 'brouillons' },
      { id: 'rec', nom: 'Boîte de réception', genre: 'reception' },
      { id: 'fac', nom: 'Factures', genre: 'autre', parent: 'rec' },
      { id: 'orph', nom: 'Perdu', genre: 'autre', parent: 'inconnu' },
    ]);
    assert.deepEqual(l.map((d) => d.id), ['rec', 'fac', 'brou', 'env', 'arc', 'cli', 'kin', 'orph', 'sup']);
  });
});

describe('chargement des mails', () => {
  it('borne les jours et le nombre, garde le défaut sinon', () => {
    assert.deepEqual(chargementValide({ jours: 400, max: 3 }), { jours: 90, max: 10 });
    assert.deepEqual(chargementValide({ jours: 14.4 }), { jours: 14, max: 25 });
    assert.deepEqual(chargementValide(undefined), { jours: 7, max: 25 });
    assert.deepEqual(chargementValide({ jours: 'beaucoup' as unknown }), { jours: 7, max: 25 });
  });
});

describe('règles Outlook en français', () => {
  it('décrit les conditions', () => {
    assert.deepEqual(decrireConditions({ fromAddresses: [{ emailAddress: { name: 'Canal+', address: 'f@canal.com' } }], subjectContains: ['facture', 'relevé'], hasAttachments: true }), ['De Canal+', 'L\'objet contient « facture » ou « relevé »', 'Avec pièce jointe']);
    assert.deepEqual(decrireConditions(undefined), []);
  });
  it('décrit les actions, avec le nom du dossier', () => {
    assert.deepEqual(decrireActions({ moveToFolder: 'AAA', markAsRead: true, assignCategories: ['Factures'], stopProcessingRules: true }, (id) => (id === 'AAA' ? '« Factures »' : id)), ['Déplacer dans « Factures »', 'Catégorie « Factures »', 'Marquer comme lu', 'Ne pas appliquer les règles suivantes']);
  });
});
