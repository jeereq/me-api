import type { Request, Response } from 'express';

import { JustificatifService } from '../services/JustificatifService.js';
import { TAILLE_MAX } from '../services/justificatifs/fichiers.js';
import { lireFormulaire } from '../utils/formulaire.js';
import { HttpError } from '../utils/http.js';
import type { AnalyseJustificatifBody } from '../validators/schemas.js';

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
  /** Lecture d'un justificatif déjà déposé par l'IA : `{ lecture }`, à relire dans le formulaire de dépense. */
  analyser: async (req: Request, res: Response) => {
    const { id, aujourdhui, devise, categories } = req.body as AnalyseJustificatifBody;
    res.json({ lecture: await JustificatifService.analyser(req.user!.id, id, { aujourdhui, devise, categories }) });
  },
};
