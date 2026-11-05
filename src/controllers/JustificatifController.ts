import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as FluxWeb } from 'node:stream/web';

import type { Request, Response } from 'express';

import { estVue, JustificatifService } from '../services/JustificatifService.js';
import { TAILLE_MAX } from '../services/justificatifs/fichiers.js';
import { lireFormulaire } from '../utils/formulaire.js';
import { HttpError } from '../utils/http.js';
import type { AnalyseJustificatifBody, LiensJustificatifsBody } from '../validators/schemas.js';

/** Seuls ces types s'affichent dans le navigateur ; le reste (SVG compris) se télécharge. */
const AFFICHABLES = /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf)$/;

export const JustificatifController = {
  etat: async (_req: Request, res: Response) => {
    res.json({ disponible: JustificatifService.disponible(), tailleMax: TAILLE_MAX });
  },
  deposer: async (req: Request, res: Response) => {
    // La marge couvre les en-têtes du formulaire autour du fichier.
    const form = await lireFormulaire(req, TAILLE_MAX + 64 * 1024, 'Fichier trop lourd : 10 Mo au plus.');
    const fichier = form.get('fichier');
    if (!(fichier instanceof File)) throw new HttpError(400, 'Aucun fichier reçu (champ « fichier »).');
    const equipe = form.get('equipe');
    res.status(201).json({ justificatif: await JustificatifService.deposer(req.user!.id, fichier, typeof equipe === 'string' && equipe ? equipe : undefined) });
  },
  liens: async (req: Request, res: Response) => {
    res.json({ liens: await JustificatifService.liens(req.user!.id, (req.body as LiensJustificatifsBody).ids) });
  },
  /** Le fichier d'un lien temporaire : `<img>` ne peut pas envoyer de jeton, le lien porte donc le sien, valable 30 minutes. */
  ouvrir: async (req: Request, res: Response) => {
    const vue = estVue(req.query.vue) ? req.query.vue : 'fichier';
    const fichier = await JustificatifService.ouvrir(String(req.query.j || ''), vue);
    const type = (fichier.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const affichable = AFFICHABLES.test(type);
    res.setHeader('Content-Type', affichable ? type : 'application/octet-stream');
    res.setHeader('Content-Disposition', affichable ? 'inline' : 'attachment');
    // L'app web vit sur une autre adresse que ce serveur : sans cela, le navigateur refuse l'image.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'private, max-age=1500');
    const taille = fichier.headers.get('content-length');
    if (taille) res.setHeader('Content-Length', taille);
    // Une fenêtre fermée en cours de route n'est pas une erreur : les en-têtes sont partis, il n'y a plus rien à répondre.
    await pipeline(Readable.fromWeb(fichier.body as FluxWeb), res).catch(() => res.destroy());
  },
  /** Lecture d'un justificatif déjà déposé par l'IA : `{ lecture }`, à relire dans le formulaire de dépense. */
  analyser: async (req: Request, res: Response) => {
    const { id, aujourdhui, devise, categories } = req.body as AnalyseJustificatifBody;
    res.json({ lecture: await JustificatifService.analyser(req.user!.id, id, { aujourdhui, devise, categories }) });
  },
};
