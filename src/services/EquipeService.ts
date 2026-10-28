import { createHash, randomBytes } from 'crypto';

import type { RoleEquipe } from '@prisma/client';

import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';

import { assertPeutGerer, assertResteUnProprietaire } from './equipes/droits.js';
import { EmailsEquipe } from './comptes/emails.js';
import { StockJustificatifs } from './justificatifs/stock.js';

/** Une invitation reste valable une semaine : assez pour une boîte mail relevée de temps en temps. */
const JOURS_INVITATION = 7;

const empreinte = (brut: string) => createHash('sha256').update(brut).digest('hex');

const membreSelect = { id: true, role: true, depuisLe: true, user: { select: { id: true, nom: true, email: true } } } as const;
const invitationSelect = { id: true, email: true, role: true, parNom: true, expireLe: true, createdAt: true } as const;

type MembreLu = { id: string; role: RoleEquipe; depuisLe: Date; user: { id: string; nom: string; email: string } };

const lireMembre = (m: MembreLu) => ({ id: m.user.id, nom: m.user.nom, email: m.user.email, role: m.role, depuisLe: m.depuisLe.toISOString() });

/**
 * Les équipes : des comptes « me » qui partagent un espace (budgets, objectifs, projets, tâches, habitudes).
 * Chaque équipe a ses membres avec un rôle, ses invitations par email, et un espace partagé qui suit les mêmes
 * révisions que l'espace privé (voir `espaces/document.ts`).
 */
