import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decouperSignature, indiceSignature } from '../src/commun/signature.js';
import { cidsDe, htmlEnBlocs, poserImages, texteDeBlocs, type BlocMail } from '../src/services/integrations/html-mail.js';

const blocs = (html: string) => htmlEnBlocs(html)!;
const texte = (b: BlocMail[]) => texteDeBlocs(b);

describe('mails HTML : blocs', () => {
  it('garde paragraphes, gras, liens et retours à la ligne, sans script', () => {
    const c = blocs('<html><head><style>p{color:red}</style></head><body><p>Bonjour <b>Paul</b>,<br>voir <a href="https://x.com/a">ici</a></p><script>alert(1)</script><div style="display:none">caché</div></body></html>');
    assert.equal(c.blocs.length, 1);
    const p = c.blocs[0] as Extract<BlocMail, { t: 'p' }>;
    assert.equal(p.m.map((x) => x.v).join(''), 'Bonjour Paul,\nvoir ici');
    assert.ok(p.m.some((x) => x.g && x.v === 'Paul'));
    assert.ok(p.m.some((x) => x.h === 'https://x.com/a' && x.v === 'ici'));
    assert.ok(!JSON.stringify(c).includes('alert'));
    assert.ok(!JSON.stringify(c).includes('caché'));
  });
  it('refuse les liens dangereux', () => {
    const c = blocs('<p><a href="javascript:alert(1)">clic</a></p>');
    assert.ok(!JSON.stringify(c).includes('javascript'));
  });
  it('reconnaît un tableau de données', () => {
    const c = blocs('<table border="1"><tr><th>Article</th><th>Prix</th></tr><tr><td>Stylo</td><td>2 $</td></tr><tr><td colspan="2">Total : 2 $</td></tr></table>');
    const t = c.blocs[0] as Extract<BlocMail, { t: 'table' }>;
    assert.equal(t.t, 'table');
    assert.equal(t.lignes.length, 3);
    assert.equal(t.lignes[0][0].entete, true);
    assert.equal(t.lignes[2][0].span, 2);
    assert.equal(texte(c.blocs), 'Article, Prix\nStylo, 2 $\nTotal : 2 $');
  });
  it('un tableau de mise en page garde son contenu, sans grille', () => {
    const c = blocs('<table><tr><td><img src="https://x.com/logo.png" width="80" height="80"></td><td><p>Awa Diallo</p><p>Directrice</p></td></tr></table><table><tr><td><p>Un seul bloc de texte assez long pour être un paragraphe.</p></td></tr></table>');
    assert.deepEqual(c.blocs.map((b) => b.t).filter((t) => t === 'table'), []);
    assert.ok(JSON.stringify(c).includes('Directrice'));
  });
  it('retire les mouchards et les images non sûres', () => {
    const c = blocs('<p>Salut, voici le message.</p><img src="https://t.co/p.gif" width="1" height="1"><img src="https://x.com/a.png" alt="Plan" width="300"><img src="javascript:x"><img src="data:image/svg+xml;base64,AA">');
    const im = c.blocs.find((b) => b.t === 'images') as Extract<BlocMail, { t: 'images' }>;
    assert.deepEqual(im.items.map((x) => x.src), ['https://x.com/a.png']);
    assert.equal(im.items[0].alt, 'Plan');
  });
  it('passe les images http en https', () => {
    const c = blocs('<p>Message assez long ici.</p><img src="http://x.com/a.png" width="100">');
    assert.ok(JSON.stringify(c).includes('https://x.com/a.png'));
  });
  it('remplace les images jointes, retire celles qui manquent', () => {
    const c = blocs('<p>Bonjour, voici le plan.</p><img src="cid:IMG1@x" width="100"><img src="cid:absent" width="100">');
    assert.deepEqual(cidsDe(c), ['img1@x', 'absent']);
    const p = poserImages(c, new Map([['img1@x', 'data:image/png;base64,AA']]));
    const im = p.blocs.find((b) => b.t === 'images') as Extract<BlocMail, { t: 'images' }>;
    assert.deepEqual(im.items.map((x) => x.src), ['data:image/png;base64,AA']);
  });
});

