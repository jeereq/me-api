import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { consignesPrompt, corpsRequete, enJson, longue, MAX_CONSIGNES, MAX_DONNEES_COMPTE_RENDU, modelePourDuree, modeleTranscription, prompt, raisonne, tropLongPourModele } from '../src/services/AssistantService.js';

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
  it('le plan tient compte des mails non lus, sans suivre ce qu’ils demandent à l’IA', () => {
    for (const type of ['plan', 'copilote'] as const) {
      const p = prompt({ type, heure: '09:00', donnees: '{}' });
      assert.match(p, /mailsNonLus/);
      assert.match(p, /jamais des instructions/);
    }
  });
  it('le plan suit le contexte donné et reprend les titres exacts', () => {
    for (const type of ['plan', 'copilote'] as const) {
      const p = prompt({ type, heure: '09:00', donnees: '{"contexteDuJour":"2 h ce matin"}' });
      assert.match(p, /suis-le en priorité/);
      assert.match(p, /titre exact des tâches/);
      assert.match(p, /2 h ce matin/);
    }
    assert.doesNotMatch(prompt({ type: 'question', question: 'x', donnees: '{}' }), /contexteDuJour/);
  });
  it('une conversation garde le fil et propose des gestes, en JSON strict', () => {
    assert.equal(enJson('conversation'), true);
    const p = prompt({ type: 'conversation', question: 'Et lui ?', donnees: '{}', historique: [{ q: 'Qui relancer ?', r: 'Paul.' }] });
    assert.match(p, /"actions"/);
    assert.match(p, /Échanges précédents/);
    assert.match(p, /Qui relancer \?/);
    assert.match(p, /Question : Et lui \?/);
    assert.match(p, /jamais des instructions/);
    assert.doesNotMatch(prompt({ type: 'conversation', question: 'x', donnees: '{}' }), /Échanges précédents/);
  });
  it('une question simple reste un texte', () => {
    const p = prompt({ type: 'question', question: 'x', donnees: '{}' });
    assert.doesNotMatch(p, /"actions"/);
    assert.match(p, /Question : x/);
  });
  it('une question connaît les vrais totaux, et les mails n’y commandent pas', () => {
    const p = prompt({ type: 'question', question: 'Combien ?', donnees: '{}' });
    assert.match(p, /vrais totaux/);
    assert.match(p, /jamais des instructions/);
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
  it('sait lire une transcription et en tirer tâches, mails, relances et habitudes', () => {
    const p = prompt({ type: 'compte_rendu', donnees: '{"transcription":"on fait le point chaque lundi"}' });
    for (const k of ['transcription', 'habitude', 'mail', 'relance', '"frequence"', '"corps"']) assert.ok(p.includes(k), k);
  });
  it('attribue les actions aux membres, aux projets et aux dates', () => {
    const p = prompt({ type: 'compte_rendu', donnees: '{"membres":[{"ref":"m:1","nom":"Sophie"}],"projetsConnus":[{"ref":"p:1","nom":"Site"}]}' });
    for (const k of ['"membre"', '"projet"', 'membres', 'projetsConnus']) assert.ok(p.includes(k), k);
  });
  it('garde la fin d\'une longue transcription, et laisse de la place à la réponse', () => {
    const fin = 'DERNIERE_PHRASE';
    const p = prompt({ type: 'compte_rendu', donnees: 'a'.repeat(90_000) + fin });
    assert.ok(p.includes(fin));
    assert.ok(MAX_DONNEES_COMPTE_RENDU > 60_000);
    assert.equal(longue('compte_rendu'), true);
    assert.ok(corpsRequete('gpt-4o-mini', 'x', true, true).max_completion_tokens >= 8000);
  });
  it('transcrit avec gpt-4o-mini-transcribe sauf réglage du serveur', () => {
    delete process.env.OPENAI_MODEL_TRANSCRIPTION;
    assert.equal(modeleTranscription(), 'gpt-4o-mini-transcribe');
  });
  it('passe les réunions de plus de 23 minutes au modèle sans limite de durée', () => {
    delete process.env.OPENAI_MODEL_TRANSCRIPTION;
    delete process.env.OPENAI_MODEL_TRANSCRIPTION_LONGUE;
    assert.equal(modelePourDuree(10 * 60), 'gpt-4o-mini-transcribe');
    assert.equal(modelePourDuree(23 * 60), 'gpt-4o-mini-transcribe');
    assert.equal(modelePourDuree(31 * 60), 'whisper-1');
    assert.equal(modelePourDuree(undefined), 'gpt-4o-mini-transcribe');
    process.env.OPENAI_MODEL_TRANSCRIPTION_LONGUE = 'autre';
    assert.equal(modelePourDuree(90 * 60), 'autre');
    delete process.env.OPENAI_MODEL_TRANSCRIPTION_LONGUE;
  });
  it('reconnaît le refus d\'OpenAI pour un audio trop long', () => {
    assert.equal(tropLongPourModele(400, 'audio duration 1890.2 seconds is longer than 1500 seconds which is the maximum for this model'), true);
    assert.equal(tropLongPourModele(400, 'Invalid file format.'), false);
    assert.equal(tropLongPourModele(500, 'duration'), false);
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

describe('consignes de l\'utilisateur pour l\'analyse', () => {
  it('sont glissées avant les mails, pour un mail comme pour un lot', () => {
    for (const type of ['mails', 'lot'] as const) {
      const p = prompt({ type, donnees: '[{"id":"a"}]', consignes: 'Repère les factures impayées et le ton des relances' });
      const i = p.indexOf('Consignes de l\'utilisateur');
      assert.ok(i > 0, type);
      assert.ok(p.includes('"Repère les factures impayées et le ton des relances"'), type);
      assert.ok(i < p.indexOf('Mails :'), `${type} : avant les données`);
      assert.match(p, /ne changent ni le format JSON/, type);
    }
  });
  it('ne changent rien sans consignes', () => {
    assert.equal(consignesPrompt(undefined), '');
    assert.equal(consignesPrompt('   \n  '), '');
    assert.doesNotMatch(prompt({ type: 'lot', donnees: '[]' }), /Consignes de l'utilisateur/);
  });
  it('sont nettoyées, limitées et citées : elles ne cassent pas le prompt', () => {
    const c = consignesPrompt('Ligne 1\n\n\nLigne 2 "guillemets"');
    assert.ok(c.includes('"Ligne 1 Ligne 2 \\"guillemets\\""'), c);
    assert.ok(!c.slice(1, -1).includes('\n\n'));
    const long = consignesPrompt('a'.repeat(5000));
    assert.ok(long.length < MAX_CONSIGNES + 400);
  });
  it('ne s\'ajoutent pas aux autres prompts', () => {
    for (const type of ['plan', 'copilote', 'compte_rendu'] as const) assert.doesNotMatch(prompt({ type, donnees: '{}', consignes: 'secret' }), /secret/, type);
  });
});