export const EquipeService = {
  /** Les équipes du compte, avec leurs membres ; les invitations en attente ne sont montrées qu'aux propriétaires. */
  async list(userId: string) {
    const liens = await prisma.equipeMembre.findMany({
      where: { userId },
      orderBy: { depuisLe: 'asc' },
      select: { role: true, equipe: { select: { id: true, nom: true, emoji: true, createdAt: true, membres: { select: membreSelect, orderBy: { depuisLe: 'asc' } }, invitations: { where: { utiliseLe: null, expireLe: { gt: new Date() } }, select: invitationSelect, orderBy: { createdAt: 'asc' } } } } },
    });
    return liens.map(({ role, equipe }) => ({
      id: equipe.id,
      nom: equipe.nom,
      emoji: equipe.emoji,
      creeLe: equipe.createdAt.toISOString(),
      monRole: role,
      membres: equipe.membres.map(lireMembre),
      invitations: role === 'PROPRIETAIRE' ? equipe.invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, parNom: i.parNom, expireLe: i.expireLe.toISOString() })) : [],
    }));
  },

  /** Le rôle du compte dans l'équipe, ou 404 : une équipe dont on n'est pas membre n'existe pas pour nous. */
  async monRole(equipeId: string, userId: string) {
    const lien = await prisma.equipeMembre.findUnique({ where: { equipeId_userId: { equipeId, userId } }, select: { role: true } });
    if (!lien) throw new HttpError(404, 'Équipe introuvable.', 'EQUIPE_INCONNUE');
    return lien.role;
  },

  /** Crée l'équipe ; celui qui la crée en est le premier propriétaire. */
  async creer(userId: string, nom: string, emoji?: string) {
    const equipe = await prisma.equipe.create({ data: { nom, ...(emoji ? { emoji } : {}), membres: { create: { userId, role: 'PROPRIETAIRE' } } }, select: { id: true } });
    return equipe.id;
  },

  async renommer(equipeId: string, userId: string, patch: { nom?: string; emoji?: string }) {
    assertPeutGerer(await this.monRole(equipeId, userId));
    await prisma.equipe.update({ where: { id: equipeId }, data: patch });
  },

  async supprimer(equipeId: string, userId: string) {
    assertPeutGerer(await this.monRole(equipeId, userId));
    await StockJustificatifs.purgerEquipe(equipeId);
    // Les membres, les invitations et l'espace partent avec elle (cascade).
    await prisma.equipe.delete({ where: { id: equipeId } });
  },

  /**
   * Invite une adresse email. Le lien envoyé ne sert qu'une fois et expire ; seule son empreinte est gardée,
   * comme pour les liens de compte. Le compte invité doit porter cette adresse pour accepter.
   */
  async inviter(equipeId: string, userId: string, email: string, role: RoleEquipe) {
    assertPeutGerer(await this.monRole(equipeId, userId));
    if (role === 'PROPRIETAIRE') throw new HttpError(400, 'Invite d’abord comme membre ou lecteur, puis nomme la personne propriétaire une fois qu’elle a rejoint.', 'ROLE_INVITATION');

    const deja = await prisma.equipeMembre.findFirst({ where: { equipeId, user: { email } }, select: { id: true } });
    if (deja) throw new HttpError(409, 'Cette personne fait déjà partie de l’équipe.', 'DEJA_MEMBRE');

    const equipe = await prisma.equipe.findUniqueOrThrow({ where: { id: equipeId }, select: { nom: true } });
    const invitant = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { nom: true, email: true } });
    const parNom = invitant.nom || invitant.email;

    // Une seule invitation en attente par adresse : une nouvelle remplace la précédente.
    await prisma.invitationEquipe.deleteMany({ where: { equipeId, email, utiliseLe: null } });
    const brut = randomBytes(32).toString('base64url');
    const expireLe = new Date(Date.now() + JOURS_INVITATION * 24 * 60 * 60 * 1000);
    const invitation = await prisma.invitationEquipe.create({ data: { equipeId, email, role, parNom, empreinte: empreinte(brut), expireLe }, select: invitationSelect });

    const envoye = await EmailsEquipe.invitation(email, brut, equipe.nom, parNom);
    // Sans email configuré, le lien est renvoyé à celui qui invite : à lui de le transmettre.
    return { id: invitation.id, email, role, expireLe: expireLe.toISOString(), envoye, lien: envoye ? undefined : EmailsEquipe.lienInvitation(brut) };
  },

  async annulerInvitation(equipeId: string, userId: string, invitationId: string) {
    assertPeutGerer(await this.monRole(equipeId, userId));
    const { count } = await prisma.invitationEquipe.deleteMany({ where: { id: invitationId, equipeId } });
    if (!count) throw new HttpError(404, 'Invitation introuvable.', 'INVITATION_INCONNUE');
  },

  /** Ce que l'app montre avant d'accepter : quelle équipe, qui invite, et si le compte connecté peut accepter. */
  async apercuInvitation(jeton: string, email: string) {
    const i = await prisma.invitationEquipe.findUnique({ where: { empreinte: empreinte(jeton || '') }, select: { ...invitationSelect, utiliseLe: true, equipe: { select: { nom: true, emoji: true } } } });
    if (!i || i.utiliseLe || i.expireLe < new Date()) throw new HttpError(400, 'Cette invitation n’est plus valable. Demande-en une nouvelle.', 'INVITATION_INVALIDE');
    return { equipe: i.equipe.nom, emoji: i.equipe.emoji, email: i.email, role: i.role, parNom: i.parNom, pourMoi: i.email === email };
  },

  /** Accepte l'invitation : le compte connecté doit porter l'adresse invitée. */
  async rejoindre(userId: string, email: string, jeton: string) {
    const e = empreinte(jeton || '');
    const i = await prisma.invitationEquipe.findUnique({ where: { empreinte: e }, select: { id: true, equipeId: true, email: true, role: true, utiliseLe: true, expireLe: true } });
    if (!i || i.utiliseLe || i.expireLe < new Date()) throw new HttpError(400, 'Cette invitation n’est plus valable. Demande-en une nouvelle.', 'INVITATION_INVALIDE');
    if (i.email !== email) throw new HttpError(403, `Cette invitation a été envoyée à ${i.email}. Connecte-toi avec ce compte pour la rejoindre.`, 'AUTRE_ADRESSE');

    // Marque l'invitation servie avant d'ajouter le membre : deux appareils ne peuvent pas la consommer deux fois.
    const { count } = await prisma.invitationEquipe.updateMany({ where: { id: i.id, utiliseLe: null }, data: { utiliseLe: new Date() } });
    if (!count) throw new HttpError(400, 'Cette invitation vient d’être utilisée.', 'INVITATION_INVALIDE');

    await prisma.equipeMembre.upsert({ where: { equipeId_userId: { equipeId: i.equipeId, userId } }, create: { equipeId: i.equipeId, userId, role: i.role }, update: {} });
    return i.equipeId;
  },

  async changerRole(equipeId: string, userId: string, cibleId: string, role: RoleEquipe) {
    assertPeutGerer(await this.monRole(equipeId, userId));
    const membres = await prisma.equipeMembre.findMany({ where: { equipeId }, select: { userId: true, role: true }, orderBy: { depuisLe: 'asc' } });
    const idx = membres.findIndex((m) => m.userId === cibleId);
    if (idx < 0) throw new HttpError(404, 'Cette personne ne fait pas partie de l’équipe.', 'MEMBRE_INCONNU');
    assertResteUnProprietaire(membres.map((m) => m.role), idx, role);
    await prisma.equipeMembre.update({ where: { equipeId_userId: { equipeId, userId: cibleId } }, data: { role } });
  },

  /** Retire quelqu'un de l'équipe. Se retirer soi-même, c'est quitter l'équipe : pas besoin d'être propriétaire. */
  async retirer(equipeId: string, userId: string, cibleId: string) {
    const monRole = await this.monRole(equipeId, userId);
    if (cibleId !== userId) assertPeutGerer(monRole);
    const membres = await prisma.equipeMembre.findMany({ where: { equipeId }, select: { userId: true, role: true }, orderBy: { depuisLe: 'asc' } });
    const idx = membres.findIndex((m) => m.userId === cibleId);
    if (idx < 0) throw new HttpError(404, 'Cette personne ne fait pas partie de l’équipe.', 'MEMBRE_INCONNU');
    if (membres.length === 1) throw new HttpError(400, 'Tu es seul dans cette équipe : supprime-la plutôt que de la quitter.', 'DERNIER_MEMBRE');
    assertResteUnProprietaire(membres.map((m) => m.role), idx, null);
    await prisma.equipeMembre.delete({ where: { equipeId_userId: { equipeId, userId: cibleId } } });
  },
};
