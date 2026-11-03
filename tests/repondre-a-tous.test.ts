import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { destinatairesReponse, lireAdresses, messageRfc822 } from '../src/services/integrations/ecriture.js';
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
const J = { accessToken: 'x' } as never;
const P = (adresse: string, nom?: string) => ({ ...(nom ? { nom } : {}), adresse });

describe('lire les adresses', () => {
  it('une virgule entre guillemets ne sépare pas', () => {
    assert.deepEqual(lireAdresses('Paul <p@x.fr>, "Doe, Jean" <j@x.fr>, a@x.fr'), [P('p@x.fr', 'Paul'), P('j@x.fr', 'Doe, Jean'), P('a@x.fr')]);
    assert.deepEqual(lireAdresses(''), []);
    assert.deepEqual(lireAdresses('pas une adresse'), []);
  });
});

describe('les destinataires d’une réponse à tous', () => {
  const moi = ['moi@x.fr'];
  it('garde l’expéditeur, les autres et la copie, sans soi ni doublon', () => {
    assert.deepEqual(destinatairesReponse({ de: [P('paul@x.fr')], a: [P('MOI@x.fr'), P('ana@x.fr'), P('paul@x.fr')], cc: [P('lea@x.fr'), P('ana@x.fr')] }, moi), { a: [P('paul@x.fr'), P('ana@x.fr')], cc: [P('lea@x.fr')] });
  });
  it('préfère « Répondre à » à l’expéditeur', () => {
    assert.deepEqual(destinatairesReponse({ de: [P('robot@x.fr')], repondreA: [P('equipe@x.fr')], a: [P('moi@x.fr')], cc: [] }, moi).a, [P('equipe@x.fr')]);
  });
  it('un mail venu de soi repart vers ses destinataires', () => {
    assert.deepEqual(destinatairesReponse({ de: [P('moi@x.fr')], a: [P('ana@x.fr')], cc: [P('lea@x.fr')] }, moi), { a: [P('ana@x.fr')], cc: [P('lea@x.fr')] });
  });
  it('tout le monde en copie : le premier passe destinataire', () => {
    assert.deepEqual(destinatairesReponse({ de: [P('moi@x.fr')], a: [], cc: [P('ana@x.fr'), P('lea@x.fr')] }, moi), { a: [P('ana@x.fr')], cc: [P('lea@x.fr')] });
  });
});

describe('le message Gmail', () => {
  it('écrit tous les destinataires et la copie', () => {
    const m = messageRfc822({ a: ['a@x.fr', 'Bob <b@x.fr>'], cc: ['c@x.fr'], sujet: 'S', texte: 'T' });
    assert.ok(m.includes('To: a@x.fr, b@x.fr\r\n'));
    assert.ok(m.includes('Cc: c@x.fr\r\n'));
  });
  it('pas de ligne Cc vide', () => assert.ok(!messageRfc822({ a: 'a@x.fr', sujet: 'S', texte: 'T' }).includes('Cc:')));
});

