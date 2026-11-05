import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { htmlEnBlocs, type BlocMail } from '../src/services/integrations/html-mail.js';
import { estMailTeams, selonExpediteur } from '../src/services/integrations/mail-teams.js';

const HTML = `<table role="presentation" width="600">
<tr><td><img src="https://x.net/logo.png" width="118" height="28" alt="Microsoft Teams"></td></tr>
<tr><td style="font-size:24px;font-weight:600">Votre équipe essaie de vous joindre</td></tr>
<tr><td>Vous avez 3 messages non lus.</td></tr>
<tr><td><table role="presentation" width="100%"><tr><td width="48"><img src="https://x.net/a.png" width="40" height="40" alt="Jean"></td><td><div style="font-weight:600">Jean Dupont</div><div>Peux-tu regarder le devis ?</div></td></tr></table></td></tr>
<tr><td><a href="https://teams.microsoft.com/l/message/1">Accéder à la conversation</a></td></tr>
<tr><td>Installez l'application Teams</td></tr>
<tr><td><a href="https://aka.ms/i"><img src="https://x.net/s.png" width="120" height="40" alt="App Store"></a></td></tr>
<tr><td>Microsoft Corporation, One Microsoft Way, Redmond</td></tr></table>`;

const types = (b: BlocMail[]) => b.map((x) => x.t);

describe('mail de messages non lus de Teams', () => {
  it('reconnaît ses deux adresses, et elles seules', () => {
    for (const a of ['noreply@email.teams.microsoft.com', 'noreply@emeaemail.teams.microsoft.com', 'no-reply@teams.mail.microsoft', 'Teams <no-reply@teams.mail.microsoft>']) assert.equal(estMailTeams(a), true, a);
    for (const a of ['paul@microsoft.com', 'x@teams.microsoft.com.pirate.fr', undefined]) assert.equal(estMailTeams(a), false, String(a));
  });
  it('garde les messages, retire la publicité et met les mentions en petit', () => {
    const c = selonExpediteur(htmlEnBlocs(HTML), 'noreply@email.teams.microsoft.com')!;
    assert.deepEqual(types(c.blocs), ['titre', 'p', 'rangee', 'bouton']);
    assert.deepEqual(c.blocs[3], { t: 'bouton', v: 'Accéder à la conversation', h: 'https://teams.microsoft.com/l/message/1' });
    assert.deepEqual(types(c.signature), ['p']);
    assert.match(JSON.stringify(c.signature), /Microsoft Corporation/);
  });
  it('ne touche pas au mail de quelqu’un d’autre', () => {
    const c = htmlEnBlocs(HTML)!;
    assert.deepEqual(selonExpediteur(c, 'paul@x.fr'), c);
    assert.equal(selonExpediteur(null, 'no-reply@teams.mail.microsoft'), null);
  });
});

describe('bouton dans un mail', () => {
  it('un lien sur un fond de couleur, dans une cellule ou seul', () => {
    const cellule = htmlEnBlocs('<p>Bonjour</p><table><tr><td bgcolor="#5b5fc7"><a href="https://x.fr/a">Voir</a></td></tr></table>')!;
    assert.deepEqual(cellule.blocs[1], { t: 'bouton', v: 'Voir', h: 'https://x.fr/a' });
    const lien = htmlEnBlocs('<p>Bonjour</p><a href="https://x.fr/a" style="display:inline-block;background-color:#123456;padding:8px">Voir</a>')!;
    assert.deepEqual(lien.blocs[1], { t: 'bouton', v: 'Voir', h: 'https://x.fr/a' });
  });
  it('un lien dans une phrase, ou sur fond blanc, reste un lien', () => {
    const phrase = htmlEnBlocs('<table><tr><td bgcolor="#eeeeee">Lire <a href="https://x.fr/a">ici</a></td></tr></table>')!;
    assert.equal(phrase.blocs[0].t, 'p');
    const blanc = htmlEnBlocs('<table><tr><td bgcolor="#ffffff"><a href="https://x.fr/a">Voir</a></td></tr></table>')!;
    assert.equal(blanc.blocs[0].t, 'p');
  });
});
