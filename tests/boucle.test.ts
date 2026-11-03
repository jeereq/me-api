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
    assert.equal(fini.attenteDetail, '');
  });
  it('refuse une réponse illisible', () => {
    assert.equal(lireBoucle('pas du json'), null);
    assert.equal(lireBoucle('{"resume":"x"}'), null);
  });
});
