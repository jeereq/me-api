import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rappelsDuJour, type EspaceRappels } from '../src/services/rappels/calcul.js';
import { alertesObjectifs, datesVersements, suiviRappel, type ObjectifRappel } from '../src/services/rappels/objectifs.js';

// Le 26 octobre 2026 est un lundi.
const JOUR = '2026-10-26';
const obj = (o: Partial<ObjectifRappel> = {}): ObjectifRappel => ({ id: 'o1', nom: 'Voyage', emoji: '✈️', genre: 'epargne', cible: 1200, debut: '2026-08-26', echeance: '2027-01-26', versements: [], ...o });
const fin = (objectifs: ObjectifRappel[], extra: Record<string, unknown> = {}) => ({ devise: '€', objectifs, ...extra });

describe('dates de versement', () => {
  it('suit le même jour du mois, et le dernier jour des mois plus courts', () => {
    assert.deepEqual(datesVersements({ debut: '2026-01-31', echeance: '2026-04-30' }), ['2026-02-28', '2026-03-31', '2026-04-30']);
  });
  it('suit le même jour de la semaine', () => {
    assert.deepEqual(datesVersements({ debut: '2026-10-05', echeance: '2026-10-26', plan: { cadence: 'semaine' } }), ['2026-10-12', '2026-10-19', '2026-10-26']);
  });
  it('se réduit à l’échéance quand elle tombe avant le premier versement', () => {
    assert.deepEqual(datesVersements({ debut: '2026-10-01', echeance: '2026-10-10' }), ['2026-10-10']);
  });
});

describe('suivi pour les rappels', () => {
  it('calcule le versement qui tient la date', () => {
    const s = suiviRappel(obj(), JOUR);
    // 4 versements restants (26/10, 26/11, 26/12, 26/01) pour 1 200
    assert.equal(s.versement, 300);
    assert.equal(s.etat, 'en_retard');
  });
  it('respecte le montant choisi, sans dépasser ce qu’il reste', () => {
    assert.equal(suiviRappel(obj({ plan: { versement: 500 } }), JOUR).versement, 500);
    assert.equal(suiviRappel(obj({ plan: { versement: 500 }, depart: 900 }), JOUR).versement, 300);
  });
});

describe('alertes d’objectifs', () => {
  it('rappelle le versement prévu aujourd’hui', () => {
    const a = alertesObjectifs(fin([obj()]), JOUR, '19:00');
    assert.equal(a.length, 1);
    assert.equal(a[0].id, `objectif|o1|versement|${JOUR}`);
    assert.match(a[0].titre, /Versement prévu aujourd'hui : ✈️ Voyage/);
    assert.match(a[0].corps, /300/);
    assert.equal(a[0].heure, '19:00');
  });
  it('ne rappelle pas un versement déjà noté ce jour-là, et signale seulement le retard', () => {
    const a = alertesObjectifs(fin([obj({ versements: [{ id: 'v', date: JOUR, montant: 100 }] })]), JOUR, '19:00');
    assert.equal(a.length, 1);
    assert.equal(a[0].id, 'objectif|o1|retard|2026-10-26');
  });
  it('signale le retard une fois par semaine : même clé toute la semaine', () => {
    const o = obj();
    const mardi = alertesObjectifs(fin([o]), '2026-10-27', '19:00');
    const jeudi = alertesObjectifs(fin([o]), '2026-10-29', '19:00');
    assert.equal(mardi[0].id, jeudi[0].id);
    assert.equal(mardi[0].id, 'objectif|o1|retard|2026-10-26');
  });
  it('ne dit rien d’un objectif dans les temps un jour sans versement', () => {
    assert.deepEqual(alertesObjectifs(fin([obj({ depart: 1190 })]), '2026-10-27', '19:00'), []);
  });
  it('signale une échéance passée', () => {
    const a = alertesObjectifs(fin([obj({ echeance: '2026-10-01' })]), JOUR, '19:00');
    assert.equal(a[0].id, 'objectif|o1|depasse');
    assert.equal(a[0].mode, 'agressif');
  });
  it('félicite un objectif atteint, seulement dans les deux jours', () => {
    const o = obj({ versements: [{ id: 'v', date: '2026-10-25', montant: 1200 }] });
    assert.equal(alertesObjectifs(fin([o]), JOUR, '19:00')[0].id, 'objectif|o1|atteint');
    assert.deepEqual(alertesObjectifs(fin([o]), '2026-10-30', '19:00'), []);
  });
  it('ignore un objectif archivé ou pas encore commencé', () => {
    assert.deepEqual(alertesObjectifs(fin([obj({ archive: true }), obj({ id: 'p', debut: '2026-12-01', echeance: '2027-06-01' })]), JOUR, '19:00'), []);
  });
  it('suit les réglages d’alertes : heure, push et email', () => {
    const a = alertesObjectifs(fin([obj()], { alertes: { heure: '08:30', push: false } }), JOUR, '19:00');
    assert.equal(a[0].heure, '08:30');
    assert.deepEqual(a[0].canaux, { push: false, email: true });
  });
  it('se coupe avec l’interrupteur des objectifs', () => {
    assert.deepEqual(alertesObjectifs(fin([obj()], { alertes: { objectifs: false } }), JOUR, '19:00'), []);
    assert.equal(alertesObjectifs(fin([obj()], { alertes: { objectifs: true } }), JOUR, '19:00').length, 1);
  });
  it('écrit le franc congolais « FC »', () => {
    assert.match(alertesObjectifs(fin([obj()], { devise: 'CDF' }), JOUR, '19:00')[0].corps, /FC/);
  });
});

describe('rappelsDuJour : objectifs', () => {
  it('les ajoute aux rappels du jour avec leur clé stable', () => {
    const e = { finances: fin([obj()]) } as EspaceRappels;
    const r = rappelsDuJour(e, {}, JOUR).find((x) => x.cle.startsWith('objectif|'));
    assert.ok(r);
    assert.equal(r!.quand, `${JOUR}T19:00`);
    assert.equal(r!.mode, 'hebdo');
  });
});
