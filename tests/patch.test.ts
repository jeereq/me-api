import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appliquer, differences, egal, ErreurDifferences, type Operation } from '../src/commun/patch.js';

const espace = () => ({
  relances: [
    { id: 'r1', contact: 'Marie', statut: 'a_faire' },
    { id: 'r2', contact: 'Paul', statut: 'relance' },
  ],
  finances: { depenses: [{ id: 'd1', montant: 10 }], budgets: [{ id: 'b1', nom: 'Courses' }], devise: 'CDF' },
  journal: { '2026-10-27': { note: 'ok' } },
  sons: true,
  majLe: '2026-10-27T10:00:00.000Z',
});

const allerRetour = (base: unknown, local: unknown) => {
  const ops = differences(base, local);
  // Les opérations passent par le réseau : elles doivent survivre à un aller-retour JSON.
  const recu = JSON.parse(JSON.stringify(ops)) as Operation[];
  assert.ok(egal(appliquer(base, recu), local), JSON.stringify({ ops, obtenu: appliquer(base, recu), local }));
  return ops;
};

test('rien ne part quand rien ne change', () => {
  assert.deepEqual(differences(espace(), espace()), []);
});

test('une dépense ajoutée : seule elle part, pas tout l’espace', () => {
  const base = espace();
  const local = espace();
  local.finances.depenses.push({ id: 'd2', montant: 5 });
  const ops = allerRetour(base, local);
  assert.deepEqual(ops, [{ op: 'liste', chemin: ['finances', 'depenses'], maj: [{ id: 'd2', montant: 5 }] }]);
});

test('une relance modifiée, une retirée, une valeur simple changée, une clé retirée', () => {
  const base = espace();
  const local: Record<string, unknown> = espace();
  (local.relances as { id: string; statut: string }[])[0].statut = 'repondu';
  (local.relances as unknown[]).splice(1, 1);
  (local.finances as { devise: string }).devise = 'USD';
  delete local.sons;
  local.majLe = '2026-10-28T10:00:00.000Z';
  const ops = allerRetour(base, local);
  assert.deepEqual(ops.find((o) => o.chemin.join('.') === 'relances'), { op: 'liste', chemin: ['relances'], maj: [{ id: 'r1', contact: 'Marie', statut: 'repondu' }], retirer: ['r2'] });
  assert.ok(ops.some((o) => o.op === 'retirer' && o.chemin.join('.') === 'sons'));
});

test('un ajout en tête de liste envoie aussi l’ordre, un ajout à la fin non', () => {
  const base = espace();
  const tete = espace();
  tete.relances.unshift({ id: 'r0', contact: 'Léa', statut: 'a_faire' });
  const ops = allerRetour(base, tete);
  assert.deepEqual((ops[0] as { ordre?: string[] }).ordre, ['r0', 'r1', 'r2']);
  const fin = espace();
  fin.relances.push({ id: 'r3', contact: 'Léa', statut: 'a_faire' });
  assert.equal((allerRetour(base, fin)[0] as { ordre?: string[] }).ordre, undefined);
});

test('listes sans identifiant ou avec doublons : remplacées entières', () => {
  assert.deepEqual(allerRetour({ coches: ['a'] }, { coches: ['a', 'b'] }), [{ op: 'mettre', chemin: ['coches'], valeur: ['a', 'b'] }]);
  const doublons = { l: [{ id: 'x' }, { id: 'x', v: 1 }] };
  assert.equal(allerRetour({ l: [{ id: 'x' }] }, doublons)[0].op, 'mettre');
});

test('un élément ajouté par un autre appareil n’est pas perdu par un nouvel ordre', () => {
  const serveur = { l: [{ id: 'a' }, { id: 'b' }, { id: 'autre' }] };
  const r = appliquer(serveur, [{ op: 'liste', chemin: ['l'], ordre: ['b', 'a'] }]) as { l: { id: string }[] };
  assert.deepEqual(r.l.map((x) => x.id), ['b', 'a', 'autre']);
});

test('le document de départ n’est pas modifié', () => {
  const base = espace();
  const copie = JSON.parse(JSON.stringify(base));
  appliquer(base, [{ op: 'mettre', chemin: ['finances', 'devise'], valeur: 'EUR' }]);
  assert.deepEqual(base, copie);
});

test('opérations refusées : prototype, chemin à travers une valeur simple, liste qui n’en est pas une', () => {
  assert.throws(() => appliquer({}, [{ op: 'mettre', chemin: ['__proto__', 'x'], valeur: 1 }]), ErreurDifferences);
  assert.throws(() => appliquer({ sons: true }, [{ op: 'mettre', chemin: ['sons', 'x'], valeur: 1 }]), ErreurDifferences);
  assert.throws(() => appliquer({ l: 'texte' }, [{ op: 'liste', chemin: ['l'], maj: [{ id: 'a' }] }]), ErreurDifferences);
  assert.throws(() => appliquer({}, [{ op: 'retirer', chemin: [] }]), ErreurDifferences);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

// Documents tirés au hasard : la règle `appliquer(base, differences(base, local)) = local` doit toujours tenir.
test('aller-retour sur des documents au hasard', () => {
  let graine = 42;
  const hasard = () => ((graine = (graine * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const choix = <T>(t: T[]) => t[Math.floor(hasard() * t.length)];
  const valeur = (prof: number): unknown => {
    const r = hasard();
    if (prof > 2 || r < 0.35) return choix([1, 2, 'a', 'b', true, null, 0]);
    if (r < 0.55) return Array.from({ length: Math.floor(hasard() * 4) }, () => choix([1, 'x', 'y']));
    if (r < 0.8) return Array.from({ length: Math.floor(hasard() * 5) }, (_, i) => ({ id: `i${Math.floor(hasard() * 6) + i * 10}`, v: valeur(prof + 1) }));
    return Object.fromEntries(Array.from({ length: Math.floor(hasard() * 4) }, () => [choix(['a', 'b', 'c', 'd']), valeur(prof + 1)]));
  };
  const muter = (v: unknown, prof = 0): unknown => {
    if (hasard() < 0.25) return valeur(prof);
    if (Array.isArray(v)) {
      const t = v.map((x) => (hasard() < 0.3 ? muter(x, prof + 1) : x)).filter(() => hasard() > 0.15);
      if (hasard() < 0.3) t.reverse();
      if (hasard() < 0.4) t.splice(Math.floor(hasard() * (t.length + 1)), 0, choix(v.length ? [v[0], 7] : [7]));
      return t;
    }
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = { ...(v as Record<string, unknown>) };
      for (const k of Object.keys(o)) if (hasard() < 0.3) delete o[k];
      else if (hasard() < 0.5) o[k] = muter(o[k], prof + 1);
      if (hasard() < 0.4) o[choix(['a', 'e', 'f'])] = valeur(prof + 1);
      return o;
    }
    return v;
  };
  for (let i = 0; i < 2000; i++) {
    const base = { x: valeur(0), y: valeur(0), z: valeur(0) };
    allerRetour(base, muter(base));
  }
});
