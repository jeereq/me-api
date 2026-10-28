import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { delai, estDelai } from '../src/utils/delai.js';
import { ErreurExterne, json } from '../src/services/integrations/http.js';

// Un « service externe » qui accepte la connexion mais ne répond jamais, et un autre qui répond tout de suite.
let muet: Server;
let vif: Server;
const adresse = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

before(async () => {
  muet = createServer(() => {});
  vif = createServer((_req, res) => res.setHeader('Content-Type', 'application/json').end('{"ok":true}'));
  await Promise.all([muet, vif].map((s) => new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))));
});

after(() => {
  muet.closeAllConnections();
  muet.close();
  vif.close();
});

test('un service qui ne répond pas est interrompu au bout du délai', async () => {
  const debut = Date.now();
  await assert.rejects(fetch(adresse(muet), { signal: delai(80) }), (e) => estDelai(e));
  assert.ok(Date.now() - debut < 2000, 'l’appel ne reste pas ouvert');
});

test('un réseau coupé n’est pas pris pour un délai dépassé', async () => {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const url = adresse(s);
  await new Promise((ok) => s.close(ok));
  await assert.rejects(fetch(url, { signal: delai(2000) }), (e) => !estDelai(e));
});

test('json() : un service muet donne une erreur lisible, pas une requête bloquée', async () => {
  // Délai court imposé par le signal de l'appelant (il passe avant celui par défaut).
  await assert.rejects(json('Slack', adresse(muet), { signal: AbortSignal.timeout(80) }), (e) => e instanceof ErreurExterne && e.message === 'Slack met trop de temps à répondre.' && !e.auth);
});

test('json() : un service qui répond est lu normalement', async () => {
  assert.deepEqual(await json<{ ok: boolean }>('Slack', adresse(vif)), { ok: true });
});
