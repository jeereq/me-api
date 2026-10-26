import { prisma } from '../utils/prisma.js';

import { assertPeutEcrire } from './equipes/droits.js';
import { EquipeService } from './EquipeService.js';
import { ecrireEspace, lireEspace, type ResultatEcriture, type TableEspace } from './espaces/document.js';

/** L'espace partagé d'une équipe, rangé par `equipeId`. Mêmes révisions et mêmes conflits que l'espace privé. */
const table: TableEspace = {
  lire: (equipeId) => prisma.espaceEquipe.findUnique({ where: { equipeId }, select: { data: true, majLe: true, revision: true } }),
  ecrireSi: async (equipeId, revision, data, majLe) => (await prisma.espaceEquipe.updateMany({ where: { equipeId, revision }, data: { data, majLe, revision: { increment: 1 } } })).count,
  ecraser: async (equipeId, data, majLe) => (await prisma.espaceEquipe.updateMany({ where: { equipeId }, data: { data, majLe, revision: { increment: 1 } } })).count,
  creer: async (equipeId, data, majLe) => {
    await prisma.espaceEquipe.create({ data: { equipeId, data, majLe, revision: 1 } });
  },
};

export const EspaceEquipeService = {
  /** Lire : tous les membres, lecteurs compris. `monRole` refuse déjà une équipe dont on n'est pas membre. */
  async get(equipeId: string, userId: string) {
    await EquipeService.monRole(equipeId, userId);
    return lireEspace(table, equipeId);
  },

  /** Écrire : tout le monde sauf les lecteurs. Voir `espaces/document.ts` pour les révisions et les conflits. */
  async put(equipeId: string, userId: string, data: Record<string, unknown>, baseRevision?: number): Promise<ResultatEcriture> {
    assertPeutEcrire(await EquipeService.monRole(equipeId, userId));
    return ecrireEspace(table, equipeId, data, baseRevision);
  },
};
