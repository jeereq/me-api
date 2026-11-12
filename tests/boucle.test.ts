import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { donneesBoucle, lireBoucle, MAX_BOUCLE } from '../src/services/analyse-mails.js';

describe('boucle de mails', () => {
  const o = { aujourdhui: '2026-11-03', moi: 'moi@x.com', boite: 'pro' };
  it('envoie les messages du plus ancien au dernier', () => {
    const d = donneesBoucle({ de: 'Paul', date: '2026-11-02', sujet: 'Devis', texte: 'Ok pour jeudi', fil: [{ de: 'Moi', date: '2026-11-01', texte: 'Jeudi ?' }, { de: 'Paul', date: '2026-10-30', texte: '' }] }, o);
    assert.deepEqual(d.messages.map((m) => m.texte), ['Jeudi ?', 'Ok pour jeudi']);
    assert.equal(d.moi, 'moi@x.com');
    assert.equal(d.sujet, 'Devis');
  });
  it('préfère le message seul, sans signature', () => {
    const d = donneesBoucle({ texte: 'Ok\nAwa', message: 'Ok', fil: [{ de: 'P', texte: 'Jeudi ?\nPaul Kasongo', message: 'Jeudi ?' }, { de: 'A', texte: 'Vu', message: '' }] }, o);
    assert.deepEqual(d.messages.map((m) => m.texte), ['Jeudi ?', 'Vu', 'Ok']);
  });
  it('se limite aux derniers messages', () => {
    const fil = Array.from({ length: 20 }, (_, i) => ({ de: 'A', texte: `m${i}` }));
    const d = donneesBoucle({ texte: 'fin', fil }, o);
    assert.equal(d.messages.length, MAX_BOUCLE);
    assert.equal(d.messages.at(-1)!.texte, 'fin');
    assert.equal(d.messages[0].texte, 'm11');
  });
  it('prend l’extrait quand le mail n’a pas de texte', () => {
    assert.equal(donneesBoucle({}, { ...o, extrait: 'début' }).messages[0].texte, 'début');
    assert.equal(donneesBoucle({}, o).messages.length, 0);
  });
  const reponse = { sujet: 'Devis du site', resume: 'Paul attend.', etapes: [{ qui: 'Paul', quoi: 'Envoie le devis', date: '2026-11-01' }, { qui: 'Toi', quoi: '', date: null }, { qui: 'Toi', quoi: 'Confirme', date: 'hier' }], decisions: ['Jeudi', ''], ouverts: ['Le prix ?'], attente: 'toi', attente_detail: 'Valider', reponse: 'Bonjour' };
  it('garde ce que l’app affiche', () => {
    const r = lireBoucle(JSON.stringify(reponse))!;
    assert.deepEqual(r.etapes, [{ qui: 'Paul', quoi: 'Envoie le devis', date: '2026-11-01' }, { qui: 'Toi', quoi: 'Confirme', date: undefined }]);
    assert.deepEqual(r.decisions, ['Jeudi']);
    assert.equal(r.attenteDetail, 'Valider');
    assert.equal(r.reponse, 'Bonjour');
  });
  it('ne propose une réponse que si la balle est chez l’utilisateur', () => {
    const r = lireBoucle(JSON.stringify({ ...reponse, attente: 'eux' }))!;
    assert.equal(r.reponse, '');
    assert.equal(r.attenteDetail, 'Valider');
    const fini = lireBoucle(JSON.stringify({ ...reponse, attente: 'autre' }))!;
    assert.equal(fini.attente, 'personne');
    // La raison reste : elle dit pourquoi il n'y a pas à répondre.
    assert.equal(fini.attenteDetail, 'Valider');
    assert.equal(fini.reponse, '');
  });
  it('refuse une réponse illisible', () => {
    assert.equal(lireBoucle('pas du json'), null);
    assert.equal(lireBoucle('{"resume":"x"}'), null);
  });
});

