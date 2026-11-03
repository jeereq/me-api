import { HttpError } from '../../utils/http.js';
import { prisma } from '../../utils/prisma.js';

/** La RD Congo est toujours ouverte ; le reste, un admin l'ouvre, pays par pays ou numéro par numéro. */
export const INDICATIF_OUVERT = '243';

type Ligne = { indicatif: string; numero: string };

/** Ce numéro (normalisé, sans « + ») est-il ouvert ? */
export function numeroOuvert(telephone: string, lignes: Ligne[]): boolean {
  if (telephone.startsWith(INDICATIF_OUVERT)) return true;
  return lignes.some((l) => (l.numero ? telephone === l.indicatif + l.numero : telephone.startsWith(l.indicatif)));
}

const liste = () => prisma.numeroAutorise.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true, indicatif: true, numero: true, parNom: true, createdAt: true } });

export const NumerosAutorises = {
  liste,

  /** Les indicatifs à proposer à la saisie. Jamais les numéros : cette liste est publique. Sans réponse de la base, la RD Congo seule. */
  async indicatifs() {
    const lignes = await prisma.numeroAutorise.findMany({ select: { indicatif: true }, distinct: ['indicatif'] }).catch(() => []);
    return [INDICATIF_OUVERT, ...lignes.map((l) => l.indicatif)];
  },

  /** Refuse un numéro qu'aucun admin n'a ouvert. Sert avant tout envoi de code et tout paiement. */
  async exiger(telephone: string) {
    if (telephone.startsWith(INDICATIF_OUVERT)) return;
    if (!numeroOuvert(telephone, await prisma.numeroAutorise.findMany({ select: { indicatif: true, numero: true } }))) {
      throw new HttpError(403, 'Ce numéro n’est pas autorisé pour l’instant.', 'NUMERO_NON_AUTORISE');
    }
  },

  async ajouter(parNom: string, indicatif: string, numero: string) {
    if (indicatif === INDICATIF_OUVERT) throw new HttpError(400, 'La RD Congo est déjà ouverte.');
    if (numero && !/^\d{8,15}$/.test(indicatif + numero)) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
    await prisma.numeroAutorise.upsert({ where: { indicatif_numero: { indicatif, numero } }, update: {}, create: { indicatif, numero, parNom } });
    return liste();
  },

  async retirer(id: string) {
    await prisma.numeroAutorise.deleteMany({ where: { id } });
    return liste();
  },
};
