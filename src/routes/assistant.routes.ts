import { Router } from 'express';

import { AssistantController } from '../controllers/AssistantController.js';
import { requirePro } from '../middlewares/abonnement.js';
import { authenticateJWT, requireAdmin } from '../middlewares/authenticateJWT.js';
import { assistantLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { assistantSchema } from '../validators/schemas.js';

const router = Router();
router.use(authenticateJWT);
router.get('/', asyncHandler(AssistantController.status));
router.get('/modeles', requireAdmin, asyncHandler(AssistantController.modeles));
router.post('/', requirePro('assistant'), assistantLimiter, validateRequest(assistantSchema), asyncHandler(AssistantController.demander));
export default router;
