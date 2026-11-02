import { Router } from 'express';

import { JustificatifController } from '../controllers/JustificatifController.js';
import { requireFonction } from '../middlewares/abonnement.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { justificatifLimiter } from '../middlewares/rateLimits.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();
router.use(authenticateJWT);
router.get('/', asyncHandler(JustificatifController.etat));
// Joindre un reçu fait partie de Finances : les reçus déjà joints restent visibles sans abonnement.
router.post('/', requireFonction('justificatifs'), justificatifLimiter, asyncHandler(JustificatifController.deposer));
export default router;
