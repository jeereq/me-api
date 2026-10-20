import { Router } from 'express';

import { AuthController } from '../controllers/AuthController.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { authLimiter, mailLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { codeSchema, emailSchema, jetonSchema, loginSchema, registerSchema, reinitialiserSchema, supprimerCompteSchema, updateMeSchema } from '../validators/schemas.js';

const router = Router();
router.get('/options', asyncHandler(AuthController.options));
router.post('/register', authLimiter, validateRequest(registerSchema), asyncHandler(AuthController.register));
router.post('/login', authLimiter, validateRequest(loginSchema), asyncHandler(AuthController.login));
router.post('/verifier', authLimiter, validateRequest(jetonSchema), asyncHandler(AuthController.verifier));
router.post('/verifier/renvoyer', mailLimiter, validateRequest(emailSchema), asyncHandler(AuthController.renvoyerVerification));
router.post('/oubli', mailLimiter, validateRequest(emailSchema), asyncHandler(AuthController.oubli));
router.post('/reinitialiser', authLimiter, validateRequest(reinitialiserSchema), asyncHandler(AuthController.reinitialiser));
router.get('/google/debut', asyncHandler(AuthController.googleDebut));
router.get('/google/callback', asyncHandler(AuthController.googleCallback));
router.post('/google/echange', authLimiter, validateRequest(codeSchema), asyncHandler(AuthController.googleEchange));
router.get('/me', authenticateJWT, asyncHandler(AuthController.me));
router.patch('/me', authenticateJWT, validateRequest(updateMeSchema), asyncHandler(AuthController.updateMe));
router.delete('/me', authenticateJWT, validateRequest(supprimerCompteSchema), asyncHandler(AuthController.supprimer));
export default router;
