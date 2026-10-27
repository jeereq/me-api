import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MODELE_DEFAUT, modeleIndisponible, modelesAEssayer } from '../src/services/assistant-modele.js';

describe('modèle retiré par OpenAI', () => {
  it('reconnaît le message de dépréciation', () => {
    assert.equal(modeleIndisponible(404, { error: { message: 'The model `o4-mini-2025-04-16` has been deprecated, learn more here: https://platform.openai.com/docs/deprecations' } }), true);
  });
  it('reconnaît model_not_found et un 404 sans détail', () => {
    assert.equal(modeleIndisponible(404, { error: { code: 'model_not_found' } }), true);
    assert.equal(modeleIndisponible(400, { error: { code: 'model_not_found' } }), true);
    assert.equal(modeleIndisponible(404, undefined), true);
  });
  it('ne confond pas avec les autres erreurs', () => {
    assert.equal(modeleIndisponible(401, { error: { message: 'Incorrect API key provided' } }), false);
    assert.equal(modeleIndisponible(429, { error: { message: 'Rate limit reached' } }), false);
    assert.equal(modeleIndisponible(500, {}), false);
  });
});

describe('modèles à essayer', () => {
  it('admin, puis serveur, puis modèle par défaut, sans doublon', () => {
    assert.deepEqual(modelesAEssayer('o4-mini-2025-04-16', 'gpt-4.1-mini'), ['o4-mini-2025-04-16', 'gpt-4.1-mini', MODELE_DEFAUT]);
    assert.deepEqual(modelesAEssayer(undefined, undefined), [MODELE_DEFAUT]);
    assert.deepEqual(modelesAEssayer(' gpt-4o-mini ', 'gpt-4o-mini'), [MODELE_DEFAUT]);
    assert.deepEqual(modelesAEssayer('', 'gpt-4.1-mini'), ['gpt-4.1-mini', MODELE_DEFAUT]);
  });
});
