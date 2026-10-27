import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adresseSeule, base64Url, enteteEncode, ErreurSaisie, lendemain, messageRfc822, plusMinutes, sujetReponse, verifierRendezvous, verifierTache } from '../src/services/integrations/ecriture.js';

describe('objet d’une réponse', () => {
  it('ajoute « Re: » une seule fois', () => {
    assert.equal(sujetReponse('Devis toiture'), 'Re: Devis toiture');
    assert.equal(sujetReponse('Re: Devis toiture'), 'Re: Devis toiture');
    assert.equal(sujetReponse('RE: re: Devis toiture'), 'Re: Devis toiture');
    assert.equal(sujetReponse('Rép : Devis toiture'), 'Re: Devis toiture');
  });
  it('tient devant un objet vide', () => {
    assert.equal(sujetReponse(''), 'Re: (sans objet)');
  });
});

describe('adresses et en-têtes', () => {
  it('extrait l’adresse d’un « Nom <adresse> »', () => {
    assert.equal(adresseSeule('Marie Dupont <marie@exemple.fr>'), 'marie@exemple.fr');
    assert.equal(adresseSeule('  marie@exemple.fr '), 'marie@exemple.fr');
  });
  it('encode un en-tête accentué, laisse l’ASCII tranquille', () => {
    assert.equal(enteteEncode('Devis toiture'), 'Devis toiture');
    assert.match(enteteEncode('Réunion à Kinshasa'), /^=\?UTF-8\?B\?.+\?=$/);
  });
});

describe('message complet', () => {
  const base = { a: 'Marie Dupont <marie@exemple.fr>', sujet: 'Devis toiture', texte: '  Bonjour Marie,\n\nC’est noté.  ' };
  it('porte le destinataire, l’objet et le texte', () => {
    const m = messageRfc822(base);
    assert.match(m, /^To: marie@exemple\.fr\r\n/);
    assert.match(m, /Subject: Re: Devis toiture/);
    assert.match(m, /Content-Type: text\/plain; charset="UTF-8"/);
    assert.ok(m.endsWith('Bonjour Marie,\n\nC’est noté.'));
  });
  it('raccroche la réponse au fil quand le Message-ID est connu', () => {
    const m = messageRfc822({ ...base, messageId: '<abc@mail.gmail.com>', references: '<debut@mail.com>' });
    assert.match(m, /In-Reply-To: <abc@mail\.gmail\.com>/);
    assert.match(m, /References: <debut@mail\.com> <abc@mail\.gmail\.com>/);
  });
  it('sans Message-ID, pas d’en-tête de fil vide', () => {
    const m = messageRfc822(base);
    assert.ok(!m.includes('In-Reply-To'));
    assert.ok(!m.includes('References'));
  });
  it('refuse une adresse inutilisable ou une réponse vide', () => {
    assert.throws(() => messageRfc822({ ...base, a: 'Marie Dupont' }), ErreurSaisie);
    assert.throws(() => messageRfc822({ ...base, texte: '   ' }), ErreurSaisie);
  });
  it('encode en base64 « URL safe », sans remplissage', () => {
    const b = base64Url('hé ?? ~~~');
    assert.ok(!/[+/=]/.test(b));
    assert.equal(Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'), 'hé ?? ~~~');
  });
});

describe('heures', () => {
  it('ajoute des minutes, sans déborder sur le lendemain', () => {
    assert.equal(plusMinutes('09:30', 60), '10:30');
    assert.equal(plusMinutes('23:45', 60), '23:59');
    assert.equal(plusMinutes('08:05', 55), '09:00');
  });
  it('donne le lendemain d’une date', () => {
    assert.equal(lendemain('2026-10-27'), '2026-10-28');
    assert.equal(lendemain('2026-12-31'), '2027-01-01');
    assert.equal(lendemain('2028-02-28'), '2028-02-29');
  });
});

describe('rendez-vous', () => {
  it('complète la fin manquante par une heure', () => {
    assert.deepEqual(verifierRendezvous({ titre: ' Réunion ', date: '2026-10-27', debut: '09:00' }), { titre: 'Réunion', date: '2026-10-27', journee: false, debut: '09:00', fin: '10:00', lieu: undefined });
  });
  it('garde une fin donnée, et le lieu', () => {
    const r = verifierRendezvous({ titre: 'Dentiste', date: '2026-10-27', debut: '16:00', fin: '16:30', lieu: ' Cabinet ' });
    assert.equal(r.fin, '16:30');
    assert.equal(r.lieu, 'Cabinet');
  });
  it('sans heure, c’est une journée entière', () => {
    assert.deepEqual(verifierRendezvous({ titre: 'Congé', date: '2026-10-27' }), { titre: 'Congé', date: '2026-10-27', journee: true, lieu: undefined });
  });
  it('refuse un titre vide, une date incomplète, une heure mal écrite, une fin avant le début', () => {
    assert.throws(() => verifierRendezvous({ titre: ' ', date: '2026-10-27' }), ErreurSaisie);
    assert.throws(() => verifierRendezvous({ titre: 'X', date: '27/10/2026' }), ErreurSaisie);
    assert.throws(() => verifierRendezvous({ titre: 'X', date: '2026-10-27', debut: '9h' }), ErreurSaisie);
    assert.throws(() => verifierRendezvous({ titre: 'X', date: '2026-10-27', debut: '10:00', fin: '09:00' }), ErreurSaisie);
  });
});

describe('tâche', () => {
  it('nettoie le titre et range l’échéance', () => {
    assert.deepEqual(verifierTache({ titre: ' Payer la facture ', echeance: '2026-11-02' }), { titre: 'Payer la facture', echeance: '2026-11-02', fait: false });
    assert.deepEqual(verifierTache({ titre: 'X', fait: true }), { titre: 'X', echeance: null, fait: true });
  });
  it('refuse un titre vide ou une échéance mal écrite', () => {
    assert.throws(() => verifierTache({ titre: '' }), ErreurSaisie);
    assert.throws(() => verifierTache({ titre: 'X', echeance: '2 novembre' }), ErreurSaisie);
  });
});
