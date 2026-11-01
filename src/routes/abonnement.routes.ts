import { Router } from 'express';

import { AbonnementController } from '../controllers/AbonnementController.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { retourPaiementLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { paiementSchema, referencePaiementSchema } from '../validators/schemas.js';

const router = Router();
router.get('/offres', asyncHandler(AbonnementController.offres));
// Appelée par FlexPaie : le paiement est toujours revérifié auprès d'eux, rien n'est cru sur parole.
router.post('/flexpaie/retour', retourPaiementLimiter, asyncHandler(AbonnementController.retour));
router.use(authenticateJWT);
router.get('/', asyncHandler(AbonnementController.etat));
router.post('/paiement', validateRequest(paiementSchema), asyncHandler(AbonnementController.payer));
router.get('/paiements/:reference', validateRequest(referencePaiementSchema), asyncHandler(AbonnementController.suivre));
router.post('/paiements/:reference/abandon', validateRequest(referencePaiementSchema), asyncHandler(AbonnementController.abandonner));
export default router;
