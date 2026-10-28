import { Router } from 'express';

import { JustificatifController } from '../controllers/JustificatifController.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { justificatifLimiter } from '../middlewares/rateLimits.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();
router.use(authenticateJWT);
router.get('/', asyncHandler(JustificatifController.etat));
router.post('/', justificatifLimiter, asyncHandler(JustificatifController.deposer));
export default router;
