import { Router } from 'express';

import { JustificatifController } from '../controllers/JustificatifController.js';
import { requireFonction } from '../middlewares/abonnement.js';
import { authenticateJWT, requireAdmin } from '../middlewares/authenticateJWT.js';
import { analyseJustificatifLimiter, justificatifLimiter, liensJustificatifsLimiter, ouvrirJustificatifLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { analyseJustificatifSchema, liensJustificatifsSchema } from '../validators/schemas.js';

const router = Router();
// Le lien porte son propre jeton : une image ne peut pas envoyer d'en-tête d'authentification.
router.get('/ouvrir', ouvrirJustificatifLimiter, asyncHandler(JustificatifController.ouvrir));
router.use(authenticateJWT);
router.get('/', asyncHandler(JustificatifController.etat));
// Admin : tout le chemin d'un fichier, jusqu'à un dépôt d'essai chez Cloudinary.
router.get('/diagnostic', requireAdmin, asyncHandler(JustificatifController.diagnostic));
router.post('/liens', liensJustificatifsLimiter, validateRequest(liensJustificatifsSchema), asyncHandler(JustificatifController.liens));
// Joindre un reçu fait partie de Finances : les reçus déjà joints restent visibles sans abonnement.
router.post('/', requireFonction('justificatifs'), justificatifLimiter, asyncHandler(JustificatifController.deposer));
// La lecture par l'IA coûte au serveur : elle suit le copilote (Pro, essai compris).
router.post('/analyse', requireFonction('assistant'), analyseJustificatifLimiter, validateRequest(analyseJustificatifSchema), asyncHandler(JustificatifController.analyser));
export default router;
