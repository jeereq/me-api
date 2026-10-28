import type { Request, Response } from 'express';

import { JustificatifService } from '../services/JustificatifService.js';
import { TAILLE_MAX } from '../services/justificatifs/fichiers.js';
import { HttpError } from '../utils/http.js';

/** Lit le formulaire multipart envoyé par l'app, sans dépasser `limite` octets (le reste n'est jamais gardé en mémoire). */
async function lireFormulaire(req: Request, limite: number) {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) throw new HttpError(400, 'Envoie le fichier dans un formulaire (multipart/form-data).');
  if (Number(req.headers['content-length'] ?? 0) > limite) throw new HttpError(413, 'Fichier trop lourd : 10 Mo au plus.', 'TROP_LOURD');
  const morceaux: Buffer[] = [];
  let total = 0;
  for await (const m of req) {
    total += (m as Buffer).length;
    if (total > limite) throw new HttpError(413, 'Fichier trop lourd : 10 Mo au plus.', 'TROP_LOURD');
    morceaux.push(m as Buffer);
  }
  try {
    return await new Response(Buffer.concat(morceaux), { headers: { 'content-type': type } }).formData();
  } catch {
    throw new HttpError(400, 'Formulaire illisible.');
  }
}

export const JustificatifController = {
  etat: async (_req: Request, res: Response) => {
    res.json({ disponible: JustificatifService.disponible(), tailleMax: TAILLE_MAX });
  },
  deposer: async (req: Request, res: Response) => {
    // La marge couvre les en-têtes du formulaire autour du fichier.
    const form = await lireFormulaire(req, TAILLE_MAX + 64 * 1024);
    const fichier = form.get('fichier');
    if (!(fichier instanceof File)) throw new HttpError(400, 'Aucun fichier reçu (champ « fichier »).');
    const equipe = form.get('equipe');
    res.status(201).json({ justificatif: await JustificatifService.deposer(req.user!.id, fichier, typeof equipe === 'string' && equipe ? equipe : undefined) });
  },
};
