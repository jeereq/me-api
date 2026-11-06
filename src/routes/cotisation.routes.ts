import { Router } from 'express';

import { CotisationController as C } from '../controllers/CotisationController.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { retourPaiementLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { cotisationIdSchema, cotisationMembreIdSchema } from '../validators/schemas.js';

const router = Router();
// Appelée par FlexPaie pour un paiement déjà parti : toujours revérifié auprès d'eux.
router.post('/flexpaie/retour', retourPaiementLimiter, asyncHandler(C.retour));

// Anciennes collectes : plus de création ni de paiement, seulement la lecture et l'effacement des données.
router.use(authenticateJWT);
router.get('/', asyncHandler(C.liste));
router.delete('/membres/:membreId', validateRequest(cotisationMembreIdSchema), asyncHandler(C.retirerMembre));
router.delete('/:id', validateRequest(cotisationIdSchema), asyncHandler(C.supprimer));
export default router;
