import { Router } from 'express';

import { EquipeController } from '../controllers/EquipeController.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import {
  creerEquipeSchema,
  equipeMembreParamsSchema,
  equipeParamsSchema,
  invitationParamsSchema,
  inviterEquipeSchema,
  jetonInvitationSchema,
  patchEquipeSchema,
  putEspaceEquipeSchema,
  roleMembreSchema,
} from '../validators/schemas.js';

const router = Router();
router.use(authenticateJWT);

router.get('/', asyncHandler(EquipeController.list));
router.post('/', validateRequest(creerEquipeSchema), asyncHandler(EquipeController.creer));

// Les invitations se consultent et s'acceptent avec le jeton reçu par email, sans être encore membre.
router.post('/invitation/apercu', validateRequest(jetonInvitationSchema), asyncHandler(EquipeController.apercuInvitation));
router.post('/invitation/rejoindre', validateRequest(jetonInvitationSchema), asyncHandler(EquipeController.rejoindre));

router.patch('/:id', validateRequest(patchEquipeSchema), asyncHandler(EquipeController.renommer));
router.delete('/:id', validateRequest(equipeParamsSchema), asyncHandler(EquipeController.supprimer));

router.post('/:id/invitations', validateRequest(inviterEquipeSchema), asyncHandler(EquipeController.inviter));
router.delete('/:id/invitations/:invitationId', validateRequest(invitationParamsSchema), asyncHandler(EquipeController.annulerInvitation));

router.patch('/:id/membres/:membreId', validateRequest(roleMembreSchema), asyncHandler(EquipeController.changerRole));
router.delete('/:id/membres/:membreId', validateRequest(equipeMembreParamsSchema), asyncHandler(EquipeController.retirer));

router.get('/:id/espace', validateRequest(equipeParamsSchema), asyncHandler(EquipeController.getEspace));
router.put('/:id/espace', validateRequest(putEspaceEquipeSchema), asyncHandler(EquipeController.putEspace));

export default router;
