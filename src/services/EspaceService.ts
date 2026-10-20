import type { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma.js';

export const EspaceService = {
  /** Renvoie l'espace du compte, ou null s'il n'a encore rien enregistré (l'app crée alors l'espace de départ). */
  async get(userId: string) {
    const e = await prisma.espace.findUnique({ where: { userId } });
    return e ? { data: e.data, majLe: e.majLe.toISOString() } : null;
  },

  async put(userId: string, data: Record<string, unknown>) {
    const majLe = new Date();
    const json = { ...data, majLe: majLe.toISOString() } as Prisma.InputJsonObject;
    await prisma.espace.upsert({ where: { userId }, create: { userId, data: json, majLe }, update: { data: json, majLe } });
    return { majLe: majLe.toISOString() };
  },
};
