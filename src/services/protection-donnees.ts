import { enCoffre } from '../utils/coffre.js';
import { prisma } from '../utils/prisma.js';

const LOT = 200;
const PASSAGES = 20;

/**
 * Chiffre ce qui a été écrit en clair avant le coffre : comptes qui ne se synchronisent plus, analyses pas encore périmées.
 * La condition de l'UPDATE laisse intacte une ligne qu'une synchro vient de réécrire entre-temps.
 */
export async function chiffrerAnciennes() {
  let comptes = 0;
  let analyses = 0;
  for (let i = 0; i < PASSAGES; i++) {
    const lignes = await prisma.$queryRaw<{ id: string; valeur: unknown }[]>`SELECT "id", "donnees" AS "valeur" FROM "Integration" WHERE "donnees" IS NOT NULL AND NOT ("donnees" ? 'chiffre') LIMIT ${LOT}`;
    for (const l of lignes) comptes += await prisma.$executeRaw`UPDATE "Integration" SET "donnees" = ${JSON.stringify(enCoffre(l.valeur))}::jsonb WHERE "id" = ${l.id} AND NOT ("donnees" ? 'chiffre')`;
    if (lignes.length < LOT) break;
  }
  for (let i = 0; i < PASSAGES; i++) {
    const lignes = await prisma.$queryRaw<{ id: string; valeur: unknown }[]>`SELECT "id", "resultat" AS "valeur" FROM "AnalyseMail" WHERE NOT ("resultat" ? 'chiffre') LIMIT ${LOT}`;
    for (const l of lignes) analyses += await prisma.$executeRaw`UPDATE "AnalyseMail" SET "resultat" = ${JSON.stringify(enCoffre(l.valeur))}::jsonb WHERE "id" = ${l.id} AND NOT ("resultat" ? 'chiffre')`;
    if (lignes.length < LOT) break;
  }
  return { comptes, analyses };
}
