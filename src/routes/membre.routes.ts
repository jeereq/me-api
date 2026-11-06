import { Router } from 'express';

import { MembreController } from '../controllers/MembreController.js';
import { authenticateJWT, requireAdmin, requireModule } from '../middlewares/authenticateJWT.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { actionAbonnementSchema, gestionMembresSchema, membreParamsSchema, patchMembreSchema } from '../validators/schemas.js';

const router = Router();
router.use(authenticateJWT);
router.get('/', requireAdmin, asyncHandler(MembreController.list));
router.get('/gestion', requireModule('comptes'), validateRequest(gestionMembresSchema), asyncHandler(MembreController.gestion));
router.get('/:id/fiche', requireModule('comptes'), validateRequest(membreParamsSchema), asyncHandler(MembreController.fiche));
router.post('/:id/abonnement', requireModule('offres'), validateRequest(actionAbonnementSchema), asyncHandler(MembreController.agir));
router.patch('/:id', requireAdmin, validateRequest(patchMembreSchema), asyncHandler(MembreController.setRole));
router.delete('/:id', requireAdmin, validateRequest(membreParamsSchema), asyncHandler(MembreController.remove));
export default router;
