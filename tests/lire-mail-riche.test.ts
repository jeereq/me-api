import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { google } from '../src/services/integrations/google.js';
import { microsoft } from '../src/services/integrations/microsoft.js';

const vraiFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = vraiFetch;
});
const repondre = (routes: [RegExp, unknown][], vus: string[] = []) => {
  globalThis.fetch = (async (u: string | URL) => {
    const url = decodeURIComponent(String(u));
    vus.push(url);
    const r = routes.find(([re]) => re.test(url));
    return new Response(JSON.stringify(r ? r[1] : {}), { status: r ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
};
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const JETONS = { accessToken: 'x' } as never;

const HTML = '<div><p>Bonjour Paul,</p><table border="1"><tr><th>Article</th><th>Prix</th></tr><tr><td>Stylo</td><td>2 $</td></tr></table><img src="cid:plan@x" width="200"></div><div id="Signature"><p>Awa Diallo</p><img src="cid:logo@x" width="90"></div>';

describe('lire un mail : Outlook', () => {
  const routes: [RegExp, unknown][] = [
    [/messages\/m1\/attachments\/a1$/, { id: 'a1', contentId: '<plan@x>', contentBytes: 'QUJD', contentType: 'image/png' }],
    [/messages\/m1\/attachments\/a2$/, { id: 'a2', contentId: 'logo@x', contentBytes: 'REVG', contentType: 'image/jpeg' }],
    [/messages\/m1\/attachments\?/, { value: [{ id: 'a1', name: 'image001.png', size: 3, isInline: true, contentType: 'image/png' }, { id: 'a2', name: 'image002.jpg', size: 3, isInline: true, contentType: 'image/jpeg' }, { id: 'a3', name: 'devis.pdf', size: 3, isInline: false, contentType: 'application/pdf' }, { id: 'a4', name: 'trop-lourde.png', size: 9000000, isInline: true, contentType: 'image/png' }] }],
    [/messages\/m1\?/, { id: 'm1', subject: 'Devis', isRead: true, hasAttachments: false, body: { contentType: 'html', content: HTML }, from: { emailAddress: { name: 'Awa', address: 'a@x.com' } } }],
  ];
  it('pour l’écran : tableau, images jointes, signature à part, voix sans signature', async () => {
    repondre(routes);
    const m = await microsoft.lireMail!(JETONS, 'm1', 'UTC', { garderNonLu: true, riche: true });
    assert.deepEqual(m.riche!.blocs.map((b) => b.t), ['p', 'table', 'images']);
    assert.ok(JSON.stringify(m.riche!.blocs).includes('data:image/png;base64,QUJD'));
    assert.ok(JSON.stringify(m.riche!.signature).includes('data:image/jpeg;base64,REVG'));
    assert.equal(m.riche!.aLire, 'Bonjour Paul,\n\nArticle, Prix\nStylo, 2 $');
    assert.ok(!m.riche!.aLire.includes('Awa'));
    // Les images du texte ne sont pas des pièces jointes, même si Graph dit « sans pièce jointe ».
    assert.deepEqual(m.piecesJointes, ['devis.pdf']);
    assert.ok(m.texte.includes('Awa Diallo'));
  });
  it('pour le copilote : le texte seul, sans télécharger d’image', async () => {
    const vus: string[] = [];
    repondre(routes, vus);
    const m = await microsoft.lireMail!(JETONS, 'm1', 'UTC', { garderNonLu: true });
    assert.equal(m.riche, undefined);
    assert.ok(m.texte.includes('Stylo | 2 $'));
    assert.ok(!vus.some((u) => /attachments\/a\d/.test(u)));
  });
  it('un mail en texte n’a pas de mise en forme', async () => {
    repondre([[/messages\/m2\?/, { id: 'm2', isRead: true, body: { contentType: 'text', content: 'Salut' } }]]);
    const m = await microsoft.lireMail!(JETONS, 'm2', 'UTC', { garderNonLu: true, riche: true });
    assert.equal(m.riche, undefined);
    assert.equal(m.texte, 'Salut');
  });
});

describe('lire un mail : Gmail', () => {
  it('pour l’écran : image jointe chargée, et retirée des pièces jointes', async () => {
    const payload = {
      mimeType: 'multipart/related',
      headers: [{ name: 'From', value: 'Awa <a@x.com>' }],
      parts: [
        { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('Bonjour Paul') } }, { mimeType: 'text/html', body: { data: b64('<p>Bonjour Paul</p><img src="cid:plan@x" width="200"><div class="gmail_signature">Awa</div>') } }] },
        { mimeType: 'image/png', filename: 'plan.png', headers: [{ name: 'Content-ID', value: '<plan@x>' }], body: { attachmentId: 'at1', size: 3 } },
        { mimeType: 'application/pdf', filename: 'devis.pdf', body: { attachmentId: 'at2', size: 3 } },
      ],
    };
    repondre([
      [/messages\/g1\/attachments\/at1$/, { data: 'QU-_' }],
      [/messages\/g1\?/, { id: 'g1', threadId: 't1', labelIds: [], payload }],
    ]);
    const m = await google.lireMail!(JETONS, 'g1', 'UTC', { garderNonLu: true, riche: true });
    assert.equal(m.texte, 'Bonjour Paul');
    assert.equal(m.riche!.aLire, 'Bonjour Paul');
    assert.ok(JSON.stringify(m.riche!.blocs).includes('data:image/png;base64,QU+/'));
    assert.equal(m.riche!.signature.length, 1);
    assert.deepEqual(m.piecesJointes, ['devis.pdf']);
  });
});
