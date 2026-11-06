import { Router } from 'express';

import { CotisationController as C } from '../controllers/CotisationController.js';
import { requireFonction } from '../middlewares/abonnement.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { envoiCotisationLimiter, pageCotisationLimiter, payerCotisationLimiter, retourPaiementLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { cotisationCreerSchema, cotisationDemandeSchema, cotisationEnvoiSchema, cotisationIdSchema, cotisationJetonSchema, cotisationMarquerSchema, cotisationMembreIdSchema, cotisationMembreModifierSchema, cotisationMembreSchema, cotisationModifierSchema } from '../validators/schemas.js';

const router = Router();
// Ouvertes sans compte : le lien envoyé au membre porte son jeton.
router.get('/public/:jeton', pageCotisationLimiter, validateRequest(cotisationJetonSchema), asyncHandler(C.page));
router.post('/public/:jeton/payer', payerCotisationLimiter, validateRequest(cotisationJetonSchema), asyncHandler(C.payer));
router.post('/public/:jeton/abandon', pageCotisationLimiter, validateRequest(cotisationJetonSchema), asyncHandler(C.abandonner));
// Appelée par FlexPaie : le paiement est toujours revérifié auprès d'eux.
router.post('/flexpaie/retour', retourPaiementLimiter, asyncHandler(C.retour));

router.use(authenticateJWT);
router.get('/', asyncHandler(C.liste));
// Le suivi reste lisible sans abonnement ; créer et modifier font partie de Finances.
router.use(requireFonction('cotisations'));
router.post('/', validateRequest(cotisationCreerSchema), asyncHandler(C.creer));
router.post('/membres/:membreId/demande', validateRequest(cotisationDemandeSchema), asyncHandler(C.demande));
router.post('/membres/:membreId/envoi', envoiCotisationLimiter, validateRequest(cotisationEnvoiSchema), asyncHandler(C.envoyer));
router.post('/membres/:membreId/paye', validateRequest(cotisationMarquerSchema), asyncHandler(C.marquer));
router.patch('/membres/:membreId', validateRequest(cotisationMembreModifierSchema), asyncHandler(C.modifierMembre));
router.delete('/membres/:membreId', validateRequest(cotisationMembreIdSchema), asyncHandler(C.retirerMembre));
router.patch('/:id', validateRequest(cotisationModifierSchema), asyncHandler(C.modifier));
router.delete('/:id', validateRequest(cotisationIdSchema), asyncHandler(C.supprimer));
router.post('/:id/membres', validateRequest(cotisationMembreSchema), asyncHandler(C.ajouterMembre));
export default router;
