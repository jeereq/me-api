import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { attenteAvantReessai, boiteGraph, GRAPH_PAR_BOITE, json, parBoite } from '../src/services/integrations/http.js';

// Un faux Graph : compte les appels simultanés par boîte, et répond 429 tant qu'on lui demande.
let graph: Server;
let simultanes = 0;
let pic = 0;
let refus = 0;
const adresse = () => `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;

before(async () => {
  graph = createServer((req, res) => {
    simultanes++;
    pic = Math.max(pic, simultanes);
    setTimeout(() => {
      simultanes--;
      if (req.url?.includes('limite') && refus > 0) {
        refus--;
        res.statusCode = 429;
        res.setHeader('Retry-After', '0');
        return res.end('{"error":{"code":"ApplicationThrottled","message":"Application is over its MailboxConcurrency limit."}}');
      }
      res.setHeader('Content-Type', 'application/json').end('{"ok":true}');
    }, 30);
  });
  await new Promise<void>((ok) => graph.listen(0, '127.0.0.1', ok));
});

after(() => graph.close());

test('la boîte visée par un appel Graph', () => {
  assert.equal(boiteGraph('https://graph.microsoft.com/v1.0/users/Helpdesk%40itmafrica.com/mailFolders/inbox'), 'users/helpdesk@itmafrica.com');
  const a = boiteGraph('https://graph.microsoft.com/v1.0/me/mailFolders/inbox', { headers: { Authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  const b = boiteGraph('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: 'Bearer bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } });
  assert.ok(a?.startsWith('me/') && b?.startsWith('me/') && a !== b, 'deux personnes, deux boîtes');
  assert.equal(boiteGraph('https://gmail.googleapis.com/gmail/v1/users/me/messages'), null);
  assert.equal(boiteGraph('https://login.microsoftonline.com/common/oauth2/v2.0/token'), null);
});

test('jamais plus de GRAPH_PAR_BOITE appels simultanés sur une même boîte', async () => {
  pic = 0;
  const url = (d: string) => `${adresse()}/v1.0/users/boite%40exemple.com/mailFolders/${d}`;
  const r = await Promise.all(['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail', 'a', 'b'].map((d) => json<{ ok: boolean }>('Outlook', url(d))));
  assert.ok(r.every((x) => x.ok));
  assert.equal(pic, GRAPH_PAR_BOITE);
});

test('deux boîtes différentes ne se gênent pas', async () => {
  let actifs = 0;
  let max = 0;
  const tache = () => parBoite('x', async () => (actifs++, (max = Math.max(max, actifs)), await new Promise((ok) => setTimeout(ok, 10)), actifs--), 1);
  const autre = () => parBoite('y', async () => (actifs++, (max = Math.max(max, actifs)), await new Promise((ok) => setTimeout(ok, 10)), actifs--), 1);
  await Promise.all([tache(), autre()]);
  assert.equal(max, 2);
});

test('un 429 de Graph est rejoué, puis réussit', async () => {
  refus = 2;
  const r = await json<{ ok: boolean }>('Outlook', `${adresse()}/v1.0/me/mailFolders/limite`, { headers: { Authorization: 'Bearer t' } });
  assert.equal(r.ok, true);
  assert.equal(refus, 0);
});

test('un 429 qui dure finit en erreur, sans boucler', async () => {
  refus = 99;
  await assert.rejects(json('Outlook', `${adresse()}/v1.0/me/mailFolders/limite`, { headers: { Authorization: 'Bearer t' } }));
  assert.equal(refus, 99 - 4);
  refus = 0;
});

test('attente avant de rejouer : Retry-After, sinon de plus en plus long, et bornée', () => {
  const h = (v?: string) => ({ headers: new Headers(v === undefined ? {} : { 'Retry-After': v }) });
  assert.ok(attenteAvantReessai(h('2'), 0) >= 2000 && attenteAvantReessai(h('2'), 0) < 2300);
  assert.ok(attenteAvantReessai(h(), 2) >= 4000);
  assert.ok(attenteAvantReessai(h('3600'), 0) <= 10_000);
});
