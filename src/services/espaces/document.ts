import type { Prisma } from '@prisma/client';

/**
 * Le contrat d'écriture d'un espace, le même pour l'espace privé d'un compte et pour l'espace partagé d'une équipe.
 *
 * Chaque espace est un document JSON avec un numéro de version (`revision`), augmenté de 1 à chaque écriture.
 * Un appareil envoie la version qu'il a lue en dernier : si le serveur en est encore là, l'écriture a lieu ; sinon,
 * quelqu'un a écrit entre-temps et on renvoie `conflit` avec la version du serveur, pour que l'appareil fusionne
 * puis réessaie, au lieu d'écraser le travail de l'autre.
 */
export type DocumentLu = { data: Prisma.JsonValue; majLe: string; revision: number };
export type ResultatEcriture = { majLe: string; revision: number } | { conflit: true; espace: DocumentLu };

/** Ce qu'une table doit savoir faire pour servir d'espace : lire, écrire si la version colle, créer. */
export type TableEspace = {
  lire(id: string): Promise<{ data: Prisma.JsonValue; majLe: Date; revision: number } | null>;
  /** Écrit seulement si la ligne est encore à `revision` ; renvoie le nombre de lignes touchées (0 ou 1). */
  ecrireSi(id: string, revision: number, json: Prisma.InputJsonObject, majLe: Date): Promise<number>;
  /** Écrase sans condition (anciennes versions de l'app, qui n'envoient pas de version). */
  ecraser(id: string, json: Prisma.InputJsonObject, majLe: Date): Promise<number>;
  creer(id: string, json: Prisma.InputJsonObject, majLe: Date): Promise<void>;
};

const lu = (e: { data: Prisma.JsonValue; majLe: Date; revision: number }): DocumentLu => ({ data: e.data, majLe: e.majLe.toISOString(), revision: e.revision });

/** P2002 : violation d'unicité Prisma (un autre appareil vient de créer l'espace au même moment). */
const dejaExistant = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

export async function lireEspace(table: TableEspace, id: string) {
  const e = await table.lire(id);
  return e ? lu(e) : null;
}

export async function ecrireEspace(table: TableEspace, id: string, data: Record<string, unknown>, baseRevision?: number): Promise<ResultatEcriture> {
  const majLe = new Date();
  const json = { ...data, majLe: majLe.toISOString() } as Prisma.InputJsonObject;

  if (baseRevision === undefined) {
    const touchees = await table.ecraser(id, json, majLe);
    if (!touchees) await table.creer(id, json, majLe);
    const apres = await table.lire(id);
    return { majLe: majLe.toISOString(), revision: apres?.revision ?? 1 };
  }

  // Une seule requête SQL : « mets à jour si la version est toujours celle-ci ».
  if ((await table.ecrireSi(id, baseRevision, json, majLe)) === 1) return { majLe: majLe.toISOString(), revision: baseRevision + 1 };

  const actuel = await table.lire(id);
  if (actuel) return { conflit: true, espace: lu(actuel) };

  // Premier enregistrement. Si deux appareils arrivent en même temps, le second reçoit le conflit.
  try {
    await table.creer(id, json, majLe);
    return { majLe: majLe.toISOString(), revision: 1 };
  } catch (err) {
    if (!dejaExistant(err)) throw err;
    const gagnant = await table.lire(id);
    if (!gagnant) throw err;
    return { conflit: true, espace: lu(gagnant) };
  }
}
