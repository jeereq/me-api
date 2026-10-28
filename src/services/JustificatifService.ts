import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';

import { assertPeutEcrire } from './equipes/droits.js';
import { EquipeService } from './EquipeService.js';
import { Cloudinary, configCloudinary } from './justificatifs/cloudinary.js';
import { dossier, nomPropre, TAILLE_MAX, typeFichier, vignette } from './justificatifs/fichiers.js';

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
};
