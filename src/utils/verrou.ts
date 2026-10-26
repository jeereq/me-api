import { randomUUID } from 'crypto';

import { prisma } from './prisma.js';

/**
 * Verrou à bail dans la base, pour qu'une tâche planifiée ne tourne que sur une instance à la fois
 * (plusieurs instances Render, redémarrage pendant un passage, déploiement en parallèle).
 *
 * Un verrou en base plutôt qu'un verrou Postgres de session : avec un pool de connexions, le déverrouillage
 * pourrait partir d'une autre connexion que le verrouillage. Le bail expire tout seul si l'instance tombe.
 * Les horloges comparées sont celles de la base (en UTC, comme Prisma écrit les dates), pas celles des instances.
 */
export async function prendreVerrou(nom: string, bailSecondes: number): Promise<string | null> {
  const porteur = randomUUID();
  const lignes = await prisma.$queryRaw<{ porteur: string }[]>`
    INSERT INTO "VerrouCron" ("nom", "porteur", "jusqua")
    VALUES (${nom}, ${porteur}, (now() AT TIME ZONE 'utc') + make_interval(secs => ${bailSecondes}::double precision))
    ON CONFLICT ("nom") DO UPDATE SET "porteur" = EXCLUDED."porteur", "jusqua" = EXCLUDED."jusqua"
    WHERE "VerrouCron"."jusqua" < (now() AT TIME ZONE 'utc')
    RETURNING "porteur"`;
  return lignes.length === 1 && lignes[0].porteur === porteur ? porteur : null;
}

/** Relâche le verrou, seulement s'il est encore à nous (le bail a pu expirer et être repris par une autre instance). */
export async function relacherVerrou(nom: string, porteur: string) {
  await prisma.verrouCron.deleteMany({ where: { nom, porteur } });
}

/** Exécute `tache` si aucune autre instance ne la fait déjà. Renvoie false quand elle est ignorée. */
export async function avecVerrou(nom: string, bailSecondes: number, tache: () => Promise<unknown>): Promise<boolean> {
  const porteur = await prendreVerrou(nom, bailSecondes);
  if (!porteur) return false;
  try {
    await tache();
  } finally {
    await relacherVerrou(nom, porteur).catch((e) => console.error('Verrou non relâché', nom, e));
  }
  return true;
}
