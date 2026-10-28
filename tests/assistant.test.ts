import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { corpsRequete, enJson, prompt, raisonne } from '../src/services/AssistantService.js';

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

describe('assistant : copilote et analyse des mails', () => {
  it('demande du JSON, avec plus de place, pour le copilote et les mails', () => {
    for (const type of ['copilote', 'mails'] as const) assert.equal(enJson(type), true, type);
    for (const type of ['plan', 'question', 'relance'] as const) assert.equal(enJson(type), false, type);
    const c = corpsRequete('gpt-4o-mini', 'x', true);
    assert.deepEqual(c.response_format, { type: 'json_object' });
    assert.ok(c.max_completion_tokens >= 2000);
    assert.equal('response_format' in corpsRequete('gpt-4o-mini', 'x'), false);
  });
  it('le copilote rend un plan et des propositions convertibles en tâches', () => {
    const p = prompt({ type: 'copilote', heure: '14:05', donnees: '{"aujourdhui":"2026-10-27"}' });
    assert.match(p, /"propositions"/);
    assert.match(p, /"plan"/);
    assert.match(p, /14:05/);
  });
  it('les mails sont analysés un par un, avec une réponse proposée', () => {
    const p = prompt({ type: 'mails', donnees: '[{"id":"g:1","de":"Paul","sujet":"Devis"}]' });
    assert.match(p, /"analyses"/);
    assert.match(p, /"reponse"/);
    assert.match(p, /g:1/);
  });
});

describe('assistant : analyse d’un lot de mails', () => {
  it('demande une synthèse d’ensemble, des actions et l’analyse de chaque mail', () => {
    const p = prompt({ type: 'lot', perimetre: 'les mails de @ovh.com en octobre', donnees: '[{"id":"g:1"}]' });
    for (const k of ['"synthese"', '"points"', '"actions"', '"analyses"', '@ovh.com en octobre', 'g:1']) assert.ok(p.includes(k), k);
  });
  it('laisse plus de place à un lot', () => {
    assert.equal(enJson('lot'), true);
    assert.ok(corpsRequete('gpt-4o-mini', 'x', true, true).max_completion_tokens > corpsRequete('gpt-4o-mini', 'x', true).max_completion_tokens);
  });
});

describe('assistant : compte rendu', () => {
  it('demande un résumé, les décisions, les actions et les éléments à clôturer', () => {
    const p = prompt({ type: 'compte_rendu', donnees: '{"notes":"Devis envoyé","ouverts":[{"ref":"t:1"}]}' });
    for (const k of ['"resume"', '"decisions"', '"actions"', '"clotures"', '"ref"', 't:1']) assert.ok(p.includes(k), k);
    assert.equal(enJson('compte_rendu'), true);
  });
});

describe('prompt de relance', () => {
  it('reste simple pour une première relance', () => {
    const p = prompt({ type: 'relance', contact: 'Marie', sujet: 'Devis', boite: 'pro' });
    assert.match(p, /Marie/);
    assert.doesNotMatch(p, /relance numéro/);
  });
  it('se fait plus direct après des relances, et reprend la note', () => {
    const p = prompt({ type: 'relance', contact: 'Marie', sujet: 'Devis', boite: 'pro', deja: 2, note: 'devis de 1 200 € envoyé le 3' });
    assert.match(p, /relance numéro 3/);
    assert.match(p, /devis de 1 200 € envoyé le 3/);
  });
});
