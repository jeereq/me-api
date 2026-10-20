import { Router } from 'express';

import { MembreController } from '../controllers/MembreController.js';
import { authenticateJWT, requireAdmin } from '../middlewares/authenticateJWT.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { membreParamsSchema, patchMembreSchema } from '../validators/schemas.js';

const router = Router();
router.use(authenticateJWT, requireAdmin);
router.get('/', asyncHandler(MembreController.list));
router.patch('/:id', validateRequest(patchMembreSchema), asyncHandler(MembreController.setRole));
router.delete('/:id', validateRequest(membreParamsSchema), asyncHandler(MembreController.remove));
export default router;
