import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { SmsController } from '../controllers/SmsController.js';
import { requireFonction } from '../middlewares/abonnement.js';
import { authenticateJWT, requireAdmin } from '../middlewares/authenticateJWT.js';
import { retourSmsLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { numeroAutoriseParamsSchema, numeroAutoriseSchema, smsCodeSchema, smsTelephoneSchema } from '../validators/schemas.js';

const parCompte = (limit: number, windowMs: number, error: string) =>
  rateLimit({ windowMs, limit, keyGenerator: (req) => req.user!.id, standardHeaders: 'draft-7', legacyHeaders: false, message: { error } });

// Chaque code et chaque essai sont un SMS payé.
const limiteCode = parCompte(3, 60 * 60 * 1000, 'Trop de codes demandés. Réessaie dans une heure.');
const limiteControle = parCompte(5, 15 * 60 * 1000, 'Trop d’essais. Réessaie dans 15 minutes.');
const limiteEssai = parCompte(3, 60 * 60 * 1000, 'Trop d’essais. Réessaie dans une heure.');

const router = Router();
// Appelée par aSMSC, avec la clé de SMS_CALLBACK_CLE dans l'adresse.
router.post('/retour', retourSmsLimiter, asyncHandler(SmsController.retour));
router.use(authenticateJWT);
router.get('/', asyncHandler(SmsController.etat));
router.get('/solde', requireAdmin, asyncHandler(SmsController.solde));
router.get('/numeros', requireAdmin, asyncHandler(SmsController.numeros));
router.post('/numeros', requireAdmin, validateRequest(numeroAutoriseSchema), asyncHandler(SmsController.autoriser));
router.delete('/numeros/:id', requireAdmin, validateRequest(numeroAutoriseParamsSchema), asyncHandler(SmsController.retirerAutorisation));
router.post('/telephone', requireFonction('sms'), limiteCode, validateRequest(smsTelephoneSchema), asyncHandler(SmsController.demanderCode));
router.post('/telephone/code', requireFonction('sms'), limiteControle, validateRequest(smsCodeSchema), asyncHandler(SmsController.confirmerCode));
router.delete('/telephone', asyncHandler(SmsController.retirer));
router.post('/test', requireFonction('sms'), limiteEssai, asyncHandler(SmsController.tester));
export default router;
