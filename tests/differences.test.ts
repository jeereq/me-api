import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Prisma } from '@prisma/client';

import { differences } from '../src/commun/patch.js';
import { ecrireDifferences, ecrireEspace, type TableEspace } from '../src/services/espaces/document.js';
import { HttpError } from '../src/utils/http.js';

/** Une table d'espaces en mémoire, avec le même contrat que Prisma (écriture conditionnée par la version). */
function tableMemoire(avantEcriture?: () => void) {
  const lignes = new Map<string, { data: Prisma.JsonValue; majLe: Date; revision: number }>();
  const table: TableEspace = {
    lire: async (id) => lignes.get(id) ?? null,
    ecrireSi: async (id, revision, data, majLe) => {
      avantEcriture?.();
      const l = lignes.get(id);
      if (!l || l.revision !== revision) return 0;
      lignes.set(id, { data: JSON.parse(JSON.stringify(data)), majLe, revision: revision + 1 });
      return 1;
    },
    ecraser: async (id, data, majLe) => {
      const l = lignes.get(id);
      if (!l) return 0;
      lignes.set(id, { data: JSON.parse(JSON.stringify(data)), majLe, revision: l.revision + 1 });
      return 1;
    },
    creer: async (id, data, majLe) => {
      lignes.set(id, { data: JSON.parse(JSON.stringify(data)), majLe, revision: 1 });
    },
  };
  return { table, lignes };
}

const espace = { relances: [{ id: 'r1', contact: 'Marie' }], finances: { depenses: [{ id: 'd1', montant: 10 }] } };

test('les différences s’appliquent sur la version du serveur et la font avancer', async () => {
  const { table, lignes } = tableMemoire();
  await ecrireEspace(table, 'u', espace, 0);
  const local = { ...espace, finances: { depenses: [...espace.finances.depenses, { id: 'd2', montant: 3 }] } };
  const { resultat, avant, apres } = await ecrireDifferences(table, 'u', differences(espace, local), 1);
  assert.equal('conflit' in resultat, false);
  assert.equal((resultat as { revision: number }).revision, 2);
  assert.deepEqual((lignes.get('u')!.data as typeof local).finances.depenses.map((d) => d.id), ['d1', 'd2']);
  assert.deepEqual((avant as typeof local).finances.depenses.length, 1);
  assert.deepEqual((apres as typeof local).finances.depenses.length, 2);
});

test('version périmée : conflit avec la version du serveur, rien n’est écrit', async () => {
  const { table, lignes } = tableMemoire();
  await ecrireEspace(table, 'u', espace, 0);
  await ecrireEspace(table, 'u', { ...espace, sons: false }, 1);
  const { resultat } = await ecrireDifferences(table, 'u', [{ op: 'mettre', chemin: ['sons'], valeur: true }], 1);
  assert.ok('conflit' in resultat);
  assert.equal(resultat.espace.revision, 2);
  assert.equal((lignes.get('u')!.data as { sons: boolean }).sons, false);
});

test('un autre appareil écrit entre la lecture et l’écriture : conflit', async () => {
  let fois = 0;
  const { table, lignes } = tableMemoire(() => {
    if (fois++ === 1) lignes.set('u', { ...lignes.get('u')!, revision: lignes.get('u')!.revision + 1 });
  });
  await ecrireEspace(table, 'u', espace, 0);
  const { resultat } = await ecrireDifferences(table, 'u', [{ op: 'mettre', chemin: ['sons'], valeur: true }], 1);
  assert.ok('conflit' in resultat);
});

test('espace absent (404) et différences impossibles (422) : l’app renvoie alors tout', async () => {
  const { table } = tableMemoire();
  await assert.rejects(ecrireDifferences(table, 'u', [{ op: 'mettre', chemin: ['sons'], valeur: true }], 0), (e: HttpError) => e.status === 404 && e.code === 'ESPACE_ABSENT');
  await ecrireEspace(table, 'u', espace, 0);
  await assert.rejects(ecrireDifferences(table, 'u', [{ op: 'liste', chemin: ['finances'], maj: [{ id: 'x' }] }], 1), (e: HttpError) => e.status === 422 && e.code === 'DIFFERENCES_INVALIDES');
  await assert.rejects(ecrireDifferences(table, 'u', [{ op: 'mettre', chemin: [], valeur: [1] }], 1), (e: HttpError) => e.status === 422);
});
