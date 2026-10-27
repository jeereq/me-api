import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { IntegrationController } from '../controllers/IntegrationController.js';
import { requirePro } from '../middlewares/abonnement.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { asyncHandler } from '../utils/http.js';

// Synchro à la demande : 10 par 10 min et par compte (le serveur synchronise déjà tout seul toutes les 15 min).
const limite = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, keyGenerator: (req) => req.user!.id, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Synchronisation déjà faite il y a peu, réessaie dans quelques minutes.' } });

const router = Router();
router.use(authenticateJWT);
router.get('/', asyncHandler(IntegrationController.elements));
router.post('/', requirePro('integrations'), limite, asyncHandler(IntegrationController.synchroniser));
export default router;
