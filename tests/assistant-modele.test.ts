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

describe('modèles écartés et proposés', () => {
  it('écarte quelques heures un modèle refusé, sans jamais tout vider', async () => {
    const { ecarterModele, sansEcartes, modelesEcartes, oublierEcartes, DUREE_ECART_MS } = await import('../src/services/assistant-modele.js');
    oublierEcartes();
    const t = 1_000_000;
    assert.equal(ecarterModele('gpt-live-1', t), true);
    assert.equal(ecarterModele('gpt-live-1', t + 1), false);
    assert.deepEqual(sansEcartes(['gpt-live-1', 'gpt-4.1-mini', MODELE_DEFAUT], t + 2), ['gpt-4.1-mini', MODELE_DEFAUT]);
    assert.deepEqual(modelesEcartes(t + 2), ['gpt-live-1']);
    assert.deepEqual(sansEcartes(['gpt-live-1'], t + 2), ['gpt-live-1']);
    assert.deepEqual(sansEcartes(['gpt-live-1', MODELE_DEFAUT], t + DUREE_ECART_MS + 1), ['gpt-live-1', MODELE_DEFAUT]);
    oublierEcartes();
  });
  it('ne propose que des modèles de chat, les conseillés d’abord', async () => {
    const { modelesProposes } = await import('../src/services/assistant-modele.js');
    assert.deepEqual(modelesProposes(['gpt-live-1', 'gpt-realtime', 'gpt-4o-mini-tts', 'text-embedding-3', 'gpt-5.1', 'gpt-4.1-mini', 'gpt-4o-mini', 'dall-e-3']), ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5.1']);
  });
});
