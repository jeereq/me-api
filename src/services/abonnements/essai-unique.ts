/**
 * Un seul essai Pro par personne. Quand un compte qui a eu un essai est supprimé, on garde une empreinte de son
 * adresse email (et de son identifiant Google) dans EssaiUtilise. Un nouveau compte dont une empreinte est connue
 * commence en Gratuit, sans essai.
 *
 * L'empreinte est un HMAC-SHA256 avec JWT_SECRET : on ne peut pas retrouver l'adresse à partir d'elle, ni la deviner
 * en essayant des adresses sans connaître le secret. Changer JWT_SECRET rend les anciennes empreintes inutilisables
 * (des personnes pourraient alors refaire un essai, rien de plus). Module pur, testé dans tests/abonnements.test.ts.
 */

import { createHmac } from 'node:crypto';

/**
 * Adresse ramenée à sa forme canonique, pour qu'une variante ne donne pas un nouvel essai : minuscules, sans
 * « +étiquette », et sans les points pour Gmail (qui les ignore).
 */
export function normaliserEmail(brut: string): string {
  const email = brut.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  let local = email.slice(0, at);
  let domaine = email.slice(at + 1);
  local = local.split('+')[0];
  if (domaine === 'googlemail.com') domaine = 'gmail.com';
  if (domaine === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domaine}`;
}

const hmac = (valeur: string, secret: string) => createHmac('sha256', secret).update(valeur).digest('hex');

/** Empreintes d'un compte : son email normalisé et, s'il en a un, son identifiant Google. */
export function empreintesCompte(c: { email: string; googleId?: string | null }, secret = process.env.JWT_SECRET || ''): string[] {
  const liste = [hmac(`email:${normaliserEmail(c.email)}`, secret)];
  if (c.googleId) liste.push(hmac(`google:${c.googleId}`, secret));
  return liste;
}
