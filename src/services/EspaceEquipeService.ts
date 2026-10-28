import { prisma } from '../utils/prisma.js';

import { aDesAffectations, nouvellesAffectations } from './equipes/affectations.js';
import { assertPeutEcrire } from './equipes/droits.js';
import { EquipeService } from './EquipeService.js';
import { ecrireEspace, lireEspace, type ResultatEcriture, type TableEspace } from './espaces/document.js';
import { NotificationService } from './NotificationService.js';

/** L'espace partagé d'une équipe, rangé par `equipeId`. Mêmes révisions et mêmes conflits que l'espace privé. */
const table: TableEspace = {
  lire: (equipeId) => prisma.espaceEquipe.findUnique({ where: { equipeId }, select: { data: true, majLe: true, revision: true } }),
  ecrireSi: async (equipeId, revision, data, majLe) => (await prisma.espaceEquipe.updateMany({ where: { equipeId, revision }, data: { data, majLe, revision: { increment: 1 } } })).count,
  ecraser: async (equipeId, data, majLe) => (await prisma.espaceEquipe.updateMany({ where: { equipeId }, data: { data, majLe, revision: { increment: 1 } } })).count,
  creer: async (equipeId, data, majLe) => {
    await prisma.espaceEquipe.create({ data: { equipeId, data, majLe, revision: 1 } });
  },
};

/** Prévient les membres à qui une tâche vient d'être confiée. Un échec d'envoi ne doit jamais faire échouer l'enregistrement. */
async function prevenirAffectes(equipeId: string, acteurId: string, avant: unknown, apres: Record<string, unknown>, revision: number) {
  try {
    const membres = await prisma.equipeMembre.findMany({ where: { equipeId }, select: { userId: true } });
    const affectations = nouvellesAffectations(avant, apres, acteurId, new Set(membres.map((m) => m.userId)));
    if (!affectations.length) return;
    const [equipe, acteur] = await Promise.all([
      prisma.equipe.findUnique({ where: { id: equipeId }, select: { nom: true } }),
      prisma.user.findUnique({ where: { id: acteurId }, select: { nom: true, email: true } }),
    ]);
    await NotificationService.affecter({ nom: equipe?.nom ?? 'ton équipe' }, { nom: acteur?.nom || acteur?.email || '' }, affectations, revision);
  } catch (err) {
    console.error('Avis d’affectation non envoyé', err);
  }
}

export const EspaceEquipeService = {
  /** Lire : tous les membres, lecteurs compris. `monRole` refuse déjà une équipe dont on n'est pas membre. */
  async get(equipeId: string, userId: string) {
    await EquipeService.monRole(equipeId, userId);
    return lireEspace(table, equipeId);
  },

  /**
   * Écrire : tout le monde sauf les lecteurs. Voir `espaces/document.ts` pour les révisions et les conflits.
   * Une fois l'écriture faite, les membres à qui une tâche vient d'être confiée sont prévenus (`equipes/affectations.ts`).
   */
  async put(equipeId: string, userId: string, data: Record<string, unknown>, baseRevision?: number): Promise<ResultatEcriture> {
    assertPeutEcrire(await EquipeService.monRole(equipeId, userId));
    // L'ancienne version ne se relit que s'il y a des tâches affectées à comparer.
    const avant = aDesAffectations(data) ? (await lireEspace(table, equipeId))?.data : undefined;
    const r = await ecrireEspace(table, equipeId, data, baseRevision);
    if (!('conflit' in r)) await prevenirAffectes(equipeId, userId, avant, data, r.revision);
    return r;
  },
};
