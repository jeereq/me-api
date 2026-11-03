import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import jwt from 'jsonwebtoken';

import { enTetesPiece, ErreurSaisie, MAX_PIECES, MAX_PIECES_OCTETS, messageNouveau, messageRfc822, nomDePiece, verifierPieces } from '../src/services/integrations/ecriture.js';
import { google } from '../src/services/integrations/google.js';
import { partieGmail, piecesDeGmail } from '../src/services/integrations/lecture.js';
import { microsoft } from '../src/services/integrations/microsoft.js';
import { verifyToken } from '../src/utils/jwt.js';

const vraiFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = vraiFetch;
});

type Appel = { url: string; methode: string; corps: string; entetes: Record<string, string> };
/** Simule les services : la première route qui correspond à « MÉTHODE adresse » répond. */
const simuler = (routes: [RegExp, unknown, number?][]) => {
  const appels: Appel[] = [];
  globalThis.fetch = (async (u: string | URL, o: RequestInit = {}) => {
    const url = String(u);
    const methode = o.method ?? 'GET';
    const corps = typeof o.body === 'string' ? o.body : o.body ? `[${(o.body as Uint8Array).length} octets]` : '';
    appels.push({ url, methode, corps, entetes: Object.fromEntries(new Headers(o.headers).entries()) });
    const r = routes.find(([re]) => re.test(`${methode} ${decodeURIComponent(url)}`));
    return new Response(JSON.stringify(r ? r[1] : {}), { status: r ? (r[2] ?? 200) : 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return appels;
};
const JETONS = { accessToken: 'jeton' } as never;
const piece = (nom = 'devis été.pdf', n = 5) => ({ nom, type: 'application/pdf', octets: Buffer.alloc(n, 65) });

describe('préparer une pièce jointe', () => {
  it('nettoie le nom : ni chemin, ni retour à la ligne, ni guillemet', () => {
    assert.equal(nomDePiece('C:\\photos/plan.png'), 'plan.png');
    assert.equal(nomDePiece('a"b\r\nBcc: x@y.z.pdf'), 'abBcc: x@y.z.pdf');
    assert.equal(nomDePiece('   '), 'piece-jointe');
  });
  it('refuse trop de fichiers, trop lourd, ou un fichier vide', () => {
    assert.throws(() => verifierPieces(Array.from({ length: MAX_PIECES + 1 }, () => piece())), ErreurSaisie);
    assert.throws(() => verifierPieces([piece('gros.pdf', MAX_PIECES_OCTETS + 1)]), /20 Mo/);
    assert.throws(() => verifierPieces([piece('vide.pdf', 0)]), /vide/);
  });
  it('remplace un type de fichier douteux', () => {
    assert.equal(verifierPieces([{ ...piece(), type: 'text/html\r\nX: y' }])[0].type, 'application/octet-stream');
  });
  it('n’ouvre dans le navigateur que les formats sans danger', () => {
    assert.match(enTetesPiece('a.pdf', 'application/pdf').disposition, /^inline/);
    assert.match(enTetesPiece('a.png', 'image/png; name=a').disposition, /^inline/);
    for (const t of ['text/html', 'image/svg+xml', 'application/x-msdownload', '']) {
      const e = enTetesPiece('a', t);
      assert.equal(e.type, 'application/octet-stream');
      assert.match(e.disposition, /^attachment/);
    }
    assert.match(enTetesPiece('devis été.pdf', 'application/pdf').disposition, /filename\*=UTF-8''devis%20%C3%A9t%C3%A9\.pdf$/);
  });
});

describe('composer le message', () => {
  it('sans pièce, reste un simple texte', () => {
    const m = messageNouveau({ a: ['a@b.fr'], sujet: 'S', texte: 'Bonjour' });
    assert.match(m, /Content-Type: text\/plain/);
    assert.doesNotMatch(m, /multipart/);
  });
  it('avec pièces, garde le texte et joint chaque fichier en base64', () => {
    const m = messageRfc822({ a: 'a@b.fr', sujet: 'Re: S', texte: 'Voici', messageId: '<1@x>', pieces: [piece(), { nom: 'p.png', type: 'image/png', octets: Buffer.alloc(100, 66) }] });
    const frontiere = m.match(/boundary="([^"]+)"/)?.[1] ?? '';
    assert.ok(frontiere);
    const parties = m.split(`--${frontiere}`);
    assert.equal(parties.length, 5, 'préambule, texte, deux pièces, fin');
    assert.match(parties[1], /text\/plain[\s\S]*\r\n\r\nVoici/);
    assert.match(parties[2], /filename\*=UTF-8''devis%20%C3%A9t%C3%A9\.pdf/);
    assert.match(parties[2], /QUFBQUE=/);
    assert.match(m, /In-Reply-To: <1@x>/);
    assert.ok(parties[3].split('\r\n').every((l) => l.length <= 998));
    assert.ok(parties[3].split('\r\n\r\n')[1].split('\r\n').every((l) => l.length <= 76), 'lignes de base64 de 76 colonnes au plus');
  });
});

describe('Gmail', () => {
  const payload = {
    partId: '',
    mimeType: 'multipart/mixed',
    parts: [
      { partId: '0', mimeType: 'text/plain', filename: '', body: { size: 4, data: 'YWJjZA' } },
      { partId: '1', mimeType: 'application/pdf', filename: 'devis.pdf', body: { size: 30, attachmentId: 'change-a-chaque-lecture' } },
      { partId: '2', mimeType: 'image/png', filename: 'logo.png', body: { size: 3, attachmentId: 'x' } },
    ],
  };
  it('repère les pièces par leur partie, sauf les images du texte', () => {
    assert.deepEqual(piecesDeGmail(payload, new Set(['logo.png'])), [{ id: '1', nom: 'devis.pdf', taille: 30, type: 'application/pdf' }]);
    assert.equal(partieGmail(payload, '2')?.filename, 'logo.png');
    assert.equal(partieGmail(payload, '9'), null);
  });
  it('ouvre une pièce, même si son identifiant a changé', async () => {
    const appels = simuler([
      [/GET .*\/attachments\/change-a-chaque-lecture$/, { data: Buffer.from('contenu').toString('base64url') }],
      [/GET .*\/messages\/m1\?format=full$/, { id: 'm1', payload }],
    ]);
    const p = await google.lirePiece!(JETONS, { mailId: 'm1', pieceId: '1' });
    assert.deepEqual([p.nom, p.type, p.octets.toString()], ['devis.pdf', 'application/pdf', 'contenu']);
    assert.equal(appels.length, 2);
  });
  it('signale une pièce qui n’est plus là', async () => {
    simuler([[/GET .*\/messages\/m1\?format=full$/, { id: 'm1', payload }]]);
    await assert.rejects(google.lirePiece!(JETONS, { mailId: 'm1', pieceId: '9' }), ErreurSaisie);
  });
  it('envoie avec pièces par l’adresse des fichiers, dans le bon fil', async () => {
    const appels = simuler([[/POST .*\/upload\/gmail\/v1\/users\/me\/messages\/send\?uploadType=multipart$/, { id: 'n', threadId: 't1' }]]);
    await google.repondre!(JETONS, { mailId: 'm1', fil: 't1', a: 'a@b.fr', sujet: 'S', texte: 'Voici', dest: { a: ['a@b.fr'], cc: [] }, pieces: [piece()] });
    const envoi = appels.find((a) => a.methode === 'POST');
    assert.ok(envoi);
    assert.match(envoi.entetes['content-type'], /^multipart\/related; boundary=/);
    assert.match(envoi.corps, /"threadId":"t1"/);
    assert.match(envoi.corps, /Content-Type: message\/rfc822/);
    assert.match(envoi.corps, /filename\*=UTF-8''devis/);
  });
  it('sans pièce, garde l’envoi habituel', async () => {
    const appels = simuler([[/POST .*\/gmail\/v1\/users\/me\/messages\/send$/, { id: 'n', threadId: 'n' }]]);
    await google.envoyer!(JETONS, { a: ['a@b.fr'], cc: [], sujet: 'S', texte: 'Voici' });
    assert.ok(!appels.some((a) => a.url.includes('/upload/')));
  });
  it('un nouveau mail avec pièce passe aussi par l’adresse des fichiers', async () => {
    const appels = simuler([[/POST .*\/upload\/gmail\/.*/, { id: 'n', threadId: 'n' }]]);
    await google.envoyer!(JETONS, { a: ['a@b.fr'], cc: [], sujet: 'S', texte: 'Voici', pieces: [piece()] });
    assert.equal(appels.length, 1);
    assert.doesNotMatch(appels[0].corps, /"threadId"/);
  });
});

describe('Outlook', () => {
  const routesBrouillon: [RegExp, unknown, number?][] = [
    [/POST .*\/messages\/m1\/createReplyAll$/, { id: 'b1' }],
    [/POST .*\/messages\/m1\/createReply$/, { id: 'b1' }],
    [/POST .*\/messages$/, { id: 'b1' }],
    [/PATCH .*\/messages\/b1$/, {}],
    [/POST .*\/messages\/b1\/attachments\/createUploadSession$/, { uploadUrl: 'https://envoi.exemple/session' }],
    [/POST .*\/messages\/b1\/attachments$/, { id: 'a' }],
    [/PUT https:\/\/envoi\.exemple\/session/, {}],
    [/POST .*\/messages\/b1\/send$/, {}],
    [/DELETE .*\/messages\/b1$/, {}],
  ];
  const reponse = { mailId: 'm1', a: 'a@b.fr', sujet: 'S', texte: 'Voici' };

  it('répondre sans pièce reste un « répondre à tous » direct', async () => {
    const appels = simuler([[/POST .*\/messages\/m1\/replyAll$/, {}]]);
    await microsoft.repondre!(JETONS, reponse);
    assert.equal(appels.length, 1);
  });
  it('répondre avec une pièce garde tout le monde : brouillon « à tous », pièce, envoi', async () => {
    const appels = simuler(routesBrouillon);
    await microsoft.repondre!(JETONS, { ...reponse, pieces: [piece()] });
    assert.deepEqual(appels.map((a) => a.url.replace(/^.*\/messages/, '')), ['/m1/createReplyAll', '/b1/attachments', '/b1/send']);
    assert.equal(JSON.parse(appels[1].corps).contentBytes, 'QUFBQUE=');
    assert.equal(JSON.parse(appels[1].corps)['@odata.type'], '#microsoft.graph.fileAttachment');
  });
  it('avec des personnes choisies, les fixe avant d’envoyer', async () => {
    const appels = simuler(routesBrouillon);
    await microsoft.repondre!(JETONS, { ...reponse, dest: { a: ['x@y.fr'], cc: [] }, pieces: [piece()] });
    assert.match(appels[0].url, /createReply$/);
    assert.equal(appels[1].methode, 'PATCH');
    assert.match(appels[1].corps, /x@y\.fr/);
  });
  it('au-delà de 3 Mo, envoie le fichier par morceaux, sans le jeton', async () => {
    const taille = 4 * 1024 * 1024;
    const appels = simuler(routesBrouillon);
    await microsoft.envoyer!(JETONS, { a: ['a@b.fr'], cc: [], sujet: 'S', texte: 'Voici', pieces: [piece('gros.pdf', taille)] });
    const morceaux = appels.filter((a) => a.methode === 'PUT');
    assert.equal(morceaux.length, 2);
    assert.equal(morceaux[0].entetes['content-range'], `bytes 0-3276799/${taille}`);
    assert.equal(morceaux[1].entetes['content-range'], `bytes 3276800-${taille - 1}/${taille}`);
    assert.ok(morceaux.every((m) => !m.entetes.authorization));
    assert.match(appels.find((a) => a.url.endsWith('createUploadSession'))?.corps ?? '', new RegExp(`"size":${taille}`));
    assert.match(appels.at(-1)?.url ?? '', /\/b1\/send$/);
  });
  it('si une pièce échoue, rien ne part et le brouillon est effacé', async () => {
    const appels = simuler([[/POST .*\/messages\/b1\/attachments$/, { error: { message: 'non' } }, 500], ...routesBrouillon]);
    await assert.rejects(microsoft.repondre!(JETONS, { ...reponse, pieces: [piece()] }));
    assert.ok(!appels.some((a) => a.url.endsWith('/send')));
    assert.equal(appels.at(-1)?.methode, 'DELETE');
  });
  it('un nouveau mail sans pièce reste un envoi direct', async () => {
    const appels = simuler([[/POST .*\/sendMail$/, {}]]);
    await microsoft.envoyer!(JETONS, { a: ['a@b.fr'], cc: [], sujet: 'S', texte: 'Voici' });
    assert.equal(appels.length, 1);
  });
  it('ouvre une pièce, et renvoie vers Outlook si elle n’a pas de contenu', async () => {
    simuler([
      [/GET .*\/attachments\/a1$/, { name: 'plan.pdf', contentType: 'application/pdf', contentBytes: 'QUJD' }],
      [/GET .*\/attachments\/a2$/, { name: 'mail joint' }],
    ]);
    const p = await microsoft.lirePiece!(JETONS, { mailId: 'm1', pieceId: 'a1' });
    assert.deepEqual([p.nom, p.octets.toString()], ['plan.pdf', 'ABC']);
    await assert.rejects(microsoft.lirePiece!(JETONS, { mailId: 'm1', pieceId: 'a2' }), /seulement dans Outlook/);
  });
  it('passe par la boîte partagée du mail', async () => {
    const appels = simuler([[/GET .*\/attachments\/a1$/, { name: 'plan.pdf', contentBytes: 'QUJD' }]]);
    await microsoft.lirePiece!(JETONS, { mailId: 'm1', pieceId: 'a1', boite: 'pro@b.fr' });
    assert.match(decodeURIComponent(appels[0].url), /\/users\/pro@b\.fr\/messages\/m1\//);
  });
});

describe('jetons', () => {
  it('un lien de pièce jointe ou un retour OAuth n’ouvre pas de session', () => {
    process.env.JWT_SECRET = 'secret-de-test';
    const signe = (p: object) => jwt.sign(p, 'secret-de-test', { expiresIn: '5m' });
    assert.equal(verifyToken(signe({ userId: 'u1' })).userId, 'u1');
    assert.throws(() => verifyToken(signe({ typ: 'piece', userId: 'u1' })));
    assert.throws(() => verifyToken(signe({ typ: 'oauth', userId: 'u1' })));
  });
});
