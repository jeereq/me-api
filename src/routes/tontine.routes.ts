import { Router } from 'express';

import { TontineController as C } from '../controllers/TontineController.js';
import { requireFonction } from '../middlewares/abonnement.js';
import { authenticateJWT, requireAdmin } from '../middlewares/authenticateJWT.js';
import { codeTontineLimiter, confirmerTontineLimiter, envoiCotisationLimiter, invitationTontineLimiter, payerTontineLimiter, pieceIdentiteLimiter, retourPaiementLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { tontineAdhererSchema, tontineApprobationSchema, tontineCodeSchema, tontineCreerSchema, tontineInvitationSchema, tontineInviterSchema, tontineRejoindreSchema, tontineSmsSchema, tontineUserIdSchema, tontineDecisionSchema, tontineIdSchema, tontineMembreIdSchema, tontineRappelsSchema, tontinePayerSchema, tontinePreuveMembreSchema, tontinePreuveTourSchema } from '../validators/schemas.js';

const router = Router();
// Appelée par FlexPaie : le mouvement est toujours revérifié auprès d'eux.
router.post('/flexpaie/retour', retourPaiementLimiter, asyncHandler(C.retour));
router.get('/invitation/:code', invitationTontineLimiter, validateRequest(tontineInvitationSchema), asyncHandler(C.invitation));
router.use(authenticateJWT);

router.get('/admin/resume', requireAdmin, asyncHandler(C.adminResume));
router.post('/admin/tours/:tourId/verser', requireAdmin, validateRequest(tontinePreuveTourSchema), asyncHandler(C.adminVerser));
router.post('/admin/membres/:membreId/rendre', requireAdmin, validateRequest(tontinePreuveMembreSchema), asyncHandler(C.adminRendre));

router.get('/admin/approbations', requireAdmin, asyncHandler(C.adminApprobations));
router.get('/admin/approbations/:userId/piece', requireAdmin, validateRequest(tontineUserIdSchema), asyncHandler(C.adminPiece));
router.post('/admin/approbations/:userId', requireAdmin, validateRequest(tontineApprobationSchema), asyncHandler(C.adminDecider));

router.get('/eligibilite', asyncHandler(C.eligibilite));
router.post('/eligibilite/code', requireFonction('cotisations'), codeTontineLimiter, validateRequest(tontineSmsSchema), asyncHandler(C.demanderCode));
router.post('/eligibilite/confirmer', requireFonction('cotisations'), confirmerTontineLimiter, validateRequest(tontineCodeSchema), asyncHandler(C.confirmerCode));
router.post('/eligibilite', requireFonction('cotisations'), pieceIdentiteLimiter, asyncHandler(C.soumettre));
router.post('/invitation/:code', requireFonction('cotisations'), validateRequest(tontineRejoindreSchema), asyncHandler(C.rejoindre));

router.get('/', asyncHandler(C.mesGroupes));
router.get('/annuaire', asyncHandler(C.annuaire));
// Créer ou rejoindre un groupe demande au moins Finances. Un membre déjà engagé peut toujours payer : le groupe compte sur lui.
router.post('/', requireFonction('cotisations'), validateRequest(tontineCreerSchema), asyncHandler(C.creer));
router.post('/membres/:membreId/decision', validateRequest(tontineDecisionSchema), asyncHandler(C.decider));
router.post('/membres/:membreId/payer-pour', payerTontineLimiter, validateRequest(tontineMembreIdSchema), asyncHandler(C.payerPour));
router.post('/membres/:membreId/retirer', validateRequest(tontineMembreIdSchema), asyncHandler(C.retirer));
router.post('/membres/:membreId/rappel', envoiCotisationLimiter, validateRequest(tontineMembreIdSchema), asyncHandler(C.rappeler));
router.post('/membres/:membreId/caution', validateRequest(tontineMembreIdSchema), asyncHandler(C.utiliserCaution));
router.get('/:id', validateRequest(tontineIdSchema), asyncHandler(C.detail));
router.post('/:id/adherer', requireFonction('cotisations'), validateRequest(tontineAdhererSchema), asyncHandler(C.adherer));
router.post('/:id/inviter', envoiCotisationLimiter, validateRequest(tontineInviterSchema), asyncHandler(C.inviter));
router.post('/:id/rappels', validateRequest(tontineRappelsSchema), asyncHandler(C.reglerRappels));
router.post('/:id/quitter', validateRequest(tontineIdSchema), asyncHandler(C.quitter));
router.post('/:id/annuler', validateRequest(tontineIdSchema), asyncHandler(C.annuler));
router.post('/:id/demarrer', validateRequest(tontineIdSchema), asyncHandler(C.demarrer));
router.post('/:id/payer', payerTontineLimiter, validateRequest(tontinePayerSchema), asyncHandler(C.payer));
router.post('/:id/abandon', validateRequest(tontineIdSchema), asyncHandler(C.abandonner));
export default router;
