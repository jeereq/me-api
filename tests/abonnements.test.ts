import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PALIERS, ESSAI_REUNION_MINUTES, moisReunions, palierDe, prixPeriode, aDroit, abonnementsActifs, ajouterMois, avisAbonnement, debutAbonnements, etatAbonnement, finEssai, finEssaiEffective, formuleDe, messageReserve, OFFRES, prolonger } from '../src/services/abonnements/offres.js';
import { empreintesCompte, normaliserEmail } from '../src/services/abonnements/essai-unique.js';
import { base64Strict, erreurFlexpaie, jetonFlexpaie, lireEtat, montantTexte, normaliserTelephone, problemeJeton } from '../src/services/abonnements/flexpaie.js';

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

describe('mise en service des abonnements', () => {
  it('lit ABONNEMENTS_DEPUIS', () => {
    assert.equal(debutAbonnements({ ABONNEMENTS_DEPUIS: '2026-11-15' })?.toISOString(), '2026-11-15T00:00:00.000Z');
    assert.equal(debutAbonnements({}), null);
    assert.equal(debutAbonnements({ ABONNEMENTS_DEPUIS: 'bientôt' }), null);
  });

  it('donne au moins 14 jours d’essai à partir de la mise en service', () => {
    // Essai noté à la migration, expiré depuis longtemps quand on active les abonnements.
    const ancien = jours(-60);
    assert.equal(finEssaiEffective(ancien, T0)?.toISOString(), jours(14).toISOString());
    const e = etatAbonnement({ essaiJusqua: ancien }, jours(10), true, T0);
    assert.equal(e.offre, 'essai');
    assert.equal(e.joursRestants, 4);
    assert.equal(etatAbonnement({ essaiJusqua: ancien }, jours(15), true, T0).offre, 'gratuit');
    // L'avis de fin d'essai part bien, 3 jours avant la fin repoussée.
    assert.match(avisAbonnement({ essaiJusqua: ancien }, jours(11), true, T0)!.titre, /3 jours/);
  });

  it('garde un essai plus long, et ne crée pas d’essai à un compte qui n’en a pas', () => {
    assert.equal(finEssaiEffective(jours(20), T0)?.toISOString(), jours(20).toISOString());
    assert.equal(finEssaiEffective(null, T0), null);
    assert.equal(etatAbonnement({ essaiJusqua: null }, T0, true, T0).offre, 'gratuit');
    // Sans date de mise en service, rien ne change.
    assert.equal(finEssaiEffective(jours(-1), null)?.toISOString(), jours(-1).toISOString());
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

  it('commence après l’essai en cours, sans perdre de jours', () => {
    assert.equal(prolonger(null, 'mensuel', T0, jours(10)).toISOString(), '2026-12-06T12:00:00.000Z');
    // Essai fini : la période part de maintenant.
    assert.equal(prolonger(null, 'mensuel', T0, jours(-2)).toISOString(), '2026-11-27T12:00:00.000Z');
    // Pro déjà ouvert au-delà de l'essai : on part de la fin de Pro.
    assert.equal(prolonger(jours(40), 'mensuel', T0, jours(10)).toISOString(), ajouterMois(jours(40), 1).toISOString());
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

describe('essai unique par personne', () => {
  it('ramène une adresse à sa forme canonique', () => {
    assert.equal(normaliserEmail('  Awa.Diallo+me@GMail.com '), 'awadiallo@gmail.com');
    assert.equal(normaliserEmail('a.b@googlemail.com'), 'ab@gmail.com');
    assert.equal(normaliserEmail('jean.paul+essai@exemple.cd'), 'jean.paul@exemple.cd');
    assert.equal(normaliserEmail('pas-une-adresse'), 'pas-une-adresse');
  });

  it('donne la même empreinte aux variantes d’une adresse, et ne la révèle pas', () => {
    const a = empreintesCompte({ email: 'awa.diallo@gmail.com' }, 'secret');
    const b = empreintesCompte({ email: 'AwaDiallo+2@gmail.com' }, 'secret');
    assert.deepEqual(a, b);
    assert.doesNotMatch(a[0], /awa/);
    assert.notDeepEqual(empreintesCompte({ email: 'awa.diallo@gmail.com' }, 'autre'), a);
    assert.equal(empreintesCompte({ email: 'x@y.cd', googleId: '123' }, 'secret').length, 2);
  });
});

describe('FlexPaie', () => {
  it('met les numéros au format international', () => {
    assert.equal(normaliserTelephone('0812345678'), '243812345678');
    assert.equal(normaliserTelephone('+243 81 234 5678'), '243812345678');
    assert.equal(normaliserTelephone('00243-81-234-5678'), '243812345678');
    assert.equal(normaliserTelephone('+2430812345678'), '243812345678');
    assert.equal(normaliserTelephone('+33 6 12 34 56 78'), '33612345678');
    assert.equal(normaliserTelephone('+4512345678'), '4512345678');
    assert.equal(normaliserTelephone('12345678'), null);
    assert.equal(normaliserTelephone('+12345'), null);
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

describe('trois formules : Gratuit, Finances, Pro', () => {
  it('garde le prix le plus haut à 4,99 $ par mois', () => {
    assert.equal(OFFRES.formules.finances.mensuel.prix, 199);
    assert.equal(OFFRES.formules.finances.annuel.prix, 1999);
    assert.equal(OFFRES.formules.pro.mensuel.prix, 499);
    assert.ok(Math.max(OFFRES.formules.finances.mensuel.prix, OFFRES.formules.pro.mensuel.prix) <= 499);
    // Les anciennes versions de l'app lisent toujours `pro`.
    assert.equal(OFFRES.pro.annuel.prix, 4999);
  });

  it('ouvre les finances avancées, sans les fonctions Pro, avec Finances', () => {
    const e = etatAbonnement({ abonnementFormule: 'finances', abonnementFinLe: jours(20), abonnementPeriode: 'mensuel' }, T0, true);
    assert.equal(e.offre, 'finances');
    assert.equal(e.finances, true);
    assert.equal(e.pro, false);
    assert.equal(aDroit(e, 'justificatifs'), true);
    assert.equal(aDroit(e, 'assistant'), false);
    assert.equal(formuleDe('releves'), 'finances');
    assert.equal(formuleDe('equipes'), 'pro');
  });

  it('donne tout à Pro, et lit un ancien abonnement sans formule comme Pro', () => {
    const e = etatAbonnement({ abonnementFinLe: jours(20), abonnementPeriode: 'mensuel' }, T0, true);
    assert.equal(e.offre, 'pro');
    assert.equal(e.finances, true);
    assert.equal(aDroit(e, 'prets'), true);
    assert.equal(aDroit(etatAbonnement({}, T0, true), 'justificatifs'), false);
  });

  it('garde l’essai complet quand Finances est payé pendant l’essai', () => {
    const e = etatAbonnement({ essaiJusqua: jours(5), abonnementFormule: 'finances', abonnementFinLe: jours(35) }, T0, true);
    assert.equal(e.offre, 'essai');
    assert.equal(e.pro, true);
    assert.equal(e.ensuite?.formule, 'finances');
    // L'avis de fin d'essai dit que Finances prend le relais.
    assert.match(avisAbonnement({ essaiJusqua: jours(2), abonnementFormule: 'finances', abonnementFinLe: jours(32) }, T0, true)!.corps, /Finances prend le relais/);
    assert.equal(etatAbonnement({ essaiJusqua: jours(5), abonnementFormule: 'finances', abonnementFinLe: jours(35) }, jours(6), true).offre, 'finances');
  });

  it('convertit le temps restant au prorata des prix quand on change de formule', () => {
    // 30 jours de Finances restants valent 30 × 1,99 / 4,99 ≈ 11,96 jours de Pro, puis le mois payé.
    const fin = prolonger({ fin: jours(30), formule: 'finances' }, 'mensuel', T0, null, 'pro');
    const attendu = ajouterMois(new Date(T0.getTime() + Math.round((30 * 86400000 * 199) / 499)), 1);
    assert.equal(fin.toISOString(), attendu.toISOString());
    // Même formule : on prolonge simplement à partir de la fin.
    assert.equal(prolonger({ fin: jours(30), formule: 'finances' }, 'mensuel', T0, null, 'finances').toISOString(), ajouterMois(jours(30), 1).toISOString());
    // Passer de Pro à Finances : les jours de Pro valent plus de jours de Finances.
    assert.ok(prolonger({ fin: jours(10), formule: 'pro' }, 'mensuel', T0, null, 'finances') > ajouterMois(jours(10), 1));
  });

  it('dit quelle formule choisir quand une fonction est réservée', () => {
    assert.match(messageReserve('justificatifs'), /Finances/);
    assert.match(messageReserve('assistant'), /Pro/);
    assert.match(avisAbonnement({ abonnementFormule: 'finances', abonnementFinLe: jours(6) }, T0, true)!.titre, /Finances/);
  });
});

describe('jeton FlexPaie', () => {
  it('jeton FlexPaie : nettoyé, et un jeton abîmé est repéré avant l’appel', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtZSJ9.c2lnbmF0dXJl';
    assert.equal(jetonFlexpaie(` "Bearer ${jwt}"\n`), jwt);
    assert.equal(jetonFlexpaie(`'${jwt}'`), jwt);
    assert.equal(problemeJeton(jwt), null);
    // Une signature tronquée, puis une signature dont le dernier caractère a des bits de fin non nuls (l'erreur renvoyée par FlexPaie).
    assert.match(problemeJeton('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtZSJ9.c2lnbmF0dXJ') ?? '', /signature/);
    assert.match(problemeJeton('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtZSJ9.c2lnbmF0dXJlYR') ?? '', /signature/);
    assert.match(problemeJeton('') ?? '', /vide/);
    assert.equal(problemeJeton('jeton-opaque'), null);
    assert.equal(base64Strict('YQ'), true);
    assert.equal(base64Strict('YR'), false);
    assert.equal(base64Strict('YQ=='), true);
  });

  it('erreur de décodage renvoyée par FlexPaie : problème de configuration, pas du client', () => {
    const e = erreurFlexpaie('Last encoded character (before the paddings if any) is a valid base 64 alphabet but not a possible value. Expected the discarded bits to be zero.', 'repli');
    assert.equal(e.configuration, true);
    assert.match(e.message, /FLEXPAIE_TOKEN/);
    const f = erreurFlexpaie('Numéro invalide', 'repli');
    assert.equal(f.configuration, false);
    assert.equal(f.message, 'Numéro invalide');
    assert.equal(erreurFlexpaie(undefined, 'repli').message, 'repli');
  });
});

describe('paliers de réunions : Pro 0 à Pro 3', () => {
  it('additionne le prix du palier à celui de Pro', () => {
    assert.equal(prixPeriode('pro', 'mensuel', 0), 499);
    assert.equal(prixPeriode('pro', 'mensuel', 1), 698);
    assert.equal(prixPeriode('pro', 'mensuel', 2), 998);
    assert.equal(prixPeriode('pro', 'mensuel', 3), 1498);
    assert.equal(prixPeriode('pro', 'annuel', 1), 6998);
    assert.equal(prixPeriode('pro', 'annuel', 3), 14998);
    // Finances n'a pas de palier.
    assert.equal(prixPeriode('finances', 'mensuel', 3), 199);
    assert.deepEqual([1, 2, 3].map((n) => PALIERS[n as 1 | 2 | 3].heures), [3, 10, 25]);
  });
  it('lit tout ce qui n’est pas 1, 2 ou 3 comme Pro 0', () => {
    assert.deepEqual([null, undefined, 0, 4, -1, '2'].map(palierDe), [0, 0, 0, 0, 0, 0]);
    assert.equal(palierDe(2), 2);
  });
  it('n’ouvre pas les réunions avec Pro 0, mais tout le reste de Pro', () => {
    const e = etatAbonnement({ abonnementFormule: 'pro', abonnementFinLe: jours(20), abonnementPeriode: 'mensuel' }, T0, true);
    assert.equal(e.palier, 0);
    assert.equal(e.reunions, null);
    assert.equal(aDroit(e, 'reunions'), false);
    assert.equal(aDroit(e, 'assistant'), true);
    assert.equal(aDroit(e, 'equipes'), true);
    // Un ancien abonnement sans palier est du Pro 0.
    assert.equal(aDroit(etatAbonnement({ abonnementFinLe: jours(20) }, T0, true), 'reunions'), false);
    assert.match(messageReserve('reunions'), /Pro 1/);
  });
  it('ouvre les réunions avec Pro 1 à 3 et leurs heures du mois', () => {
    for (const [palier, heures] of [[1, 3], [2, 10], [3, 25]] as const) {
      const e = etatAbonnement({ abonnementFormule: 'pro', abonnementPalier: palier, abonnementFinLe: jours(20), abonnementPeriode: 'mensuel' }, T0, true);
      assert.equal(aDroit(e, 'reunions'), true);
      assert.deepEqual(e.reunions, { cle: moisReunions(T0), secondes: heures * 3600 });
    }
  });
  it('offre 45 minutes de réunion pendant l’essai, comptées à part du mois', () => {
    const e = etatAbonnement({ essaiJusqua: jours(5) }, T0, true);
    assert.equal(aDroit(e, 'reunions'), true);
    assert.deepEqual(e.reunions, { cle: 'essai', secondes: ESSAI_REUNION_MINUTES * 60 });
    assert.equal(ESSAI_REUNION_MINUTES, 45);
  });
  it('ne donne pas les réunions à Finances, au gratuit, ni après la fin du palier', () => {
    assert.equal(etatAbonnement({ abonnementFormule: 'finances', abonnementFinLe: jours(20) }, T0, true).reunions, null);
    assert.equal(etatAbonnement({}, T0, true).reunions, null);
    assert.equal(etatAbonnement({ abonnementFormule: 'pro', abonnementPalier: 2, abonnementFinLe: jours(-1) }, T0, true).reunions, null);
  });
  it('reste ouvert et sans limite quand les abonnements sont coupés', () => {
    const e = etatAbonnement({}, T0, false);
    assert.equal(aDroit(e, 'reunions'), true);
    assert.equal(e.reunions?.illimite, true);
  });
  it('convertit le temps restant au prorata quand on change de palier', () => {
    // 30 jours de Pro 0 (4,99) valent 30 × 4,99 / 6,98 jours de Pro 1.
    const fin = prolonger({ fin: jours(30), formule: 'pro', palier: 0 }, 'mensuel', T0, null, 'pro', 1);
    assert.equal(fin.toISOString(), ajouterMois(new Date(T0.getTime() + Math.round((30 * 86400000 * 499) / 698)), 1).toISOString());
    // Même palier : on prolonge à partir de la fin.
    assert.equal(prolonger({ fin: jours(30), formule: 'pro', palier: 2 }, 'mensuel', T0, null, 'pro', 2).toISOString(), ajouterMois(jours(30), 1).toISOString());
    // Redescendre de palier rend plus de jours.
    assert.ok(prolonger({ fin: jours(10), formule: 'pro', palier: 3 }, 'mensuel', T0, null, 'pro', 0) > ajouterMois(jours(10), 1));
  });
});
