import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { avecSignature, MAX_SIGNATURES, signatureChoisie, signaturesValides, texteEnHtml } from '../src/services/integrations/ecriture.js';
import { google } from '../src/services/integrations/google.js';
import { microsoft } from '../src/services/integrations/microsoft.js';

const vraiFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = vraiFetch;
});
const simuler = (routes: [RegExp, unknown, number?][]) => {
  const vus: { url: string; corps: string }[] = [];
  globalThis.fetch = (async (u: string | URL, o: RequestInit = {}) => {
    const url = decodeURIComponent(String(u));
    vus.push({ url, corps: typeof o.body === 'string' ? o.body : '' });
    const r = routes.find(([re]) => re.test(url));
    return new Response(JSON.stringify(r ? r[1] : {}), { status: r ? (r[2] ?? 200) : 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return vus;
};
const JETONS = { accessToken: 'x' } as never;

describe('signer un mail', () => {
  const sig = 'Jeereq T.\n+243 817 125 577';
  it('ajoute la signature après le texte', () => {
    assert.equal(avecSignature(' Bonjour ', sig), `Bonjour\n\n${sig}`);
  });
  it('ne change rien sans signature', () => {
    assert.equal(avecSignature(' Bonjour ', null), 'Bonjour');
    assert.equal(avecSignature('Bonjour', '   '), 'Bonjour');
  });
  it('ne la répète pas si elle est déjà à la fin', () => {
    assert.equal(avecSignature(`Bonjour\n\njeereq t.\n+243  817 125 577`, sig), `Bonjour\n\njeereq t.\n+243  817 125 577`);
  });
  it('prend celle choisie, aucune, ou celle par défaut', () => {
    const p = { signatures: [{ id: 'a', nom: 'Pro', texte: 'A' }, { id: 'b', nom: 'Perso', texte: 'B' }], signatureDefaut: 'a' };
    assert.equal(signatureChoisie(p, 'b'), 'B');
    assert.equal(signatureChoisie(p, null), undefined);
    assert.equal(signatureChoisie(p), 'A');
    assert.equal(signatureChoisie(p, 'retiree'), 'A');
    assert.equal(signatureChoisie({ signatures: p.signatures, signatureDefaut: null }), undefined);
    assert.equal(signatureChoisie({}), undefined);
  });
  it('relit les signatures sans garder ce qui est abîmé', () => {
    assert.deepEqual(signaturesValides([{ id: 'a', nom: ' Pro ', texte: ' T ', extra: 1 }, { id: '', nom: 'x', texte: 'y' }, { id: 'b', nom: 'x', texte: ' ' }, null, 3]), [{ id: 'a', nom: 'Pro', texte: 'T' }]);
    assert.deepEqual(signaturesValides('x'), []);
    assert.equal(signaturesValides(Array.from({ length: 20 }, (_, i) => ({ id: `${i}`, nom: 'n', texte: 't' }))).length, MAX_SIGNATURES);
  });
});

describe('une réponse Outlook garde ses lignes', () => {
  it('écrit le texte en HTML, sans laisser passer de balise', () => {
    assert.equal(texteEnHtml(' Bonjour\n\nA < B & C > D\r\nFin '), 'Bonjour<br><br>A &lt; B &amp; C &gt; D<br>Fin');
  });
  it('à tous comme à une personne', async () => {
    const vus = simuler([[/replyAll$/, {}]]);
    await microsoft.repondre!(JETONS, { mailId: 'm1', a: 'a@b.fr', sujet: 'S', texte: 'Ligne 1\nLigne 2' });
    assert.deepEqual(JSON.parse(vus[0].corps), { comment: 'Ligne 1<br>Ligne 2' });
    const vus2 = simuler([[/createReply$/, { id: 'b1' }], [/messages\/b1\/send$/, {}], [/messages\/b1$/, {}]]);
    await microsoft.repondre!(JETONS, { mailId: 'm1', a: 'a@b.fr', sujet: 'S', texte: 'Ligne 1\nLigne 2', dest: { a: ['x@y.fr'], cc: [] } });
    assert.deepEqual(JSON.parse(vus2[0].corps), { comment: 'Ligne 1<br>Ligne 2' });
  });
});

describe('savoir si la boîte a changé, sans la lire', () => {
  it('Gmail : le repère de son historique, un seul appel', async () => {
    const vus = simuler([[/\/profile$/, { historyId: '1234', messagesTotal: 9 }]]);
    assert.equal(await google.empreinte!(JETONS, {}), '1234');
    assert.equal(vus.length, 1);
  });
  it('Outlook : les totaux de la réception, des envoyés et des boîtes partagées', async () => {
    const vus = simuler([
      [/users\/pro@x\.fr\/mailFolders\/inbox/, { totalItemCount: 5, unreadItemCount: 1 }],
      [/me\/mailFolders\/inbox/, { totalItemCount: 10, unreadItemCount: 2 }],
      [/me\/mailFolders\/sentitems/, { totalItemCount: 7, unreadItemCount: 0 }],
    ]);
    assert.equal(await microsoft.empreinte!(JETONS, { boitesPartagees: ['pro@x.fr', 'refusee@x.fr'] }), '10/2,7/0,5/1,-');
    assert.ok(vus.every((v) => !/\/messages/.test(v.url)), 'aucun mail lu');
  });
  it('Outlook : la panne du compte lui-même remonte', async () => {
    simuler([]);
    await assert.rejects(microsoft.empreinte!(JETONS, {}));
  });
});

describe('reprendre une signature existante', () => {
  it('Gmail : celle de l’adresse par défaut, en texte', async () => {
    simuler([[/settings\/sendAs$/, { sendAs: [{ isPrimary: true, signature: '<div>Ancienne</div>' }, { isDefault: true, signature: '<div>Jeereq<br>Kinshasa</div>' }] }]]);
    assert.equal(await google.signature!(JETONS), 'Jeereq\nKinshasa');
  });
  it('Gmail : rien si elle n’existe pas', async () => {
    simuler([[/settings\/sendAs$/, { sendAs: [{ isDefault: true, signature: '' }] }]]);
    assert.equal(await google.signature!(JETONS), '');
  });
  it('Outlook : retrouvée à la fin d’un mail envoyé', async () => {
    const corps = 'Bonjour Paul,\n\nVoici le devis.\n\n--\nJeereq T.\nDirecteur\n+243 817 125 577';
    const vus = simuler([[/sentitems\/messages/, { value: [{ uniqueBody: { contentType: 'text', content: 'Vu.' } }, { uniqueBody: { contentType: 'text', content: corps } }] }]]);
    assert.match(await microsoft.signature!(JETONS), /Jeereq T\.\nDirecteur\n\+243/);
    assert.match(vus[0].url, /\$select=uniqueBody/);
  });
  it('Outlook : ignore la mention « Envoyé depuis Outlook »', async () => {
    simuler([[/sentitems\/messages/, { value: [{ uniqueBody: { contentType: 'text', content: 'Merci pour ton aide sur ce dossier.\n\nSent from Outlook for iOS' } }] }]]);
    assert.equal(await microsoft.signature!(JETONS), '');
  });
});
