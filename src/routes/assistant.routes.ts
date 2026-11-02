import { Router } from 'express';

import { AssistantController } from '../controllers/AssistantController.js';
import { requireFonction, requirePro } from '../middlewares/abonnement.js';
import { authenticateJWT, requireAdmin } from '../middlewares/authenticateJWT.js';
import { analyseMailsLimiter, assistantLimiter, transcriptionLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { analyseMailsSchema, assistantSchema } from '../validators/schemas.js';

const router = Router();
router.use(authenticateJWT);
router.get('/', asyncHandler(AssistantController.status));
router.get('/modeles', requireAdmin, asyncHandler(AssistantController.modeles));
router.post('/', requirePro('assistant'), assistantLimiter, validateRequest(assistantSchema), asyncHandler(AssistantController.demander));
router.post('/mails', requirePro('assistant'), analyseMailsLimiter, validateRequest(analyseMailsSchema), asyncHandler(AssistantController.analyserMails));
// L'enregistrement est lu en entier par la route : pas de JSON ici, le corps est un formulaire.
router.post('/transcription', requireFonction('reunions'), transcriptionLimiter, asyncHandler(AssistantController.transcrire));
export default router;
