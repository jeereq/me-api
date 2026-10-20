import type { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma.js';

export const ConfigService = {
  /** Configuration système ; vide tant que l'admin ne l'a pas enregistrée (l'app applique ses valeurs par défaut). */
  async get() {
    const c = await prisma.config.findUnique({ where: { id: 1 } });
    return (c?.data ?? {}) as Record<string, unknown>;
  },

  async put(data: Record<string, unknown>, adminId: string) {
    const json = data as Prisma.InputJsonObject;
    await prisma.config.upsert({ where: { id: 1 }, create: { id: 1, data: json, majPar: adminId }, update: { data: json, majPar: adminId } });
    return data;
  },
};
