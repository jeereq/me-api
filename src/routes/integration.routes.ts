import { Router } from 'express';

import { IntegrationController } from '../controllers/IntegrationController.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { integrationParamsSchema, patchIntegrationSchema, trelloJetonSchema } from '../validators/schemas.js';

const router = Router();
// Routes ouvertes : le navigateur y revient après l'autorisation, le `state` signé identifie le compte.
router.get('/trello/retour', IntegrationController.trelloRetour);
router.post('/trello/jeton', validateRequest(trelloJetonSchema), asyncHandler(IntegrationController.trelloJeton));
router.get('/:nom/callback', asyncHandler(IntegrationController.callback));

router.use(authenticateJWT);
router.get('/', asyncHandler(IntegrationController.liste));
router.get('/:nom/connecter', asyncHandler(IntegrationController.connecter));
router.patch('/:id', validateRequest(patchIntegrationSchema), asyncHandler(IntegrationController.modifier));
router.delete('/:id', validateRequest(integrationParamsSchema), asyncHandler(IntegrationController.supprimer));
export default router;
