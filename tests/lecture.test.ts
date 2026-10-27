import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { base64Url } from '../src/services/integrations/ecriture.js';
import { decoderEntites, depuisBase64Url, htmlEnTexte, nettoyerTexte, TEXTE_MAX, texteDeGmail } from '../src/services/integrations/lecture.js';

describe('texte d’un mail HTML', () => {
  it('garde les lignes et les liens, retire le reste', () => {
    const t = htmlEnTexte('<html><head><style>p{}</style></head><body><p>Bonjour&nbsp;Paul,</p><p>Voici le <a href="https://ex.fr/devis">devis</a>.<br>À bientôt &amp; merci</p><ul><li>Un</li><li>Deux</li></ul></body></html>');
    assert.equal(t, 'Bonjour Paul,\nVoici le devis (https://ex.fr/devis).\nÀ bientôt & merci\n\n• Un\n• Deux');
  });
  it('décode les entités numériques', () => {
    assert.equal(htmlEnTexte('l&#39;&#xE9;t&eacute;'), "l'été");
  });
});

describe('extraits Gmail', () => {
  it('décode les entités sans toucher au reste', () => {
    assert.equal(decoderEntites('C&#39;est d&#39;accord &amp; merci &lt;3'), "C'est d'accord & merci <3");
  });
});

describe('nettoyage', () => {
  it('jamais plus d’une ligne vide', () => {
    assert.equal(nettoyerTexte('a  \r\n\r\n\r\n\r\nb\t\tc'), 'a\n\nb c');
  });
  it('coupe un texte trop long', () => {
    const t = nettoyerTexte('x'.repeat(TEXTE_MAX + 10));
    assert.ok(t.length < TEXTE_MAX + 100);
    assert.match(t, /mail d'origine/);
  });
});

describe('message Gmail', () => {
  const enc = (s: string) => base64Url(s);
  it('préfère la partie texte, et liste les pièces jointes', () => {
    const r = texteDeGmail({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: enc('Bonjour, ça va ?') } }, { mimeType: 'text/html', body: { data: enc('<p>Bonjour</p>') } }] },
        { mimeType: 'application/pdf', filename: 'facture.pdf', body: { attachmentId: 'a1', size: 1200 } },
      ],
    });
    assert.deepEqual(r, { texte: 'Bonjour, ça va ?', piecesJointes: ['facture.pdf'] });
  });
  it('se rabat sur le HTML quand il n’y a que ça', () => {
    assert.equal(texteDeGmail({ mimeType: 'text/html', body: { data: enc('<div>Salut</div>') } }).texte, 'Salut');
  });
  it('tient devant un message vide', () => {
    assert.deepEqual(texteDeGmail(undefined), { texte: '', piecesJointes: [] });
  });
  it('décode le base64 « URL safe »', () => {
    assert.equal(depuisBase64Url(enc('é?~>')), 'é?~>');
  });
});
