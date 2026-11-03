import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { mailsApresTri } from '../src/services/integrations/choix.js';
import { google } from '../src/services/integrations/google.js';
import { microsoft } from '../src/services/integrations/microsoft.js';

const vraiFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = vraiFetch;
});
type Appel = { url: string; methode: string; corps?: unknown };
const banc = (lire: (a: Appel) => unknown) => {
  const appels: Appel[] = [];
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    const a = { url: decodeURIComponent(String(u)), methode: init?.method ?? 'GET', corps: init?.body ? JSON.parse(String(init.body)) : undefined };
    appels.push(a);
    return new Response(JSON.stringify(lire(a) ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return appels;
};
const JETONS = { accessToken: 'x' } as never;

describe('trier des mails : Gmail', () => {
  it('marque tout le fil comme lu, sans rien télécharger', async () => {
    const a = banc(() => ({}));
    await google.marquerLu!(JETONS, { mailId: 'm1', fil: 't1' });
    assert.equal(a.length, 1);
    assert.match(a[0].url, /threads\/t1\/modify$/);
    assert.deepEqual(a[0].corps, { removeLabelIds: ['UNREAD'] });
  });
  it('archive : le fil quitte la réception et devient lu ; sans fil, le message seul', async () => {
    const a = banc(() => ({}));
    await google.archiver!(JETONS, { mailId: 'm1' });
    assert.match(a[0].url, /messages\/m1\/modify$/);
    assert.deepEqual(a[0].corps, { removeLabelIds: ['INBOX', 'UNREAD'] });
  });
});

describe('trier des mails : Outlook', () => {
  const graph = ({ url, methode }: Appel) => {
    if (methode !== 'GET') return {};
    if (url.includes('/messages/m1?')) return { conversationId: 'c1', parentFolderId: 'inbox', isRead: false };
    if (url.includes('$filter')) return { value: [{ id: 'm1', isRead: false, parentFolderId: 'inbox' }, { id: 'm0', isRead: false, parentFolderId: 'inbox' }, { id: 'r1', isRead: true, parentFolderId: 'envoyes' }] };
    return {};
  };
  const ecrits = (a: Appel[]) => a.filter((x) => x.methode !== 'GET');
  it('marque le mail et les autres non lus de son fil', async () => {
    const a = banc(graph);
    await microsoft.marquerLu!(JETONS, { mailId: 'm1' });
    assert.deepEqual(ecrits(a).map((x) => [x.methode, x.url.split('/messages/')[1]]).sort(), [['PATCH', 'm0'], ['PATCH', 'm1']]);
  });
  it('archive le fil de la réception, pas les envoyés', async () => {
    const a = banc(graph);
    await microsoft.archiver!(JETONS, { mailId: 'm1' });
    const moves = ecrits(a).filter((x) => x.url.endsWith('/move'));
    assert.deepEqual(moves.map((x) => x.url.split('/messages/')[1]).sort(), ['m0/move', 'm1/move']);
    assert.deepEqual(moves[0].corps, { destinationId: 'archive' });
  });
  it('une boîte partagée reste la boîte visée', async () => {
    const a = banc(graph);
    await microsoft.marquerLu!(JETONS, { mailId: 'm1', boite: 'info@x.com' });
    assert.ok(a.every((x) => x.url.includes('/users/info@x.com/')), a[0].url);
  });
});

describe('les mails gardés après un tri', () => {
  const l = [{ id: 'a', nonLu: true }, { id: 'b', nonLu: true }];
  it('lu : reste dans la liste', () => assert.deepEqual(mailsApresTri(l, ['a'], 'lu'), [{ id: 'a', nonLu: false }, { id: 'b', nonLu: true }]));
  it('archivé : quitte la liste', () => assert.deepEqual(mailsApresTri(l, ['a'], 'archiver'), [{ id: 'b', nonLu: true }]));
});
