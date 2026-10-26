import type { Prisma } from '@prisma/client';

import { prisma } from '../utils/prisma.js';

type EspaceLu = { data: Prisma.JsonValue; majLe: string; revision: number };
export type ResultatPut = { majLe: string; revision: number } | { conflit: true; espace: EspaceLu };

const lu = (e: { data: Prisma.JsonValue; majLe: Date; revision: number }): EspaceLu => ({ data: e.data, majLe: e.majLe.toISOString(), revision: e.revision });
/** P2002 : violation d'unicité Prisma (un autre appareil vient de créer l'espace). */
const dejaExistant = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

export const EspaceService = {
  /** Renvoie l'espace du compte, ou null s'il n'a encore rien enregistré (l'app crée alors l'espace de départ). */
  async get(userId: string) {
    const e = await prisma.espace.findUnique({ where: { userId } });
    return e ? lu(e) : null;
  },

  /**
   * Enregistre l'espace.
   * - Avec `baseRevision` (la version que l'appareil a lue en dernier) : l'écriture n'a lieu que si le serveur est encore
   *   à cette version, de façon atomique. Sinon, un autre appareil a écrit entre-temps : on renvoie `conflit` avec la version
   *   du serveur, pour que l'appareil fusionne puis réessaie, au lieu d'écraser les changements de l'autre.
   * - Sans `baseRevision` (anciennes versions de l'app) : la dernière écriture gagne, comme avant.
   */
  async put(userId: string, data: Record<string, unknown>, baseRevision?: number): Promise<ResultatPut> {
    const majLe = new Date();
    const json = { ...data, majLe: majLe.toISOString() } as Prisma.InputJsonObject;

    if (baseRevision === undefined) {
      const e = await prisma.espace.upsert({
        where: { userId },
        create: { userId, data: json, majLe, revision: 1 },
        update: { data: json, majLe, revision: { increment: 1 } },
      });
      return { majLe: majLe.toISOString(), revision: e.revision };
    }

    // Une seule requête SQL : « mets à jour si la version est toujours celle-ci ».
    const mis = await prisma.espace.updateMany({ where: { userId, revision: baseRevision }, data: { data: json, majLe, revision: { increment: 1 } } });
    if (mis.count === 1) return { majLe: majLe.toISOString(), revision: baseRevision + 1 };

    const actuel = await prisma.espace.findUnique({ where: { userId } });
    if (actuel) return { conflit: true, espace: lu(actuel) };

    // Premier enregistrement de ce compte. Si deux appareils arrivent en même temps, le second reçoit le conflit.
    try {
      await prisma.espace.create({ data: { userId, data: json, majLe, revision: 1 } });
      return { majLe: majLe.toISOString(), revision: 1 };
    } catch (err) {
      if (!dejaExistant(err)) throw err;
      const gagnant = await prisma.espace.findUniqueOrThrow({ where: { userId } });
      return { conflit: true, espace: lu(gagnant) };
    }
  },
};
