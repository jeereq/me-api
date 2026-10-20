import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { NotificationController } from '../controllers/NotificationController.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { notificationsLuesSchema, pushAbonnementSchema, pushDesabonnementSchema } from '../validators/schemas.js';

// Essai : 5 emails par heure et par compte au plus.
const limiteEssai = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, keyGenerator: (req) => req.user!.id, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Déjà plusieurs essais, réessaie plus tard.' } });

const router = Router();
router.use(authenticateJWT);
router.get('/', asyncHandler(NotificationController.liste));
router.post('/lues', validateRequest(notificationsLuesSchema), asyncHandler(NotificationController.lues));
router.get('/push', asyncHandler(NotificationController.cle));
router.post('/push', validateRequest(pushAbonnementSchema), asyncHandler(NotificationController.abonner));
router.delete('/push', validateRequest(pushDesabonnementSchema), asyncHandler(NotificationController.desabonner));
router.post('/test', limiteEssai, asyncHandler(NotificationController.tester));
export default router;
