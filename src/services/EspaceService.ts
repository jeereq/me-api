import { prisma } from '../utils/prisma.js';

import { ecrireEspace, lireEspace, type ResultatEcriture, type TableEspace } from './espaces/document.js';

export type ResultatPut = ResultatEcriture;

/** L'espace privé d'un compte, rangé par `userId`. */
const table: TableEspace = {
  lire: (userId) => prisma.espace.findUnique({ where: { userId }, select: { data: true, majLe: true, revision: true } }),
  ecrireSi: async (userId, revision, data, majLe) => (await prisma.espace.updateMany({ where: { userId, revision }, data: { data, majLe, revision: { increment: 1 } } })).count,
  ecraser: async (userId, data, majLe) => (await prisma.espace.updateMany({ where: { userId }, data: { data, majLe, revision: { increment: 1 } } })).count,
  creer: async (userId, data, majLe) => {
    await prisma.espace.create({ data: { userId, data, majLe, revision: 1 } });
  },
};

export const EspaceService = {
  /** Renvoie l'espace du compte, ou null s'il n'a encore rien enregistré (l'app crée alors l'espace de départ). */
  get: (userId: string) => lireEspace(table, userId),

  /**
   * Enregistre l'espace. Avec `baseRevision`, l'écriture n'a lieu que si le serveur est encore à cette version
   * (sinon `conflit`) ; sans elle (anciennes versions de l'app), la dernière écriture gagne. Voir `espaces/document.ts`.
   */
  put: (userId: string, data: Record<string, unknown>, baseRevision?: number): Promise<ResultatPut> => ecrireEspace(table, userId, data, baseRevision),
};
