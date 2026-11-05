import { Router } from 'express';

import { AssistantController } from '../controllers/AssistantController.js';
import { requireFonction, requirePro } from '../middlewares/abonnement.js';
import { authenticateJWT, requireAdmin } from '../middlewares/authenticateJWT.js';
import { analyseMailsLimiter, assistantLimiter, transcriptionLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { redigerMailSchema, relireNouveauSchema, ajusterReponseSchema, proposerEtiquettesSchema, analyseBoucleSchema, etatsAnalyseSchema, relireReponseSchema, traduireSchema, analyseMailsSchema, assistantSchema } from '../validators/schemas.js';

const router = Router();
router.use(authenticateJWT);
router.get('/', asyncHandler(AssistantController.status));
router.get('/modeles', requireAdmin, asyncHandler(AssistantController.modeles));
router.post('/', requirePro('assistant'), assistantLimiter, validateRequest(assistantSchema), asyncHandler(AssistantController.demander));
router.post('/traduire', requirePro('assistant'), analyseMailsLimiter, validateRequest(traduireSchema), asyncHandler(AssistantController.traduire));
router.post('/mails/etiquettes', requirePro('assistant'), analyseMailsLimiter, validateRequest(proposerEtiquettesSchema), asyncHandler(AssistantController.proposerEtiquettes));
router.post('/mails/ajuster', requirePro('assistant'), analyseMailsLimiter, validateRequest(ajusterReponseSchema), asyncHandler(AssistantController.ajusterReponse));
router.post('/mails/etats', requirePro('assistant'), validateRequest(etatsAnalyseSchema), asyncHandler(AssistantController.etatsAnalyse));
router.post('/mails/rediger', requirePro('assistant'), analyseMailsLimiter, validateRequest(redigerMailSchema), asyncHandler(AssistantController.redigerMail));
router.post('/mails/relire-nouveau', requirePro('assistant'), analyseMailsLimiter, validateRequest(relireNouveauSchema), asyncHandler(AssistantController.relireNouveau));
router.post('/mails/relire', requirePro('assistant'), analyseMailsLimiter, validateRequest(relireReponseSchema), asyncHandler(AssistantController.relireReponse));
router.post('/mails/boucle', requirePro('assistant'), analyseMailsLimiter, validateRequest(analyseBoucleSchema), asyncHandler(AssistantController.analyserBoucle));
router.post('/mails', requirePro('assistant'), analyseMailsLimiter, validateRequest(analyseMailsSchema), asyncHandler(AssistantController.analyserMails));
// L'enregistrement est lu en entier par la route : pas de JSON ici, le corps est un formulaire.
router.post('/transcription', requireFonction('reunions'), transcriptionLimiter, asyncHandler(AssistantController.transcrire));
export default router;
