import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({ log: ['error', 'warn'] });

/**
 * Traduit les pannes de base de données en message lisible (renvoyé au client à la place de « Erreur serveur »).
 * null pour toute autre erreur.
 */
export function messagePrisma(err: unknown): string | null {
  const e = err as { code?: string; errorCode?: string; name?: string };
  const code = e?.code ?? e?.errorCode;
  if (code === 'P2021' || code === 'P2022') return "La base de données n'est pas à jour : le serveur doit lancer `npm run prisma:migrate:deploy`.";
  if (code === 'P1000') return 'Connexion à la base refusée : vérifie DATABASE_URL (utilisateur ou mot de passe).';
  if (code === 'P1001' || code === 'P1002' || code === 'P1017') return 'Base de données injoignable : vérifie DATABASE_URL et que la base est démarrée.';
  if (code === 'P1003') return "La base indiquée dans DATABASE_URL n'existe pas.";
  if (code === 'P2034') return 'Conflit avec une autre opération en cours, réessaie.';
  if (e?.name === 'PrismaClientInitializationError') return 'Le serveur ne parvient pas à se connecter à la base : vérifie DATABASE_URL.';
  return null;
}
