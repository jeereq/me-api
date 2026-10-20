import { Router } from 'express';

import { AuthController } from '../controllers/AuthController.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { authLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { loginSchema, registerSchema, updateMeSchema } from '../validators/schemas.js';

const router = Router();
router.post('/register', authLimiter, validateRequest(registerSchema), asyncHandler(AuthController.register));
router.post('/login', authLimiter, validateRequest(loginSchema), asyncHandler(AuthController.login));
router.get('/me', authenticateJWT, asyncHandler(AuthController.me));
router.patch('/me', authenticateJWT, validateRequest(updateMeSchema), asyncHandler(AuthController.updateMe));
export default router;
