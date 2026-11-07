import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { cheminGroupe, cleAlerte, confianceDe, correspondAlerte, trier } = await import('../src/services/cotisations/annuaire.js');
const { alerteAnnuaireSchema, filtresAnnuaireSchema, signalerTontineSchema } = await import('../src/validators/schemas.js');

describe('outils de l’annuaire', () => {
  const g = (nom: string, montant: number, places: number, inscrits: number, jour: number) => ({ nom, montant, places, inscrits, createdAt: new Date(Date.UTC(2026, 10, jour)) });
  it('trie par date, montant ou places libres', () => {
    const l = [g('A', 500, 10, 1, 1), g('B', 100, 5, 4, 2), g('C', 300, 3, 1, 3)];
    assert.deepEqual(trier(l).map((x) => x.nom), ['C', 'B', 'A']);
    assert.deepEqual(trier(l, 'montant').map((x) => x.nom), ['B', 'C', 'A']);
    assert.deepEqual(trier(l, 'places').map((x) => x.nom), ['B', 'C', 'A']);
  });
  it('reconnaît ce qu’une alerte attend', () => {
    const groupe = { nom: 'Épargne Gombe', mode: 'rotation', rythme: 'mensuel', devise: 'USD', montant: 1000 };
    assert.equal(correspondAlerte({}, groupe), true);
    assert.equal(correspondAlerte({ q: 'epargne', rythme: 'mensuel', montantMax: 1000 }, groupe), true);
    assert.equal(correspondAlerte({ montantMax: 999 }, groupe), false);
    assert.equal(correspondAlerte({ devise: 'CDF' }, groupe), false);
    assert.equal(correspondAlerte({ mode: 'objectif' }, groupe), false);
    assert.equal(cleAlerte({ q: ' Gombe ' }), cleAlerte({ q: 'gombe' }));
  });
  it('compte les versements à temps et les groupes terminés', () => {
    const c = confianceDe(
      [
        { etat: 'termine', tours: [{ etat: 'verse', echeance: '2026-10-01', valideLe: new Date('2026-10-03T23:00:00Z') }, { etat: 'verse', echeance: '2026-10-08', valideLe: new Date('2026-10-11T08:00:00Z') }] },
        { etat: 'en_cours', tours: [{ etat: 'collecte', echeance: '2026-11-01', valideLe: null }] },
      ],
      new Date('2026-03-15T00:00:00Z'),
    );
    assert.deepEqual(c, { termines: 1, versements: 2, aTemps: 1, depuis: '2026-03' });
  });
  it('fait un lien lisible pour chaque groupe', () => {
    assert.equal(cheminGroupe({ id: 'ck1', nom: 'Tontine des Commerçants !' }), '/annuaire/tontine-des-commercants-ck1');
    assert.equal(cheminGroupe({ id: 'ck2', nom: '!!!' }), '/annuaire/groupe-ck2');
  });
  it('valide les filtres, les alertes et les signalements', () => {
    assert.deepEqual(filtresAnnuaireSchema.parse({ tri: 'places', ouverts: '1' }), { tri: 'places', ouverts: true });
    assert.equal(filtresAnnuaireSchema.parse({ tri: 'pirate' }).tri, undefined);
    assert.equal(alerteAnnuaireSchema.safeParse({ body: { devise: 'EUR' } }).success, false);
    assert.equal(signalerTontineSchema.safeParse({ params: { id: 'x' }, body: { motif: 'arnaque', texte: 'x'.repeat(501) } }).success, false);
    assert.equal(signalerTontineSchema.safeParse({ params: { id: 'x' }, body: { motif: 'arnaque' } }).success, true);
  });
});
