import type { Request, Response } from 'express';

import { HttpError } from '../utils/http.js';
import { AnalyseMailService } from '../services/AnalyseMailService.js';
import { lireTraduction, type LangueTraduction } from '../services/analyse-mails.js';
import { AssistantService } from '../services/AssistantService.js';
import { aDroit, etatAbonnement, messageReserve, SELECT_ABONNEMENT } from '../services/abonnements/offres.js';
import { dureeComptee, ReunionService } from '../services/ReunionService.js';
import { prisma } from '../utils/prisma.js';

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

/** Le compte rendu envoyé à l'IA porte-t-il le texte d'un enregistrement ? */
const contientTranscription = (donnees: unknown) => {
  if (typeof donnees !== 'string' || !donnees.includes('"transcription"')) return false;
  try {
    const j = JSON.parse(donnees) as { transcription?: unknown };
    return typeof j.transcription === 'string' && j.transcription.trim().length > 0;
  } catch {
    return false;
  }
};

export const AssistantController = {
  /** Transcrit l'enregistrement d'une réunion : `{ texte }`. Le fichier n'est jamais gardé. */
  transcrire: async (req: Request, res: Response) => {
    const form = await lireFormulaire(req, AUDIO_MAX + 64 * 1024);
    const audio = form.get('audio');
    if (!(audio instanceof File) || !audio.size) throw new HttpError(400, 'Aucun enregistrement reçu (champ « audio »).');
    if (audio.size > AUDIO_MAX) throw new HttpError(413, 'Enregistrement trop long : 25 Mo au plus.', 'TROP_LOURD');
    const contexte = form.get('contexte');
    const annoncee = Number(form.get('duree'));
    // Les heures du palier (ou les minutes d'essai) : on refuse avant de transcrire quand il n'en reste pas assez.
    const etat = etatAbonnement(await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: SELECT_ABONNEMENT }));
    const compteur = await ReunionService.compteur(req.user!.id, etat);
    const duree = dureeComptee(audio.size, Number.isFinite(annoncee) ? annoncee : null);
    if (compteur && !compteur.illimite && compteur.restantesSecondes! < duree) {
      const reste = Math.floor(compteur.restantesSecondes! / 60);
      throw new HttpError(402, `Il te reste ${reste} min de réunion${etat.offre === 'essai' ? ' dans ton essai' : ' ce mois-ci'}, et cet enregistrement en demande ${Math.ceil(duree / 60)}. Passe au palier supérieur dans Mon compte › Abonnement.`, 'QUOTA_REUNIONS');
    }
    const r = await AssistantService.transcrire(audio, typeof contexte === 'string' ? contexte : undefined);
    // Une transcription qui échoue ne consomme rien : on ne compte qu'ici.
    if (compteur && !compteur.illimite) await ReunionService.consommer(req.user!.id, compteur.cle, duree);
    res.json({ ...r, dureeSecondes: duree });
  },
  status: async (_req: Request, res: Response) => {
    res.json({ disponible: await AssistantService.disponible() });
  },
  modeles: async (_req: Request, res: Response) => {
    res.json(await AssistantService.modeles());
  },
  demander: async (req: Request, res: Response) => {
    // L'analyse d'une réunion enregistrée (une transcription dans le compte rendu) fait partie des paliers Pro 1 à 3 ; celle de simples notes reste dans Pro.
    if (req.body.type === 'compte_rendu' && contientTranscription(req.body.donnees)) {
      const etat = etatAbonnement(await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: SELECT_ABONNEMENT }));
      if (!aDroit(etat, 'reunions')) throw new HttpError(402, messageReserve('reunions'), 'ABONNEMENT_REQUIS');
    }
    res.json({ text: await AssistantService.demander(req.body) });
  },
  /** L'analyse de mails lus par le serveur : `{ analyses }` comme la réponse de l'IA, avec ce qui venait de la mémoire. */
  analyserMails: async (req: Request, res: Response) => {
    if (!(await AssistantService.disponible())) throw new HttpError(503, "L'IA n'est pas activée sur ce serveur.");
    const { analyses, enCache, fraiches, illisibles } = await AnalyseMailService.analyser(req.user!.id, req.body);
    res.json({ analyses, enCache, fraiches, illisibles });
  },
  /** Comprendre une boucle de mails et, si besoin, préparer la réponse. */
  analyserBoucle: async (req: Request, res: Response) => {
    if (!(await AssistantService.disponible())) throw new HttpError(503, "L'IA n'est pas activée sur ce serveur.");
    res.json(await AnalyseMailService.analyserBoucle(req.user!.id, req.body));
  },
  /** Traduire un mail, une réponse ou une analyse. Rien n'est gardé. */
  traduire: async (req: Request, res: Response) => {
    if (!(await AssistantService.disponible())) throw new HttpError(503, "L'IA n'est pas activée sur ce serveur.");
    const { langue, textes } = req.body as { langue: LangueTraduction; textes: string[] };
    const r = await AssistantService.demanderAvecModeles({ type: 'traduction', langue, donnees: JSON.stringify({ textes }) });
    const traduits = lireTraduction(r.texte, textes);
    if (!traduits) throw new HttpError(502, "L'IA n'a pas pu traduire ce texte. Réessaie dans un instant.");
    res.json({ textes: traduits });
  },
  /** Ajuster une réponse proposée. */
  ajusterReponse: async (req: Request, res: Response) => {
    if (!(await AssistantService.disponible())) throw new HttpError(503, "L'IA n'est pas activée sur ce serveur.");
    res.json({ reponse: await AnalyseMailService.ajusterReponse(req.user!.id, req.body) });
  },
  /** Ce qui est déjà analysé parmi ces mails. */
  etatsAnalyse: async (req: Request, res: Response) => {
    res.json({ etats: await AnalyseMailService.etats(req.user!.id, req.body.mails) });
  },
  /** Relire une réponse avant de l'envoyer. */
  relireReponse: async (req: Request, res: Response) => {
    if (!(await AssistantService.disponible())) throw new HttpError(503, "L'IA n'est pas activée sur ce serveur.");
    res.json(await AnalyseMailService.relireReponse(req.user!.id, req.body));
  },
};
