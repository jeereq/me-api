import jwt from 'jsonwebtoken';

import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';

import { assertPeutEcrire } from './equipes/droits.js';
import { AssistantService } from './AssistantService.js';
import { EquipeService } from './EquipeService.js';
import { Cloudinary, configCloudinary, type AccesRessource, type GenreRessource, urlLivraison, urlTelechargement } from './justificatifs/cloudinary.js';
import { dossier, nomPropre, TAILLE_MAX, typeFichier } from './justificatifs/fichiers.js';
import { type ContexteFacture, imagePourIA, type LectureFacture, lireLecture, messagesFacture, SCHEMA_FACTURE } from './justificatifs/lecture-ia.js';

/** L'image envoyée à l'IA : 1600 px de côté en JPEG pèse rarement plus de 1 Mo ; au-delà de 8 Mo, on n'envoie pas. */
const IMAGE_MAX = 8 * 1024 * 1024;
const DELAI_IMAGE_MS = 20_000;

/** Ce que l'app range dans la dépense (`Depense.justificatifs`). */
export type FicheJustificatif = { /** Vide : un fichier privé s'ouvre avec les liens de `/justificatifs/liens`. */ id: string; url: string; apercu?: string; nom: string; sorte: 'image' | 'pdf'; taille: number; pages?: number; ajouteLe: string };

/** Ce que l'app peut demander d'un justificatif : la vignette, l'aperçu, le fichier tel quel. */
const VUES = {
  apercu: { transformation: 'c_fill,w_240,h_240,pg_1,f_jpg,q_auto', format: 'jpg' },
  grand: { transformation: 'c_limit,w_1200,h_1200,pg_1,f_jpg,q_auto', format: 'jpg' },
  fichier: {},
} as const;
export type VueJustificatif = keyof typeof VUES;
export const estVue = (v: unknown): v is VueJustificatif => typeof v === 'string' && Object.hasOwn(VUES, v);

/** La durée d'un lien : assez pour regarder une liste, trop court pour qu'un lien copié reste utile. */
const DUREE_LIEN = '30m';

