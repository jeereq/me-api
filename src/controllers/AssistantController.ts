import type { Request, Response } from 'express';

import { HttpError } from '../utils/http.js';
import { AnalyseMailService } from '../services/AnalyseMailService.js';
import { AssistantService } from '../services/AssistantService.js';

/** Taille maximale d'un enregistrement : la limite d'OpenAI (25 Mo), soit ~90 minutes en AAC mono 32 kbit/s. */
export const AUDIO_MAX = 25 * 1024 * 1024;

/** Lit le formulaire multipart de l'app sans garder en mémoire plus de `limite` octets. */
async function lireFormulaire(req: Request, limite: number) {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) throw new HttpError(400, "Envoie l'enregistrement dans un formulaire (multipart/form-data).");
  if (Number(req.headers['content-length'] ?? 0) > limite) throw new HttpError(413, 'Enregistrement trop long : 25 Mo au plus.', 'TROP_LOURD');
  const morceaux: Buffer[] = [];
  let total = 0;
  for await (const m of req) {
    total += (m as Buffer).length;
    if (total > limite) throw new HttpError(413, 'Enregistrement trop long : 25 Mo au plus.', 'TROP_LOURD');
    morceaux.push(m as Buffer);
  }
  try {
    return await new Response(Buffer.concat(morceaux), { headers: { 'content-type': type } }).formData();
  } catch {
    throw new HttpError(400, 'Formulaire illisible.');
  }
}

export const AssistantController = {
  /** Transcrit l'enregistrement d'une réunion : `{ texte }`. Le fichier n'est jamais gardé. */
  transcrire: async (req: Request, res: Response) => {
    const form = await lireFormulaire(req, AUDIO_MAX + 64 * 1024);
    const audio = form.get('audio');
    if (!(audio instanceof File) || !audio.size) throw new HttpError(400, 'Aucun enregistrement reçu (champ « audio »).');
    if (audio.size > AUDIO_MAX) throw new HttpError(413, 'Enregistrement trop long : 25 Mo au plus.', 'TROP_LOURD');
    const contexte = form.get('contexte');
    res.json(await AssistantService.transcrire(audio, typeof contexte === 'string' ? contexte : undefined));
  },
  status: async (_req: Request, res: Response) => {
    res.json({ disponible: await AssistantService.disponible() });
  },
  modeles: async (_req: Request, res: Response) => {
    res.json(await AssistantService.modeles());
  },
  demander: async (req: Request, res: Response) => {
    res.json({ text: await AssistantService.demander(req.body) });
  },
  /** L'analyse de mails lus par le serveur : `{ analyses }` comme la réponse de l'IA, avec ce qui venait de la mémoire. */
  analyserMails: async (req: Request, res: Response) => {
    if (!(await AssistantService.disponible())) throw new HttpError(503, "L'IA n'est pas activée sur ce serveur.");
    const { analyses, enCache, fraiches, illisibles } = await AnalyseMailService.analyser(req.user!.id, req.body);
    res.json({ analyses, enCache, fraiches, illisibles });
  },
};
