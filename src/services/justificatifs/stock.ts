import { prisma } from '../../utils/prisma.js';

import { Cloudinary, configCloudinary, type GenreRessource } from './cloudinary.js';
import { estReference } from './fichiers.js';

/** Un justificatif retiré de sa dépense (ou dont la dépense est supprimée) est effacé de Cloudinary après ce délai. */
const JOURS_GRACE = 7;
const PAR_PASSAGE = 300;

type Ligne = { publicId: string; genre: string; userId: string; equipeId: string | null };

async function effacer(lignes: Ligne[]) {
  const c = configCloudinary();
  if (!c) return 0;
  let n = 0;
  for (const l of lignes) {
    try {
      await Cloudinary.supprimer(c, l.publicId, l.genre as GenreRessource);
      await prisma.justificatif.delete({ where: { publicId: l.publicId } });
      n++;
    } catch (e) {
      // Cloudinary injoignable : la ligne reste, le prochain passage réessaie.
      console.error('Justificatif non supprimé', l.publicId, e);
    }
  }
  return n;
}

/**
 * Les justificatifs déposés sur me-api, et leur ménage. Le fichier vit chez Cloudinary, sa fiche dans une dépense
 * de l'espace (JSON) ; la table `Justificatif` garde la trace de chaque dépôt pour retrouver ceux qui ne servent plus.
 */
export const StockJustificatifs = {
  /**
   * Passage quotidien : un justificatif déposé il y a plus d'une semaine et que son espace ne mentionne plus
   * (retiré de la dépense, dépense supprimée, ajout abandonné) est effacé. La semaine laisse le temps à un téléphone
   * resté hors ligne d'envoyer la dépense qui l'utilise, et rend « Annuler » sans risque.
   */
  async nettoyer() {
    if (!configCloudinary()) return { verifies: 0, effaces: 0 };
    const avant = new Date(Date.now() - JOURS_GRACE * 864e5);
    const lignes = await prisma.justificatif.findMany({
      where: { createdAt: { lt: avant } },
      orderBy: [{ verifieLe: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take: PAR_PASSAGE,
      select: { publicId: true, genre: true, userId: true, equipeId: true },
    });
    // Un seul chargement d'espace par propriétaire (compte ou équipe).
    const espaces = new Map<string, unknown>();
    const espaceDe = async (l: Ligne) => {
      const cle = l.equipeId ? `e:${l.equipeId}` : `u:${l.userId}`;
      if (!espaces.has(cle)) {
        const e = l.equipeId
          ? await prisma.espaceEquipe.findUnique({ where: { equipeId: l.equipeId }, select: { data: true } })
          : await prisma.espace.findUnique({ where: { userId: l.userId }, select: { data: true } });
        espaces.set(cle, e?.data ?? null);
      }
      return espaces.get(cle);
    };
    const orphelins: Ligne[] = [];
    const gardes: Ligne[] = [];
    for (const l of lignes) (estReference(await espaceDe(l), l.publicId) ? gardes : orphelins).push(l);
    if (gardes.length) await prisma.justificatif.updateMany({ where: { publicId: { in: gardes.map((l) => l.publicId) } }, data: { verifieLe: new Date() } });
    return { verifies: lignes.length, effaces: await effacer(orphelins) };
  },

  /** Suppression du compte : ses justificatifs personnels partent avec lui (ceux déposés dans une équipe restent à l'équipe). */
  async purgerCompte(userId: string) {
    await effacer(await prisma.justificatif.findMany({ where: { userId, equipeId: null } }));
  },

  /** Suppression d'une équipe : les justificatifs de son espace partagé. */
  async purgerEquipe(equipeId: string) {
    await effacer(await prisma.justificatif.findMany({ where: { equipeId } }));
  },
};
