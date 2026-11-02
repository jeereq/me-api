import { Router } from 'express';

import { JustificatifController } from '../controllers/JustificatifController.js';
import { requireFonction } from '../middlewares/abonnement.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { analyseJustificatifLimiter, justificatifLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { analyseJustificatifSchema } from '../validators/schemas.js';

const router = Router();
router.use(authenticateJWT);
router.get('/', asyncHandler(JustificatifController.etat));
// Joindre un reçu fait partie de Finances : les reçus déjà joints restent visibles sans abonnement.
router.post('/', requireFonction('justificatifs'), justificatifLimiter, asyncHandler(JustificatifController.deposer));
// La lecture par l'IA coûte au serveur : elle suit le copilote (Pro, essai compris).
router.post('/analyse', requireFonction('assistant'), analyseJustificatifLimiter, validateRequest(analyseJustificatifSchema), asyncHandler(JustificatifController.analyser));
export default router;
