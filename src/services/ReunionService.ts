import { prisma } from '../utils/prisma.js';
import type { EtatAbonnement } from './abonnements/offres.js';

const MINUTE = 60;

/**
 * La durée comptée pour un enregistrement : celle annoncée par l'app, ramenée dans ce que le poids du fichier rend crédible
 * (entre 16 000 octets/s, 128 kbit/s, et 2 000 octets/s, soit deux fois moins que les ~4 000 octets/s d'un AAC mono 32 kbit/s),
 * arrondie à la minute supérieure, une minute au moins. Sans durée annoncée, on compte le maximum crédible.
 */
export function dureeComptee(octets: number, annoncee?: number | null): number {
  const plafond = Math.ceil(octets / 2000);
  const plancher = Math.ceil(octets / 16000);
  const demandee = typeof annoncee === 'number' && Number.isFinite(annoncee) && annoncee > 0 ? annoncee : plafond;
  const bornee = Math.min(plafond, Math.max(plancher, demandee));
  return Math.max(MINUTE, Math.ceil(bornee / MINUTE) * MINUTE);
}

export type CompteurReunions = { cle: string; limiteSecondes: number; utiliseesSecondes: number; /** null : illimité. */ restantesSecondes: number | null; illimite: boolean } | null;

export const ReunionService = {
  /** Où en est le compte : limite de sa période (mois du palier, ou essai), déjà transcrit et reste. Null si les réunions ne sont pas ouvertes. */
  async compteur(userId: string, e: Pick<EtatAbonnement, 'reunions'>): Promise<CompteurReunions> {
    const r = e.reunions;
    if (!r) return null;
    if (r.illimite) return { cle: r.cle, limiteSecondes: 0, utiliseesSecondes: 0, restantesSecondes: null, illimite: true };
    const u = await prisma.usageReunion.findUnique({ where: { userId_cle: { userId, cle: r.cle } }, select: { secondes: true } });
    const utilisees = u?.secondes ?? 0;
    return { cle: r.cle, limiteSecondes: r.secondes, utiliseesSecondes: utilisees, restantesSecondes: Math.max(0, r.secondes - utilisees), illimite: false };
  },

  /** Ajoute l'audio transcrit au compteur de la période (seulement après une transcription réussie). */
  async consommer(userId: string, cle: string, secondes: number) {
    await prisma.usageReunion.upsert({ where: { userId_cle: { userId, cle } }, create: { userId, cle, secondes }, update: { secondes: { increment: secondes } } });
  },
};
