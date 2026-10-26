import type { RoleEquipe } from '@prisma/client';

import { HttpError } from '../../utils/http.js';

/** Ce que chaque rôle a le droit de faire dans une équipe, en un seul endroit. */
export const ROLES: RoleEquipe[] = ['PROPRIETAIRE', 'MEMBRE', 'LECTEUR'];

export const NOM_ROLE: Record<RoleEquipe, string> = {
  PROPRIETAIRE: 'Propriétaire',
  MEMBRE: 'Membre',
  LECTEUR: 'Lecteur',
};

/** Écrire dans l'espace de l'équipe : tout le monde sauf un lecteur. */
export const peutEcrire = (role: RoleEquipe) => role !== 'LECTEUR';

/** Gérer l'équipe (renommer, inviter, changer un rôle, retirer quelqu'un, supprimer) : les propriétaires. */
export const peutGerer = (role: RoleEquipe) => role === 'PROPRIETAIRE';

export function assertPeutEcrire(role: RoleEquipe) {
  if (!peutEcrire(role)) throw new HttpError(403, 'Tu es lecteur dans cette équipe : tu peux tout voir, mais pas modifier.', 'LECTURE_SEULE');
}

export function assertPeutGerer(role: RoleEquipe) {
  if (!peutGerer(role)) throw new HttpError(403, 'Seul un propriétaire de l’équipe peut faire ça.', 'PAS_PROPRIETAIRE');
}

/**
 * Une équipe garde toujours au moins un propriétaire : sans lui, personne ne pourrait plus inviter,
 * renommer ni supprimer l'équipe.
 */
export function assertResteUnProprietaire(roles: RoleEquipe[], idx: number, apres: RoleEquipe | null) {
  const restants = roles.filter((r, i) => (i === idx ? apres === 'PROPRIETAIRE' : r === 'PROPRIETAIRE')).length;
  if (!restants) throw new HttpError(400, 'Il faut garder au moins un propriétaire dans l’équipe. Nomme quelqu’un d’autre avant.', 'DERNIER_PROPRIETAIRE');
}
