import { Router } from 'express';

import { ConfigController } from '../controllers/ConfigController.js';
import { authenticateJWT, requireAdmin } from '../middlewares/authenticateJWT.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { putConfigSchema } from '../validators/schemas.js';

const router = Router();
router.use(authenticateJWT);
router.get('/', asyncHandler(ConfigController.get));
router.put('/', requireAdmin, validateRequest(putConfigSchema), asyncHandler(ConfigController.put));
export default router;