describe('analyse par paquets', () => {
  const o = { aujourdhui: '2026-11-03', moi: 'moi@x.com', boite: 'pro' };
  it('une conversation courte tient en un seul paquet', async () => {
    const { paquetsBoucle } = await import('../src/services/analyse-mails.js');
    const r = paquetsBoucle({ de: 'Paul', texte: 'Ok', fil: [{ de: 'Moi', texte: 'Jeudi ?' }] }, o);
    assert.equal(r.paquets.length, 1);
    assert.deepEqual(r.paquets[0].map((m) => m.texte), ['Jeudi ?', 'Ok']);
    assert.equal(r.omis, 0);
  });
  it('une longue conversation est coupée en paquets consécutifs, dans l’ordre', async () => {
    const { paquetsBoucle } = await import('../src/services/analyse-mails.js');
    const fil = Array.from({ length: 10 }, (_, i) => ({ de: i % 2 ? 'Moi' : 'Paul', texte: `m${i} ${'x'.repeat(400)}` }));
    const r = paquetsBoucle({ de: 'Paul', texte: 'fin', fil }, o, 1000);
    assert.ok(r.paquets.length > 1);
    assert.ok(r.paquets.every((p) => p.reduce((n, x) => n + x.texte.length, 0) <= 1000));
    const textes = r.paquets.flat().map((x) => x.texte.slice(0, 2));
    assert.deepEqual(textes, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'fi']);
    assert.equal(r.paquets.at(-1)!.at(-1)!.texte, 'fin');
  });
  it('un très long mail est découpé en parties, sans rien perdre', async () => {
    const { paquetsBoucle, decouper } = await import('../src/services/analyse-mails.js');
    const long = Array.from({ length: 300 }, (_, i) => `Ligne ${i} du long message.`).join('\n');
    const morceaux = decouper(long, 2000);
    assert.ok(morceaux.length > 1 && morceaux.every((x) => x.length <= 2000));
    assert.equal(morceaux.join('\n').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
    const r = paquetsBoucle({ de: 'Paul', texte: long }, o, 2000);
    const parties = r.paquets.flat();
    assert.equal(parties[0].partie, `1/${parties.length}`);
    assert.ok(r.paquets.length > 1);
  });
  it('au plus 6 paquets : les plus anciens sont laissés de côté et signalés', async () => {
    const { paquetsBoucle, MAX_PAQUETS } = await import('../src/services/analyse-mails.js');
    const fil = Array.from({ length: 30 }, (_, i) => ({ de: 'A', texte: `m${i} ${'x'.repeat(900)}` }));
    const r = paquetsBoucle({ de: 'B', texte: 'fin', fil }, o, 1000);
    assert.equal(r.paquets.length, MAX_PAQUETS);
    assert.ok(r.omis > 0);
    assert.equal(r.paquets.at(-1)!.at(-1)!.texte, 'fin');
  });
  it('les réponses arrivées après le mail ouvert ne passent pas avant lui', async () => {
    const { paquetsBoucle } = await import('../src/services/analyse-mails.js');
    const r = paquetsBoucle({ de: 'Paul', texte: 'Ok', fil: [{ de: 'Moi', texte: 'Avant' }, { de: 'Moi', texte: 'Plus tard', apres: true }] }, o);
    assert.deepEqual(r.paquets.flat().map((x) => x.texte), ['Avant', 'Ok']);
  });
});

describe('très long mail', () => {
  it('garde toutes les parties jusqu’au maximum, sinon le début et la fin', async () => {
    const { partiesRetenues } = await import('../src/services/analyse-mails.js');
    const parties = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
    assert.deepEqual(partiesRetenues(parties.slice(0, 3)).map((p) => p.numero), [1, 2, 3]);
    assert.deepEqual(partiesRetenues(parties, 6).map((p) => p.numero), [1, 2, 3, 8, 9, 10]);
    assert.deepEqual(partiesRetenues(parties, 5).map((p) => p.numero), [1, 2, 3, 9, 10]);
  });
});