const peutVoir = async (userId: string, ligne: { userId: string; equipeId: string | null }) => {
  if (!ligne.equipeId) return ligne.userId === userId;
  return !!(await prisma.equipeMembre.findUnique({ where: { equipeId_userId: { equipeId: ligne.equipeId, userId } }, select: { role: true } }));
};

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
    const ligne = await prisma.justificatif.create({ data: { publicId: depot.publicId, genre: depot.genre, acces: 'authenticated', format: depot.format || null, userId, equipeId: equipeId ?? null } });
    return {
      id: depot.publicId,
      url: '',
      nom,
      sorte: type.sorte,
      taille: depot.octets || fichier.size,
      ...(depot.pages && type.sorte === 'pdf' ? { pages: depot.pages } : {}),
      ajouteLe: ligne.createdAt.toISOString(),
    };
  },

  /** Les liens temporaires des justificatifs que ce compte a le droit de voir ; les autres sont simplement absents. */
  async liens(userId: string, ids: string[]) {
    const lignes = await prisma.justificatif.findMany({ where: { publicId: { in: ids } }, select: { publicId: true, userId: true, equipeId: true } });
    const liens: Record<string, Record<VueJustificatif, string>> = {};
    for (const l of lignes) {
      if (!(await peutVoir(userId, l))) continue;
      const j = encodeURIComponent(jwt.sign({ typ: 'justificatif', userId, id: l.publicId }, process.env.JWT_SECRET as string, { expiresIn: DUREE_LIEN }));
      const lien = (vue: VueJustificatif) => `/api/justificatifs/ouvrir?j=${j}&vue=${vue}`;
      liens[l.publicId] = { apercu: lien('apercu'), grand: lien('grand'), fichier: lien('fichier') };
    }
    return liens;
  },

  /** Le fichier d'un lien temporaire, lu chez Cloudinary à chaque ouverture. Les droits sont revérifiés : un membre parti n'y a plus accès. */
  async ouvrir(jeton: string, vue: VueJustificatif) {
    const c = configCloudinary();
    if (!c) throw new HttpError(503, "Les justificatifs ne sont pas encore activés sur ce serveur (Cloudinary n'est pas configuré).", 'JUSTIFICATIFS_INDISPONIBLES');
    let p: { typ?: string; userId: string; id: string };
    try {
      p = jwt.verify(jeton, process.env.JWT_SECRET as string) as typeof p;
    } catch {
      throw new HttpError(401, 'Ce lien a expiré : rouvre le justificatif depuis la dépense.');
    }
    if (p.typ !== 'justificatif') throw new HttpError(401, 'Lien invalide.');
    const ligne = await prisma.justificatif.findUnique({ where: { publicId: p.id } });
    if (!ligne || !(await peutVoir(p.userId, ligne))) throw new HttpError(404, 'Justificatif introuvable.', 'JUSTIFICATIF_INCONNU');
    const f = { publicId: ligne.publicId, genre: ligne.genre as GenreRessource, acces: ligne.acces as AccesRessource };
    const voulu = VUES[vue];
    const lire = (url: string) => fetch(url, { signal: AbortSignal.timeout(DELAI_IMAGE_MS) });
    try {
      let res = await lire(urlLivraison(c, { ...f, ...('transformation' in voulu ? voulu : { format: ligne.format }) }));
      // Le CDN peut refuser de livrer un PDF (réglage de sécurité du compte Cloudinary) : l'API de téléchargement, elle, le donne.
      if (!res.ok && vue === 'fichier' && ligne.format) res = await lire(urlTelechargement(c, { ...f, format: ligne.format }));
      if (res.status === 404) throw new HttpError(404, 'Justificatif introuvable.', 'JUSTIFICATIF_INCONNU');
      if (!res.ok || !res.body) throw new Error(`Cloudinary ${res.status}`);
      return res;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      console.error('Lecture du justificatif', ligne.publicId, (e as Error).message);
      throw new HttpError(502, "Le justificatif n'a pas pu être lu. Réessaie dans un instant.", 'JUSTIFICATIF_ILLISIBLE');
    }
  },

  /**
   * Fait lire par l'IA un justificatif déjà déposé (photo de reçu, PDF de facture) : montant, devise, date, heure,
   * commerçant et catégorie, pour pré-remplir la dépense. Seul celui qui l'a déposé, ou un membre de l'équipe où il vit,
   * peut le faire lire. Rien n'est enregistré : l'app propose, l'utilisateur relit.
   */
  async analyser(userId: string, publicId: string, contexte: ContexteFacture): Promise<LectureFacture & { modele: string }> {
    const c = configCloudinary();
    if (!c) throw new HttpError(503, "Les justificatifs ne sont pas encore activés sur ce serveur (Cloudinary n'est pas configuré).", 'JUSTIFICATIFS_INDISPONIBLES');
    const ligne = await prisma.justificatif.findUnique({ where: { publicId }, select: { userId: true, equipeId: true, genre: true, acces: true } });
    if (!ligne) throw new HttpError(404, 'Justificatif introuvable.', 'JUSTIFICATIF_INCONNU');
    if (ligne.equipeId) await EquipeService.monRole(ligne.equipeId, userId);
    else if (ligne.userId !== userId) throw new HttpError(404, 'Justificatif introuvable.', 'JUSTIFICATIF_INCONNU');
    if (ligne.genre !== 'image') throw new HttpError(415, "Ce fichier ne peut pas être lu par l'IA : ajoute une photo ou un PDF.", 'TYPE_REFUSE');

    let image: Buffer;
    try {
      const adresse = ligne.acces === 'authenticated' ? urlLivraison(c, { publicId, acces: 'authenticated', transformation: 'c_limit,w_1600,h_1600,pg_1,f_jpg,q_auto', format: 'jpg' }) : imagePourIA(c.cloud, publicId);
      const res = await fetch(adresse, { signal: AbortSignal.timeout(DELAI_IMAGE_MS) });
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
