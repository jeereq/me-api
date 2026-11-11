import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { debutMois, FORFAIT_ESSAI, FORFAIT_GRATUIT, FORFAIT_PRO, forfaitSms, maxCodesParJour, maxCotisationsParJour, placeForfait, resteForfait } from '../src/services/sms/forfait.js';
import { ESSAI_JOURS } from '../src/services/abonnements/offres.js';
import { SEGMENTS_RAPPORT } from '../src/services/rapport-email.js';
import { rappelsDe } from '../src/commun/cotisations.js';

const maintenant = new Date('2026-11-11T10:00:00Z');
const jour = 86400000;
const dans = (n: number) => new Date(maintenant.getTime() + n * jour);

describe('forfait de SMS', () => {
  it('Pro : un forfait par mois civil', () => {
    const f = forfaitSms({ abonnementFormule: 'pro', abonnementPalier: 0, abonnementPeriode: 'mois', abonnementFinLe: dans(10) }, maintenant, true, {});
    assert.equal(f.limite, FORFAIT_PRO);
    assert.equal(f.periode, 'mois');
    assert.equal(f.depuis.toISOString(), '2026-11-01T00:00:00.000Z');
  });

  it('essai : un petit forfait pour tout l’essai, compté depuis son début', () => {
    const f = forfaitSms({ essaiJusqua: dans(4) }, maintenant, true, {});
    assert.equal(f.limite, FORFAIT_ESSAI);
    assert.equal(f.periode, 'essai');
    assert.equal(f.depuis.getTime(), dans(4).getTime() - ESSAI_JOURS * jour);
  });

  it('gratuit, Finances et Projets : seulement les avis de groupe, avec un petit forfait', () => {
    for (const formule of ['finances', 'projets'])
      assert.equal(forfaitSms({ abonnementFormule: formule, abonnementPeriode: 'mois', abonnementFinLe: dans(10) }, maintenant, true, {}).limite, FORFAIT_GRATUIT, formule);
    assert.equal(forfaitSms({}, maintenant, true, {}).limite, FORFAIT_GRATUIT);
  });

  it('sans abonnements en service, ou pour un admin : pas de limite', () => {
    assert.equal(forfaitSms({}, maintenant, false, {}).limite, null);
    assert.equal(forfaitSms({ role: 'ADMIN' }, maintenant, true, {}).limite, null);
  });

  it('l’admin règle les forfaits par variables, une valeur invalide garde le défaut', () => {
    const pro = { abonnementFormule: 'pro', abonnementPalier: 0, abonnementPeriode: 'mois', abonnementFinLe: dans(10) };
    assert.equal(forfaitSms(pro, maintenant, true, { SMS_FORFAIT_PRO: '100' }).limite, 100);
    assert.equal(forfaitSms(pro, maintenant, true, { SMS_FORFAIT_PRO: 'beaucoup' }).limite, FORFAIT_PRO);
    assert.equal(forfaitSms({}, maintenant, true, { SMS_FORFAIT_GRATUIT: '0' }).limite, 0);
  });

  it('un SMS long compte tous ses segments, et il est refusé en entier s’il dépasse', () => {
    assert.equal(placeForfait(37, 3, 40), true);
    assert.equal(placeForfait(38, 3, 40), false);
    assert.equal(placeForfait(40, 1, 40), false);
    assert.equal(placeForfait(1000, 5, null), true);
    assert.equal(placeForfait(0, 0, 1), true);
  });

  it('ce qui reste ne passe jamais sous zéro', () => {
    assert.equal(resteForfait(12, 40), 28);
    assert.equal(resteForfait(50, 40), 0);
    assert.equal(resteForfait(5, null), null);
  });

  it('le mois commence le 1er à minuit UTC', () => {
    assert.equal(debutMois(new Date('2026-12-31T23:59:59Z')).toISOString(), '2026-12-01T00:00:00.000Z');
  });
});

describe('plafonds de SMS', () => {
  it('codes de vérification : 6 par jour, réglable', () => {
    assert.equal(maxCodesParJour({}), 6);
    assert.equal(maxCodesParJour({ SMS_CODES_PAR_JOUR: '3' }), 3);
    assert.equal(maxCodesParJour({ SMS_CODES_PAR_JOUR: '0' }), 6);
  });
  it('invitations de groupe : 20 par jour, réglable', () => {
    assert.equal(maxCotisationsParJour({}), 20);
    assert.equal(maxCotisationsParJour({ COTISATIONS_SMS_PAR_JOUR: '40' }), 40);
  });
  it('le rapport du soir tient en 3 SMS au plus', () => assert.equal(SEGMENTS_RAPPORT, 3));
  it('le SMS d’un groupe n’est envoyé que si on l’a demandé', () => {
    assert.equal(rappelsDe(null).sms, false);
    assert.equal(rappelsDe({ avant: [1], apres: [], mail: true }).sms, false);
    assert.equal(rappelsDe({ avant: [1], apres: [], mail: true, sms: true }).sms, true);
  });
});
