import { Router } from 'express';

import { MembreController } from '../controllers/MembreController.js';
import { authenticateJWT, requireAdmin } from '../middlewares/authenticateJWT.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { actionAbonnementSchema, gestionMembresSchema, membreParamsSchema, patchMembreSchema } from '../validators/schemas.js';

const router = Router();
router.use(authenticateJWT, requireAdmin);
router.get('/', asyncHandler(MembreController.list));
router.get('/gestion', validateRequest(gestionMembresSchema), asyncHandler(MembreController.gestion));
router.get('/:id/fiche', validateRequest(membreParamsSchema), asyncHandler(MembreController.fiche));
router.post('/:id/abonnement', validateRequest(actionAbonnementSchema), asyncHandler(MembreController.agir));
router.patch('/:id', validateRequest(patchMembreSchema), asyncHandler(MembreController.setRole));
router.delete('/:id', validateRequest(membreParamsSchema), asyncHandler(MembreController.remove));
export default router;
