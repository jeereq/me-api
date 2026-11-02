import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';

import { assertPeutEcrire } from './equipes/droits.js';
import { AssistantService } from './AssistantService.js';
import { EquipeService } from './EquipeService.js';
import { Cloudinary, configCloudinary } from './justificatifs/cloudinary.js';
import { dossier, nomPropre, TAILLE_MAX, typeFichier, vignette } from './justificatifs/fichiers.js';
import { type ContexteFacture, imagePourIA, type LectureFacture, lireLecture, messagesFacture, SCHEMA_FACTURE } from './justificatifs/lecture-ia.js';

/** L'image envoyée à l'IA : 1600 px de côté en JPEG pèse rarement plus de 1 Mo ; au-delà de 8 Mo, on n'envoie pas. */
const IMAGE_MAX = 8 * 1024 * 1024;
const DELAI_IMAGE_MS = 20_000;

/** Ce que l'app range dans la dépense (`Depense.justificatifs`). */
export type FicheJustificatif = { id: string; url: string; apercu?: string; nom: string; sorte: 'image' | 'pdf'; taille: number; pages?: number; ajouteLe: string };

export const JustificatifService = {
  disponible: () => !!configCloudinary(),

  /** Dépose une photo de reçu ou un PDF de facture, pour une dépense de son espace ou de l'espace d'une équipe. */
  async deposer(userId: string, fichier: File, equipeId?: string): Promise<FicheJustificatif> {
    const c = configCloudinary();
    if (!c) throw new HttpError(503, "Les justificatifs ne sont pas encore activés sur ce serveur (Cloudinary n'est pas configuré).", 'JUSTIFICATIFS_INDISPONIBLES');
    if (equipeId) assertPeutEcrire(await EquipeService.monRole(equipeId, userId));
    const type = typeFichier(fichier.type, fichier.name);
    if (!type) throw new HttpError(415, 'Ajoute une photo (JPEG, PNG, HEIC) ou un PDF.', 'TYPE_REFUSE');
    if (!fichier.size) throw new HttpError(400, 'Le fichier est vide.');
    if (fichier.size > TAILLE_MAX) throw new HttpError(413, 'Fichier trop lourd : 10 Mo au plus.', 'TROP_LOURD');
    const nom = nomPropre(fichier.name, type.sorte);
    let depot;
    try {
      depot = await Cloudinary.deposer(c, { contenu: fichier, nom }, dossier(userId, equipeId), type.genre);
    } catch (e) {
      console.error('Dépôt Cloudinary', e);
      throw new HttpError(502, "Le justificatif n'a pas pu être enregistré. Réessaie dans un instant.", 'DEPOT_ECHOUE');
    }
    const ligne = await prisma.justificatif.create({ data: { publicId: depot.publicId, genre: depot.genre, userId, equipeId: equipeId ?? null } });
    return {
      id: depot.publicId,
      url: depot.url,
      ...(vignette(depot.url) ? { apercu: vignette(depot.url) } : {}),
      nom,
      sorte: type.sorte,
      taille: depot.octets || fichier.size,
      ...(depot.pages && type.sorte === 'pdf' ? { pages: depot.pages } : {}),
      ajouteLe: ligne.createdAt.toISOString(),
    };
  },

  /**
   * Fait lire par l'IA un justificatif déjà déposé (photo de reçu, PDF de facture) : montant, devise, date, heure,
   * commerçant et catégorie, pour pré-remplir la dépense. Seul celui qui l'a déposé, ou un membre de l'équipe où il vit,
   * peut le faire lire. Rien n'est enregistré : l'app propose, l'utilisateur relit.
   */
  async analyser(userId: string, publicId: string, contexte: ContexteFacture): Promise<LectureFacture & { modele: string }> {
    const c = configCloudinary();
    if (!c) throw new HttpError(503, "Les justificatifs ne sont pas encore activés sur ce serveur (Cloudinary n'est pas configuré).", 'JUSTIFICATIFS_INDISPONIBLES');
    const ligne = await prisma.justificatif.findUnique({ where: { publicId }, select: { userId: true, equipeId: true, genre: true } });
    if (!ligne) throw new HttpError(404, 'Justificatif introuvable.', 'JUSTIFICATIF_INCONNU');
    if (ligne.equipeId) await EquipeService.monRole(ligne.equipeId, userId);
    else if (ligne.userId !== userId) throw new HttpError(404, 'Justificatif introuvable.', 'JUSTIFICATIF_INCONNU');
    if (ligne.genre !== 'image') throw new HttpError(415, "Ce fichier ne peut pas être lu par l'IA : ajoute une photo ou un PDF.", 'TYPE_REFUSE');

    let image: Buffer;
    try {
      const res = await fetch(imagePourIA(c.cloud, publicId), { signal: AbortSignal.timeout(DELAI_IMAGE_MS) });
      if (!res.ok) throw new Error(`Cloudinary ${res.status}`);
      image = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      console.error('Image du justificatif', publicId, (e as Error).message);
      throw new HttpError(502, "L'image du justificatif n'a pas pu être préparée. Réessaie dans un instant.", 'IMAGE_INDISPONIBLE');
    }
    if (!image.length || image.length > IMAGE_MAX) throw new HttpError(413, "Ce justificatif est trop lourd pour être lu par l'IA.", 'TROP_LOURD');

    const { texte, modele } = await AssistantService.lireImage(messagesFacture(contexte, image.toString('base64')), { type: 'json_schema', json_schema: SCHEMA_FACTURE });
    return { ...lireLecture(texte, contexte), modele };
  },
};
