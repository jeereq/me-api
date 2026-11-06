import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { prolonger } from '../src/services/abonnements/offres.js';
import { filtrerMembres, finEssaiProlonge, finOfferte, ligneMembre, statsMembres, type CompteGestion } from '../src/services/membres/gestion.js';

const NOW = new Date('2026-11-15T10:00:00Z');
const jours = (n: number) => new Date(NOW.getTime() + n * 86400000);
const compte = (id: string, o: Partial<CompteGestion> = {}): CompteGestion => ({ id, email: `${id}@exemple.com`, nom: id, role: 'UTILISATEUR', emailVerifie: true, createdAt: new Date('2026-10-01T00:00:00Z'), ...o });
const ligne = (c: CompteGestion) => ligneMembre(c, NOW, null);
const ids = (l: { id: string }[]) => l.map((x) => x.id);

const pro = compte('pro', { abonnementFormule: 'pro', abonnementPalier: 2, abonnementPeriode: 'annuel', abonnementFinLe: jours(100) });
const fin = compte('fin', { abonnementFormule: 'finances', abonnementPeriode: 'mensuel', abonnementFinLe: jours(3) });
const essai = compte('essai', { essaiJusqua: jours(5) });
const gratuit = compte('gratuit', { nom: 'Élodie Kasongo' });
const ancien = compte('ancien', { abonnementFormule: 'pro', abonnementFinLe: jours(-10) });
const admin = compte('admin', { role: 'ADMIN' });
const lignes = [pro, fin, essai, gratuit, ancien, admin].map(ligne);

describe('ligne d’un compte', () => {
  it('dit l’offre, le palier, la période et la fin', () => {
    const l = ligne(pro);
    assert.equal(l.offre, 'pro');
    assert.equal(l.palier, 2);
    assert.equal(l.periode, 'annuel');
    assert.equal(l.joursRestants, 100);
    assert.equal(l.expireLe, null);
  });
  it('repère un ancien abonné', () => {
    const l = ligne(ancien);
    assert.equal(l.offre, 'gratuit');
    assert.equal(l.expireLe, jours(-10).toISOString());
    assert.equal(l.palier, 0);
  });
  it('donne la vraie offre même quand les abonnements sont coupés sur le serveur', () => {
    assert.equal(ligne(gratuit).offre, 'gratuit');
    assert.equal(ligne(admin).offre, 'libre');
  });
  it('ne contient ni mot de passe ni donnée de l’espace', () => {
    assert.deepEqual(Object.keys(ligne(pro)).sort(), ['creeLe', 'eligibilite', 'email', 'emailVerifie', 'expireLe', 'id', 'joursRestants', 'jusqua', 'nom', 'offre', 'palier', 'periode', 'photo', 'role']);
  });
});

describe('filtres', () => {
  it('sépare abonnés, essais, sans abonnement et anciens', () => {
    assert.deepEqual(ids(filtrerMembres(lignes, 'abonnes')).sort(), ['fin', 'pro']);
    assert.deepEqual(ids(filtrerMembres(lignes, 'essai')), ['essai']);
    assert.deepEqual(ids(filtrerMembres(lignes, 'sans')).sort(), ['ancien', 'gratuit']);
    assert.deepEqual(ids(filtrerMembres(lignes, 'anciens')), ['ancien']);
    assert.deepEqual(ids(filtrerMembres(lignes, 'equipe')), ['admin']);
    assert.equal(filtrerMembres(lignes, 'tous').length, 6);
  });
  it('« expirent » garde les abonnés à 7 jours ou moins, le plus proche d’abord', () => {
    const presque = ligne(compte('presque', { abonnementFormule: 'pro', abonnementFinLe: jours(1) }));
    assert.deepEqual(ids(filtrerMembres([...lignes, presque], 'expirent')), ['presque', 'fin']);
  });
  it('un essai qui finit n’est pas dans « expirent »', () => {
    assert.ok(!ids(filtrerMembres(lignes, 'expirent')).includes('essai'));
  });
  it('cherche dans le nom et l’email, sans tenir compte des accents ni de la casse', () => {
    assert.deepEqual(ids(filtrerMembres(lignes, 'tous', 'elodie')), ['gratuit']);
    assert.deepEqual(ids(filtrerMembres(lignes, 'tous', 'PRO@EXEMPLE')), ['pro']);
    assert.deepEqual(filtrerMembres(lignes, 'abonnes', 'elodie'), []);
  });
  it('montre les comptes les plus récents d’abord', () => {
    const r = [compte('a', { createdAt: new Date('2026-01-01') }), compte('b', { createdAt: new Date('2026-06-01') })].map(ligne);
    assert.deepEqual(ids(filtrerMembres(r, 'tous')), ['b', 'a']);
  });
});

describe('chiffres', () => {
  it('compte chaque filtre', () => {
    const s = statsMembres(lignes, [], NOW);
    assert.equal(s.tous, 6);
    assert.equal(s.abonnes, 2);
    assert.equal(s.essai, 1);
    assert.equal(s.sans, 2);
    assert.equal(s.expirent, 1);
    assert.equal(s.anciens, 1);
  });
  it('sépare les revenus par devise, et ceux du mois', () => {
    const s = statsMembres([], [{ montant: 499, devise: 'USD', payeLe: new Date('2026-11-02') }, { montant: 1999, devise: 'USD', payeLe: new Date('2026-10-02') }, { montant: 5000, devise: 'CDF', payeLe: new Date('2026-11-03') }], NOW);
    assert.deepEqual(s.revenus, { USD: { total: 2498, mois: 499 }, CDF: { total: 5000, mois: 5000 } });
  });
});

describe('offrir un abonnement', () => {
  it('part d’aujourd’hui pour un compte sans abonnement', () => {
    assert.equal(finOfferte(gratuit, 'pro', 0, 3, NOW, null).toISOString(), '2027-02-15T10:00:00.000Z');
  });
  it('s’ajoute au temps restant de la même formule', () => {
    const f = finOfferte(pro, 'pro', 2, 1, NOW, null);
    assert.equal(f.toISOString(), '2027-03-23T10:00:00.000Z');
  });
  it('commence après l’essai en cours', () => {
    assert.equal(finOfferte(essai, 'finances', 0, 1, NOW, null).toISOString().slice(0, 10), '2026-12-20');
  });
  it('donne le même résultat qu’un paiement d’un mois ou d’un an', () => {
    const avant = { fin: jours(10), formule: 'finances' as const, palier: 0 as const };
    assert.equal(finOfferte(compte('x', { abonnementFormule: 'finances', abonnementFinLe: jours(10) }), 'pro', 0, 12, NOW, null).getTime(), prolonger(avant, 'annuel', NOW, null, 'pro', 0).getTime());
  });
  it('ignore un palier demandé avec Finances', () => {
    const a = finOfferte(gratuit, 'finances', 3, 1, NOW, null);
    assert.equal(a.toISOString(), finOfferte(gratuit, 'finances', 0, 1, NOW, null).toISOString());
  });
});

describe('prolonger un essai', () => {
  it('s’ajoute à l’essai en cours', () => {
    assert.equal(finEssaiProlonge(essai, 7, NOW, null).getTime(), jours(12).getTime());
  });
  it('repart d’aujourd’hui si l’essai est fini ou absent', () => {
    assert.equal(finEssaiProlonge(compte('x', { essaiJusqua: jours(-3) }), 7, NOW, null).getTime(), jours(7).getTime());
    assert.equal(finEssaiProlonge(gratuit, 14, NOW, null).getTime(), jours(14).getTime());
  });
});
