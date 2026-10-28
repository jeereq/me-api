import { Router } from 'express';

import { EspaceController } from '../controllers/EspaceController.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { patchEspaceSchema, putEspaceSchema } from '../validators/schemas.js';

const router = Router();
router.use(authenticateJWT);
router.get('/', asyncHandler(EspaceController.get));
router.put('/', validateRequest(putEspaceSchema), asyncHandler(EspaceController.put));
router.patch('/', validateRequest(patchEspaceSchema), asyncHandler(EspaceController.patch));
export default router;
