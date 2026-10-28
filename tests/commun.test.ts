import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

// L'app copie src/commun/ d'après cette liste (me-mobile/scripts/commun.mjs) : un fichier oublié ici n'y arriverait pas.
test('fichiers.json liste tout le code commun', async () => {
  const liste = JSON.parse(await readFile('src/commun/fichiers.json', 'utf8')) as { fichiers: string[] };
  const presents = (await readdir('src/commun')).filter((n) => n.endsWith('.ts') || n === 'README.md').sort();
  assert.deepEqual([...liste.fichiers].sort(), presents);
});

// Le code commun sert tel quel à l'app : aucun import hors du dossier (ni Node, ni Prisma, ni le reste du serveur).
test('le code commun n’importe rien hors de son dossier', async () => {
  for (const nom of (await readdir('src/commun')).filter((n) => n.endsWith('.ts'))) {
    const texte = await readFile(`src/commun/${nom}`, 'utf8');
    for (const m of texte.matchAll(/from\s+'([^']+)'/g)) assert.match(m[1], /^\.\/[\w-]+\.js$/, `${nom} importe ${m[1]}`);
  }
});
