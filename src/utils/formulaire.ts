import type { Request } from 'express';

import { HttpError } from './http.js';

/** Lit le formulaire multipart envoyé par l'app, sans dépasser `limite` octets (le reste n'est jamais gardé en mémoire). */
export async function lireFormulaire(req: Request, limite: number, tropLourd: string) {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) throw new HttpError(400, 'Envoie le fichier dans un formulaire (multipart/form-data).');
  if (Number(req.headers['content-length'] ?? 0) > limite) throw new HttpError(413, tropLourd, 'TROP_LOURD');
  const morceaux: Buffer[] = [];
  let total = 0;
  for await (const m of req) {
    total += (m as Buffer).length;
    if (total > limite) throw new HttpError(413, tropLourd, 'TROP_LOURD');
    morceaux.push(m as Buffer);
  }
  try {
    return await new Response(Buffer.concat(morceaux), { headers: { 'content-type': type } }).formData();
  } catch {
    throw new HttpError(400, 'Formulaire illisible.');
  }
}
