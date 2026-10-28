/**
 * Ce que le propriétaire voit d'une invitation en attente, et les règles qui la font disparaître de la liste.
 * Module pur (aucun accès à la base), testé dans `tests/invitations.test.ts`.
 */

export type InvitationLue = { id: string; email: string; role: string; parNom: string; expireLe: Date; ouverteLe: Date | null; ouvertePar: string | null };

/** Adresses comparées sans tenir compte des majuscules ni des espaces autour. */
export const memeAdresse = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * - `envoyee` : personne n'a encore ouvert le lien ;
 * - `ouverte` : le lien a été ouvert avec le compte invité, qui n'a pas encore cliqué sur « Rejoindre » ;
 * - `autre_compte` : le lien a été ouvert avec un compte qui porte une autre adresse : il ne pourra pas l'accepter.
 */
export type EtatInvitation = 'envoyee' | 'ouverte' | 'autre_compte';

export function etatInvitation(i: Pick<InvitationLue, 'email' | 'ouverteLe' | 'ouvertePar'>): EtatInvitation {
  if (!i.ouverteLe) return 'envoyee';
  return i.ouvertePar && !memeAdresse(i.ouvertePar, i.email) ? 'autre_compte' : 'ouverte';
}

/** Les invitations à montrer : celles dont l'adresse est déjà celle d'un membre n'ont plus rien à attendre (personne n'est invité deux fois). */
export function invitationsAffichables<T extends { email: string }>(invitations: T[], emailsMembres: string[]): T[] {
  return invitations.filter((i) => !emailsMembres.some((m) => memeAdresse(m, i.email)));
}

/** L'invitation telle que l'app la reçoit. `ouvertePar` n'est donné que quand c'est une autre adresse : c'est elle qu'on peut inviter à la place. */
export function invitationPourApp(i: InvitationLue) {
  const etat = etatInvitation(i);
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    parNom: i.parNom,
    expireLe: i.expireLe.toISOString(),
    etat,
    ...(i.ouverteLe ? { ouverteLe: i.ouverteLe.toISOString() } : {}),
    ...(etat === 'autre_compte' && i.ouvertePar ? { ouvertePar: i.ouvertePar } : {}),
  };
}
