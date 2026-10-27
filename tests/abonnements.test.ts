import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { abonnementsActifs, ajouterMois, avisAbonnement, etatAbonnement, finEssai, prolonger } from '../src/services/abonnements/offres.js';
import { lireEtat, montantTexte, normaliserTelephone } from '../src/services/abonnements/flexpaie.js';

const T0 = new Date('2026-10-27T12:00:00Z');
const jours = (n: number) => new Date(T0.getTime() + n * 86400000);

describe('état de l’abonnement', () => {
  it('ouvre tout quand les abonnements sont coupés', () => {
    const e = etatAbonnement({ role: 'UTILISATEUR' }, T0, false);
    assert.equal(e.offre, 'libre');
    assert.equal(e.pro, true);
  });

  it('laisse toujours passer un admin', () => {
    assert.equal(etatAbonnement({ role: 'ADMIN' }, T0, true).pro, true);
  });

  it('donne Pro pendant l’essai, puis l’offre gratuite', () => {
    const essai = etatAbonnement({ essaiJusqua: jours(3) }, T0, true);
    assert.equal(essai.offre, 'essai');
    assert.equal(essai.joursRestants, 3);
    assert.equal(essai.pro, true);
    const fini = etatAbonnement({ essaiJusqua: jours(-1) }, T0, true);
    assert.equal(fini.offre, 'gratuit');
    assert.equal(fini.pro, false);
    assert.deepEqual(fini.fonctions, []);
  });

  it('ouvre Pro jusqu’à la fin de la période payée, puis le ferme', () => {
    const e = etatAbonnement({ abonnementFinLe: jours(20), abonnementPeriode: 'annuel' }, T0, true);
    assert.equal(e.offre, 'pro');
    assert.equal(e.periode, 'annuel');
    assert.equal(e.joursRestants, 20);
    assert.equal(etatAbonnement({ abonnementFinLe: jours(-1), abonnementPeriode: 'mensuel' }, T0, true).pro, false);
  });

  it('lit ABONNEMENTS=true et place l’essai à 14 jours', () => {
    assert.equal(abonnementsActifs({ ABONNEMENTS: 'true' }), true);
    assert.equal(abonnementsActifs({}), false);
    assert.equal(finEssai(T0).toISOString(), jours(14).toISOString());
  });
});

describe('prolonger Pro après un paiement', () => {
  it('ajoute des mois calendaires sans déborder', () => {
    assert.equal(ajouterMois(new Date('2027-01-31T10:00:00Z'), 1).toISOString(), '2027-02-28T10:00:00.000Z');
    assert.equal(ajouterMois(new Date('2028-02-29T10:00:00Z'), 12).toISOString(), '2029-02-28T10:00:00.000Z');
  });

  it('part de maintenant si Pro est fermé, sinon de la fin en cours', () => {
    assert.equal(prolonger(null, 'mensuel', T0).toISOString(), '2026-11-27T12:00:00.000Z');
    assert.equal(prolonger(jours(-5), 'mensuel', T0).toISOString(), '2026-11-27T12:00:00.000Z');
    assert.equal(prolonger(new Date('2026-11-10T00:00:00Z'), 'annuel', T0).toISOString(), '2027-11-10T00:00:00.000Z');
  });
});

describe('avis d’abonnement', () => {
  it('prévient 3 jours avant la fin de l’essai, dans l’app', () => {
    assert.equal(avisAbonnement({ essaiJusqua: jours(5) }, T0, true), null);
    const a = avisAbonnement({ essaiJusqua: jours(3) }, T0, true);
    assert.match(a!.titre, /3 jours/);
    assert.equal(a!.parEmail, false);
  });

  it('prévient 7 jours puis la veille de la fin de Pro, par email', () => {
    assert.equal(avisAbonnement({ abonnementFinLe: jours(10) }, T0, true), null);
    const a7 = avisAbonnement({ abonnementFinLe: jours(6) }, T0, true)!;
    const a1 = avisAbonnement({ abonnementFinLe: jours(0.5) }, T0, true)!;
    assert.equal(a7.parEmail, true);
    assert.match(a1.titre, /demain/);
    assert.notEqual(a7.cle, a1.cle);
    assert.equal(avisAbonnement({ abonnementFinLe: jours(6) }, T0, false), null);
  });
});

describe('FlexPaie', () => {
  it('met les numéros au format international', () => {
    assert.equal(normaliserTelephone('0812345678'), '243812345678');
    assert.equal(normaliserTelephone('+243 81 234 5678'), '243812345678');
    assert.equal(normaliserTelephone('00243-81-234-5678'), '243812345678');
    assert.equal(normaliserTelephone('12345'), null);
    assert.equal(normaliserTelephone('abc'), null);
  });

  it('écrit les montants en décimal', () => {
    assert.equal(montantTexte(499), '4.99');
    assert.equal(montantTexte(4999), '49.99');
  });

  it('lit l’état d’une transaction', () => {
    assert.equal(lireEtat({ code: '0', transaction: { status: '0' } }), 'paye');
    assert.equal(lireEtat({ code: '0', transaction: { status: 1 } }), 'echoue');
    assert.equal(lireEtat({ code: '0', transaction: { status: '2' } }), 'en_attente');
    assert.equal(lireEtat({ code: '1', transaction: null }), 'en_attente');
  });
});