describe('répondre : Outlook', () => {
  const base = { mailId: 'm1', a: 'p@x.fr', sujet: 'S', texte: ' Merci ', moi: ['moi@x.fr'] };
  it('sans choix : répondre à tous', async () => {
    const a = banc(() => ({}));
    await microsoft.repondre!(J, base);
    assert.equal(a.length, 1);
    assert.match(a[0].url, /messages\/m1\/replyAll$/);
    assert.deepEqual(a[0].corps, { comment: 'Merci' });
  });
  it('avec un choix : exactement ces personnes, par un brouillon', async () => {
    const a = banc(({ url }) => (url.endsWith('/createReply') ? { id: 'b1' } : {}));
    await microsoft.repondre!(J, { ...base, dest: { a: ['ana@x.fr'], cc: [] } });
    assert.deepEqual(a.map((x) => [x.methode, x.url.split('/messages/')[1]]), [['POST', 'm1/createReply'], ['PATCH', 'b1'], ['POST', 'b1/send']]);
    assert.deepEqual(a[1].corps, { toRecipients: [{ emailAddress: { address: 'ana@x.fr' } }], ccRecipients: [] });
  });
  it('un envoi raté efface le brouillon', async () => {
    const appels: Appel[] = [];
    globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
      const url = decodeURIComponent(String(u));
      appels.push({ url, methode: init?.method ?? 'GET' });
      if (url.endsWith('/send')) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify(url.endsWith('/createReply') ? { id: 'b1' } : {}), { status: 200 });
    }) as typeof fetch;
    await assert.rejects(microsoft.repondre!(J, { ...base, dest: { a: ['ana@x.fr'], cc: [] } }));
    assert.equal(appels.at(-1)!.methode, 'DELETE');
  });
  it('lit les personnes sans télécharger le mail', async () => {
    const a = banc(() => ({ from: { emailAddress: { name: 'Paul', address: 'p@x.fr' } }, toRecipients: [{ emailAddress: { address: 'moi@x.fr' } }, { emailAddress: { name: 'Ana', address: 'a@x.fr' } }], ccRecipients: [{ emailAddress: { address: 'c@x.fr' } }] }));
    const d = await microsoft.destinataires!(J, { mailId: 'm1', moi: ['moi@x.fr'] });
    assert.deepEqual(d, { a: [P('p@x.fr', 'Paul'), P('a@x.fr', 'Ana')], cc: [P('c@x.fr')] });
    assert.ok(a[0].url.includes('$select=from,replyTo,toRecipients,ccRecipients'));
    assert.ok(!a[0].url.includes('body'));
  });
});

describe('répondre : Gmail', () => {
  const entetes = [{ name: 'From', value: 'Paul <p@x.com>' }, { name: 'To', value: 'moi@x.com, "Doe, Ana" <a@x.com>' }, { name: 'Cc', value: 'c@x.com' }];
  const raw = (a: Appel) => Buffer.from((a.corps as { raw: string }).raw, 'base64url').toString('utf8');
  const lire = ({ url }: Appel) => (url.includes('format=metadata') ? { id: 'g1', payload: { headers: entetes } } : { id: 'e', threadId: 't1' });
  it('sans choix : tout le monde reste, soi en moins', async () => {
    const a = banc(lire);
    await google.repondre!(J, { mailId: 'g1', fil: 't1', a: 'Paul <p@x.com>', sujet: 'Devis', texte: 'Merci', moi: ['moi@x.com'] });
    const m = raw(a.find((x) => x.url.endsWith('/send'))!);
    assert.ok(m.includes('To: p@x.com, a@x.com\r\n'), m);
    assert.ok(m.includes('Cc: c@x.com\r\n'), m);
  });
  it('avec un choix : ces personnes seulement, sans relire le mail', async () => {
    const a = banc(lire);
    await google.repondre!(J, { mailId: 'g1', a: 'p@x.com', sujet: 'Devis', texte: 'Merci', dest: { a: ['a@x.com'], cc: [] } });
    assert.equal(a.length, 1);
    const m = raw(a[0]);
    assert.ok(m.includes('To: a@x.com\r\n'));
    assert.ok(!m.includes('Cc:'));
  });
  it('si les personnes ne se lisent pas, répond quand même à l’expéditeur', async () => {
    const appels: Appel[] = [];
    globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
      const a = { url: decodeURIComponent(String(u)), methode: init?.method ?? 'GET', corps: init?.body ? JSON.parse(String(init.body)) : undefined };
      appels.push(a);
      if (a.url.includes('format=metadata')) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ id: 'e', threadId: 't1' }), { status: 200 });
    }) as typeof fetch;
    await google.repondre!(J, { mailId: 'g1', a: 'Paul <p@x.com>', sujet: 'Devis', texte: 'Merci', moi: [] });
    assert.ok(raw(appels.at(-1)!).includes('To: p@x.com\r\n'));
  });
});
