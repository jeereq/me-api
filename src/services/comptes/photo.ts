import { HttpError } from '../../utils/http.js';
import { prisma } from '../../utils/prisma.js';
import { typeImage } from '../cotisations/approbations.js';
import { Cloudinary, configCloudinary, peutSigner, raisonCloudinary, urlLivraison } from '../justificatifs/cloudinary.js';

export const TAILLE_PHOTO_MAX = 5 * 1024 * 1024;
const DOSSIER = () => `${process.env.CLOUDINARY_DOSSIER?.trim() || 'me/justificatifs'}-profils`;

/** La photo de profil : publique par son adresse, recadrée sur le visage, et remplacée sans laisser l'ancienne. */
export const PhotoProfil = {
  async deposer(userId: string, octets: Uint8Array) {
    const c = configCloudinary();
    if (!c) throw new HttpError(503, 'L’envoi de photos n’est pas activé sur le serveur (Cloudinary n’est pas configuré).', 'PHOTOS_INDISPONIBLES');
    if (octets.length > TAILLE_PHOTO_MAX) throw new HttpError(413, 'Photo trop lourde : 5 Mo au plus.', 'TROP_LOURD');
    const type = typeImage(octets);
    if (!type) throw new HttpError(400, 'Cette photo n’est ni en JPEG, ni en PNG, ni en WebP : choisis-en une autre, ou fais une capture d’écran de celle-ci.', 'TYPE_REFUSE');
    const avant = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { photoId: true } });
    let depot;
    try {
      depot = await Cloudinary.deposer(c, { contenu: new Blob([octets.slice().buffer as ArrayBuffer], { type }), nom: 'profil' }, DOSSIER(), 'image', 'upload');
    } catch (e) {
      console.error('Photo de profil', e);
      throw new HttpError(502, `La photo n’a pas pu être enregistrée : ${raisonCloudinary(e)}.`, 'DEPOT_ECHOUE');
    }
    const url = urlLivraison(c, { publicId: depot.publicId, acces: 'upload', transformation: 'c_fill,g_face,w_256,h_256,q_auto,f_auto' });
    await prisma.user.update({ where: { id: userId }, data: { photoUrl: url, photoId: depot.publicId } });
    await this.supprimer(avant.photoId);
    return url;
  },

  /** Ne fait jamais échouer l'action en cours : une ancienne photo orpheline ne gêne personne. */
  async supprimer(photoId: string | null | undefined) {
    const c = configCloudinary();
    // Sans clé ni secret (preset non signé), l'ancienne photo reste chez Cloudinary.
    if (!c || !photoId || !peutSigner(c)) return;
    await Cloudinary.supprimer(c, photoId, 'image', 'upload').catch((e) => console.error('Photo de profil', e));
  },
};
