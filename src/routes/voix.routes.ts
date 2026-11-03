import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { Eve, lirePlage } from '../services/voix/eve.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { essaiVoixSchema, voixSchema } from '../validators/schemas.js';

const message = (error: string) => ({ error });
// Chaque lecture se paie.
const limiteEssai = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: message('Tu as bien essayé Eve. Réessaie dans une heure.') });
const limiteCompte = rateLimit({ windowMs: 60 * 1000, limit: 30, keyGenerator: (req) => req.user!.id, standardHeaders: 'draft-7', legacyHeaders: false, message: message('Eve reprend son souffle. Réessaie dans une minute.') });

const router = Router();

router.post('/essai', limiteEssai, validateRequest(essaiVoixSchema), asyncHandler(async (req, res) => res.json(await Eve.essai(req.body.texte))));
router.post('/eve', authenticateJWT, limiteCompte, validateRequest(voixSchema), asyncHandler(async (req, res) => res.json(await Eve.dire(req.user!.id, req.body.texte))));

/** L'audio préparé : son adresse imprévisible et de courte durée sert de droit d'accès, car un lecteur audio n'envoie pas de jeton. */
router.get('/audio/:jeton', (req, res) => {
  const audio = Eve.audio(req.params.jeton);
  if (!audio) throw new HttpError(404, 'Cette lecture n’existe plus.');
  res.set({ 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  const plage = lirePlage(req.headers.range, audio.length);
  if (!plage) return void res.send(audio);
  res.status(206).set('Content-Range', `bytes ${plage.debut}-${plage.fin}/${audio.length}`).send(audio.subarray(plage.debut, plage.fin + 1));
});

export default router;
