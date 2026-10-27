import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { corpsRequete, raisonne } from '../src/services/AssistantService.js';

describe('assistant : requête OpenAI', () => {
  it('reconnaît les modèles qui raisonnent', () => {
    for (const m of ['o3', 'o4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5.1']) assert.equal(raisonne(m), true, m);
    for (const m of ['gpt-4o-mini', 'gpt-4.1', 'gpt-5-chat-latest', 'chatgpt-4o-latest', 'o1-mini']) assert.equal(raisonne(m), false, m);
  });
  it('laisse de la place à la réflexion pour ne pas renvoyer un texte vide', () => {
    const c = corpsRequete('gpt-5-mini', 'Bonjour');
    assert.equal(c.reasoning_effort, 'low');
    assert.ok(c.max_completion_tokens >= 4000);
  });
  it("n'envoie pas reasoning_effort aux modèles classiques", () => {
    const c = corpsRequete('gpt-4o-mini', 'Bonjour');
    assert.equal('reasoning_effort' in c, false);
    assert.equal(c.max_completion_tokens, 900);
  });
});