describe('mails HTML : signature et citation', () => {
  it('reconnaît les signatures marquées (Outlook, Gmail)', () => {
    for (const html of ['<p>Bonjour Paul, tout est prêt.</p><div id="Signature"><p>Awa Diallo</p></div>', '<p>Bonjour Paul, tout est prêt.</p><div class="gmail_signature"><p>Awa Diallo</p></div>', '<p>Bonjour Paul, tout est prêt.</p><div id="x_Signature"><p>Awa Diallo</p></div>']) {
      const c = blocs(html);
      assert.equal(texte(c.blocs), 'Bonjour Paul, tout est prêt.', html);
      assert.equal(texte(c.signature), 'Awa Diallo', html);
    }
  });
  it('coupe après la formule de politesse, images comprises', () => {
    const c = blocs('<p>Bonjour Paul,</p><p>Le devis est joint.</p><p>Cordialement,</p><p>Awa Diallo</p><p>+243 81 234 5678</p><img src="cid:logo" width="120">');
    assert.equal(texte(c.blocs), 'Bonjour Paul,\n\nLe devis est joint.\n\nCordialement,');
    assert.ok(texte(c.signature).startsWith('Awa Diallo'));
    assert.deepEqual(cidsDe(c), ['logo']);
    assert.equal(c.blocs.some((b) => b.t === 'images'), false);
  });
  it('coupe au milieu d’un paragraphe', () => {
    const c = blocs('<p>Bonjour Paul,<br><br>Le devis est joint.<br><br>Cordialement,<br>Awa Diallo<br>Directrice</p>');
    assert.ok(texte(c.blocs).endsWith('Cordialement,'));
    assert.equal(texte(c.signature), 'Awa Diallo\nDirectrice');
  });
  it('replie le message cité', () => {
    for (const html of ['<p>Oui, parfait.</p><div class="gmail_quote"><p>Ancien message</p></div>', '<p>Oui, parfait.</p><div id="divRplyFwdMsg"><p>De : Paul</p></div><p>Ancien message</p>', '<p>Oui, parfait.</p><hr><p>De : Paul<br>Envoyé : lundi<br>À : Awa</p><p>Ancien message</p>']) {
      const c = blocs(html);
      assert.equal(texte(c.blocs), 'Oui, parfait.', html);
      assert.ok(c.cite.length > 0, html);
    }
  });
  it('la signature d’un message cité reste avec lui', () => {
    const c = blocs('<p>Oui, parfait.</p><div class="gmail_quote"><p>Ancien</p><div class="gmail_signature">Paul</div></div>');
    assert.equal(c.signature.length, 0);
    assert.ok(texte(c.cite).includes('Paul'));
  });
  it('Outlook : le repère de citation dans une div emporte tout ce qui suit', () => {
    const c = blocs('<body><div><p>Oui, parfait.</p><div id="Signature"><p>Awa</p></div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><p>De : Paul</p></div></div><div><p>Ancien message</p></div></body>');
    assert.equal(texte(c.blocs), 'Oui, parfait.');
    assert.equal(texte(c.signature), 'Awa');
    assert.ok(texte(c.cite).includes('Ancien message'));
  });
  it('tolère le HTML mal fermé', () => {
    const c = blocs('<div><p>Un<p>Deux<ul><li>A<li>B</ul><table><tr><td>x<td>y<tr><td>1<td>2</table>');
    assert.deepEqual(c.blocs.map((b) => b.t), ['p', 'p', 'liste', 'table']);
  });
  it('garde un mail piégé rapide et sans plantage', () => {
    const debut = Date.now();
    for (const h of [`<a href="${'x'.repeat(700000)}`, '<a '.repeat(250000), '<!--'.repeat(190000), '<style>'.repeat(110000), `${'<div>'.repeat(80000)}x${'</span>'.repeat(50000)}`, '<td>'.repeat(190000), `<table>${'<tr><td>x</td></tr>'.repeat(40000)}</table>`]) htmlEnBlocs(h);
    assert.ok(Date.now() - debut < 8000, `${Date.now() - debut} ms`);
  });
  it('rien de lisible : null', () => {
    assert.equal(htmlEnBlocs('<html><body><style>x</style></body></html>'), null);
  });
});

describe('signature dans du texte', () => {
  it('coupe au délimiteur, à la formule, à « Envoyé de »', () => {
    assert.deepEqual(decouperSignature('Bonjour\n-- \nAwa\n+243 81'), { corps: 'Bonjour', signature: 'Awa\n+243 81' });
    assert.deepEqual(decouperSignature('Le devis est joint.\n\nCordialement,\nAwa Diallo\nDirectrice'), { corps: 'Le devis est joint.\n\nCordialement,', signature: 'Awa Diallo\nDirectrice' });
    assert.equal(decouperSignature('À demain.\n\nEnvoyé de mon iPhone').signature, 'Envoyé de mon iPhone');
  });
  it('« Merci » puis le nom', () => {
    assert.equal(decouperSignature('Le devis est joint.\n\nMerci,\nAwa').signature, 'Awa');
  });
  it('coupe un bloc de coordonnées', () => {
    assert.equal(decouperSignature('Le devis est joint.\n\nAwa Diallo\nTél : +243 81 234 5678\nawa@x.com').signature, 'Awa Diallo\nTél : +243 81 234 5678\nawa@x.com');
  });
  it('ne coupe pas un vrai message', () => {
    for (const t of ['Bonjour,\nCordialement est un mot que j’aime bien, et je voudrais en parler longuement avec toi demain matin.', 'Rappelle-moi au 0812345678 demain.', 'Cordialement,']) assert.equal(decouperSignature(t).signature, '', t);
    assert.equal(indiceSignature(['Une', 'ligne']), -1);
    const long = `Merci d'avance\n${'Ceci est une très longue phrase qui continue le message, bien au-delà de quatre-vingts caractères de texte.'}`;
    assert.equal(decouperSignature(long).signature, '');
  });
});
