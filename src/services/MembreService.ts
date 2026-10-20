import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';

const select = { id: true, email: true, nom: true, role: true, createdAt: true } as const;

/** Garde au moins un admin : sans lui, plus personne ne pourrait toucher à la configuration. */
async function assertPasDernierAdmin(id: string) {
  const cible = await prisma.user.findUnique({ where: { id } });
  if (!cible) throw new HttpError(404, 'Compte introuvable.');
  if (cible.role === 'ADMIN' && (await prisma.user.count({ where: { role: 'ADMIN' } })) <= 1) throw new HttpError(400, 'Il faut garder au moins un admin.');
}

export const MembreService = {
  list: () => prisma.user.findMany({ select, orderBy: { createdAt: 'asc' } }),

  async setRole(id: string, role: 'ADMIN' | 'UTILISATEUR') {
    if (role === 'UTILISATEUR') await assertPasDernierAdmin(id);
    return prisma.user.update({ where: { id }, data: { role }, select });
  },

  async remove(id: string, parId: string) {
    if (id === parId) throw new HttpError(400, 'Tu ne peux pas supprimer ton propre compte ici.');
    await assertPasDernierAdmin(id);
    await prisma.user.delete({ where: { id } });
  },
};
