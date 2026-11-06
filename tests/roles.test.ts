import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { aModule, modulesDe, modulesValides } from '../src/services/membres/modules.js';

const lire = (f: string) => readFileSync(new URL(`../src/routes/${f}`, import.meta.url), 'utf8');
const ligne = (routes: string, r: string) => routes.split('\n').find((l) => l.includes(r)) ?? '';

describe('rôles et modules', () => {
  it('un admin a tout, un utilisateur rien, un commercial ce qui est coché', () => {
    assert.equal(aModule({ role: 'ADMIN' }, 'versements'), true);
    assert.equal(aModule({ role: 'UTILISATEUR', modules: ['versements'] }, 'versements'), false);
    assert.equal(aModule({ role: 'COMMERCIAL', modules: ['comptes'] }, 'comptes'), true);
    assert.equal(aModule({ role: 'COMMERCIAL', modules: ['comptes'] }, 'versements'), false);
    assert.equal(aModule(undefined, 'comptes'), false);
    assert.deepEqual(modulesDe({ role: 'ADMIN' }), ['comptes', 'offres', 'verifications', 'versements']);
    assert.deepEqual(modulesDe({ role: 'UTILISATEUR', modules: ['comptes'] }), []);
  });
  it('offrir suppose de voir les comptes, et les modules inconnus disparaissent', () => {
    assert.deepEqual(modulesValides(['offres']), ['comptes', 'offres']);
    assert.deepEqual(modulesValides(['versements', 'inconnu']), ['versements']);
    assert.deepEqual(modulesValides(), []);
  });
  it('chaque route reçoit le bon contrôle', () => {
    const m = lire('membre.routes.ts');
    assert.ok(ligne(m, "router.get('/gestion'").includes("requireModule('comptes')"));
    assert.ok(ligne(m, "router.get('/:id/fiche'").includes("requireModule('comptes')"));
    assert.ok(ligne(m, "router.post('/:id/abonnement'").includes("requireModule('offres')"));
    assert.ok(ligne(m, "router.patch('/:id'").includes('requireAdmin'));
    assert.ok(ligne(m, "router.delete('/:id'").includes('requireAdmin'));
    assert.ok(ligne(m, "router.get('/'").includes('requireAdmin'));
    const t = lire('tontine.routes.ts');
    for (const r of ["'/admin/resume'", "'/admin/tours/:tourId/verser'", "'/admin/membres/:membreId/rendre'"]) assert.ok(ligne(t, r).includes("requireModule('versements')"), r);
    for (const r of ["'/admin/approbations'", "'/admin/approbations/:userId/piece'", "'/admin/approbations/:userId'"]) assert.ok(t.split('\n').filter((l) => l.includes(r)).every((l) => l.includes("requireModule('verifications')")), r);
    assert.ok(ligne(lire('config.routes.ts'), "router.put('/'").includes('requireAdmin'));
  });
});
