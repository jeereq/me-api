import { texteDeBlocs, type BlocMail, type CorpsRiche } from './html-mail.js';

/** Les mails « messages non lus » de Teams : d'abord les messages, sans le logo, la publicité pour l'app ni les mentions légales. Module pur. */

// Ancienne adresse : noreply@…email.teams.microsoft.com ; nouvelle : no-reply@teams.mail.microsoft.
const EXPEDITEUR = /@(?:[\w-]+\.)*(?:teams\.microsoft\.com|teams\.mail\.microsoft)>?\s*$/i;
const PIED = /(?:install|t[ée]l[ée]charge|download|get|obten).{0,40}\b(?:app|application|teams|mobile)\b|confidentialit|privacy|microsoft corporation|one microsoft way|notifications? (?:sont|are|settings)|param[èe]tres de notification|unsubscribe/i;
const BOUTIQUE = /app store|google play|microsoft store/i;
const PUB = /install|t[ée]l[ée]charge|download/i;

export const estMailTeams = (de?: string) => EXPEDITEUR.test(de ?? '');

const estLogo = (b?: BlocMail) => b?.t === 'images' && b.items.every((x) => /teams|microsoft/i.test(x.alt ?? ''));
const toutGras = (b: BlocMail) => b.t === 'p' && b.m.length > 0 && b.m.every((x) => x.g);
const dansLePied = (b: BlocMail) => (b.t === 'images' ? b.items.some((x) => BOUTIQUE.test(x.alt ?? '')) : (b.t === 'p' || b.t === 'titre') && PIED.test(texteDeBlocs([b])));

/** Un lien seul vers Teams, en bouton. */
function enBouton(b: BlocMail): BlocMail {
  if (b.t !== 'p' || !b.m.length) return b;
  const h = b.m[0].h;
  if (!h || !/teams\.microsoft\.com/i.test(h) || b.m.some((x) => x.h !== h)) return b;
  return { t: 'bouton', v: b.m.map((x) => x.v).join('').trim(), h };
}

export function rangerMailTeams(c: CorpsRiche): CorpsRiche {
  let blocs = estLogo(c.blocs[0]) ? c.blocs.slice(1) : c.blocs;
  const i = blocs.findIndex(dansLePied);
  // La publicité pour l'app disparaît ; les mentions restent en petit, à la place de la signature.
  const pied = i >= 0 ? blocs.slice(i).filter((b) => b.t !== 'images' && !PUB.test(texteDeBlocs([b]))) : [];
  if (i >= 0) blocs = blocs.slice(0, i);
  // Le message d'accroche en gras tient lieu de titre.
  blocs = blocs.map((b, n) => (n === 0 && toutGras(b) && b.t === 'p' ? { t: 'titre', m: b.m } : enBouton(b)));
  return blocs.length ? { ...c, blocs, signature: [...pied, ...c.signature] } : c;
}

export const selonExpediteur = (c: CorpsRiche | null, de?: string) => (c && estMailTeams(de) ? rangerMailTeams(c) : c);
