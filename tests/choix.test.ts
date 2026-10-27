import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agendasALire, appliquerLibelles, boitesValides, choixValides, extrait, passeNom, rangerMails, type AgendaDispo, type MailImporte } from '../src/services/integrations/choix.js';

const cals: AgendaDispo[] = [
  { id: 'moi@gmail.com', nom: 'Perso', principal: true, visible: true },
  { id: 'boulot', nom: 'Travail', visible: true },
  { id: 'fetes', nom: 'Jours fériés en France', visible: false },
  { id: 'sport', nom: 'Matchs du club', visible: true },
];
const ids = (l: AgendaDispo[]) => l.map((c) => c.id);

describe('agendas à lire', () => {
  it('prend ceux cochés dans l’app, dans l’ordre de la liste', () => {
    assert.deepEqual(ids(agendasALire(cals, ['sport', 'fetes'], [])), ['fetes', 'sport']);
  });
  it('ignore un agenda coché qui a disparu', () => {
    assert.deepEqual(ids(agendasALire(cals, ['boulot', 'partage-supprime'], [])), ['boulot']);
  });
  it('retombe sur le défaut si tous les agendas cochés ont disparu', () => {
    assert.deepEqual(ids(agendasALire(cals, ['parti'], [])), ['moi@gmail.com', 'boulot', 'sport']);
  });
  it('sans choix, utilise le filtre par nom', () => {
    assert.deepEqual(ids(agendasALire(cals, undefined, ['fériés'])), ['fetes']);
    assert.deepEqual(ids(agendasALire(cals, [], ['trav', 'club'])), ['boulot', 'sport']);
  });
  it('sans choix ni filtre, garde ceux affichés par défaut', () => {
    assert.deepEqual(ids(agendasALire(cals, undefined, [])), ['moi@gmail.com', 'boulot', 'sport']);
  });
  it('ne dépasse jamais la limite', () => {
    assert.equal(agendasALire(cals, undefined, [], 2).length, 2);
  });
});

describe('noms filtrés', () => {
  it('sans filtre tout passe ; sinon la casse est ignorée', () => {
    assert.equal(passeNom([], 'Travail'), true);
    assert.equal(passeNom(['TRAV'], 'Travail'), true);
    assert.equal(passeNom(['perso'], undefined, 'Travail'), false);
  });
});

describe('mails rangés', () => {
  const m = (id: string, date: string, heure: string, x: Partial<MailImporte> = {}): MailImporte => ({ id, sujet: `Objet ${id}`, contact: 'Marie', date, heure, sens: 'recu', source: 'gmail', ...x });
  it('garde le message le plus récent de chaque fil, les plus récents d’abord', () => {
    const r = rangerMails([m('a1', '2026-10-20', '09:00', { fil: 'f1' }), m('a2', '2026-10-26', '18:30', { fil: 'f1' }), m('b', '2026-10-25', '08:00', { fil: 'f2' })]);
    assert.deepEqual(r.map((x) => x.id), ['a2', 'b']);
  });
  it('signale le fil dès qu’un de ses messages n’est pas lu', () => {
    const r = rangerMails([m('a1', '2026-10-20', '09:00', { fil: 'f1', nonLu: true }), m('a2', '2026-10-26', '18:30', { fil: 'f1' })]);
    assert.equal(r[0].id, 'a2');
    assert.equal(r[0].nonLu, true);
  });
  it('sans fil, chaque message compte ; sans date, il passe en dernier', () => {
    const r = rangerMails([m('sansdate', '', ''), m('a', '2026-10-26', '10:00')]);
    assert.deepEqual(r.map((x) => x.id), ['a', 'sansdate']);
  });
  it('réunit les étiquettes de tous les messages du fil', () => {
    const r = rangerMails([m('a1', '2026-10-20', '09:00', { fil: 'f1', libelles: ['Facture'] }), m('a2', '2026-10-26', '18:30', { fil: 'f1', libelles: ['Client'] })]);
    assert.deepEqual(r[0].libelles, ['Facture', 'Client']);
  });
  it('un même fil dans deux boîtes (la sienne et une partagée) reste deux lignes', () => {
    const r = rangerMails([m('a', '2026-10-26', '10:00', { fil: 'f1' }), m('b', '2026-10-26', '11:00', { fil: 'f1', boite: 'ventes@x.fr' })]);
    assert.equal(r.length, 2);
  });
  it('ne dépasse pas la limite', () => {
    assert.equal(rangerMails([m('a', '2026-10-26', '10:00'), m('b', '2026-10-25', '10:00'), m('c', '2026-10-24', '10:00')], 2).length, 2);
  });
});

describe('choix encore valides', () => {
  it('retire les agendas qui n’existent plus', () => {
    assert.deepEqual(choixValides(cals, ['boulot', 'parti', 'sport']), ['boulot', 'sport']);
    assert.deepEqual(choixValides(cals, undefined), []);
  });
});

describe('étiquettes et boîtes partagées', () => {
  it('ajoute sans doublon (sans casse) et retire', () => {
    assert.deepEqual(appliquerLibelles(['Client', 'Facture'], ['facture', 'Urgent'], ['client']), ['Facture', 'Urgent']);
    assert.deepEqual(appliquerLibelles([], [], ['X']), []);
  });
  it('garde des adresses valides, en minuscules, sans doublon', () => {
    assert.deepEqual(boitesValides([' Ventes@Exemple.fr ', 'ventes@exemple.fr', 'pas une adresse', 'support@exemple.fr']), ['ventes@exemple.fr', 'support@exemple.fr']);
    assert.equal(boitesValides(Array.from({ length: 15 }, (_x, i) => `b${i}@x.fr`)).length, 10);
  });
  it('un extrait tient sur une ligne et en 160 caractères', () => {
    assert.equal(extrait('Bonjour,\n\n  voici   le devis'), 'Bonjour, voici le devis');
    assert.equal(extrait('a'.repeat(300))!.length, 160);
    assert.equal(extrait('   '), undefined);
  });
});
