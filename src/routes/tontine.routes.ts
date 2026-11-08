import { Router } from 'express';

import { TontineController as C } from '../controllers/TontineController.js';
import { requireFonction } from '../middlewares/abonnement.js';
import { authenticateJWT, requireModule } from '../middlewares/authenticateJWT.js';
import { codeTontineLimiter, confirmerTontineLimiter, envoiCotisationLimiter, invitationTontineLimiter, pageAnnuaireLimiter, payerTontineLimiter, pieceIdentiteLimiter, retourPaiementLimiter, signalementLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { alerteAnnuaireSchema, alerteIdSchema, deciderSignalementSchema, signalerTontineSchema, tontineAdhererSchema, tontineApprobationSchema, tontineCodeSchema, tontineCreerSchema, tontineInvitationSchema, tontineInviterSchema, tontineRejoindreSchema, tontineSmsSchema, tontineUserIdSchema, tontineDecisionSchema, tontineIdSchema, tontineMembreIdSchema, tontineRappelsSchema, tontineReglesSchema, tontineOrdreSchema, tontinePayerSchema, tontinePreuveMembreSchema, tontinePreuveTourSchema } from '../validators/schemas.js';

const router = Router();
// Appelée par FlexPaie : le mouvement est toujours revérifié auprès d'eux.
router.post('/flexpaie/retour', retourPaiementLimiter, asyncHandler(C.retour));
// Lisibles sans compte : l'annuaire public et les limites à respecter.
router.get('/public/annuaire', pageAnnuaireLimiter, asyncHandler(C.annuairePublic));
router.get('/public/annuaire/:id', pageAnnuaireLimiter, validateRequest(tontineIdSchema), asyncHandler(C.groupePublic));
router.get('/limites', pageAnnuaireLimiter, asyncHandler(C.limites));
router.get('/invitation/:code', invitationTontineLimiter, validateRequest(tontineInvitationSchema), asyncHandler(C.invitation));
router.use(authenticateJWT);

router.get('/admin/resume', requireModule('versements'), asyncHandler(C.adminResume));
router.post('/admin/tours/:tourId/verser', requireModule('versements'), validateRequest(tontinePreuveTourSchema), asyncHandler(C.adminVerser));
router.post('/admin/membres/:membreId/rendre', requireModule('versements'), validateRequest(tontinePreuveMembreSchema), asyncHandler(C.adminRendre));

router.get('/admin/approbations', requireModule('verifications'), asyncHandler(C.adminApprobations));
router.get('/admin/approbations/:userId/piece', requireModule('verifications'), validateRequest(tontineUserIdSchema), asyncHandler(C.adminPiece));
router.post('/admin/approbations/:userId', requireModule('verifications'), validateRequest(tontineApprobationSchema), asyncHandler(C.adminDecider));
router.get('/admin/signalements', requireModule('verifications'), asyncHandler(C.adminSignalements));
router.post('/admin/signalements/:id', requireModule('verifications'), validateRequest(deciderSignalementSchema), asyncHandler(C.adminDeciderSignalement));

router.get('/eligibilite', asyncHandler(C.eligibilite));
router.post('/eligibilite/code', requireFonction('cotisations'), codeTontineLimiter, validateRequest(tontineSmsSchema), asyncHandler(C.demanderCode));
router.post('/eligibilite/confirmer', requireFonction('cotisations'), confirmerTontineLimiter, validateRequest(tontineCodeSchema), asyncHandler(C.confirmerCode));
router.post('/eligibilite', requireFonction('cotisations'), pieceIdentiteLimiter, asyncHandler(C.soumettre));
router.post('/invitation/:code', requireFonction('cotisations'), validateRequest(tontineRejoindreSchema), asyncHandler(C.rejoindre));

router.get('/', asyncHandler(C.mesGroupes));
router.get('/annuaire', asyncHandler(C.annuaire));
router.get('/annuaire/:id', validateRequest(tontineIdSchema), asyncHandler(C.groupeAnnuaire));
router.post('/annuaire/:id/signaler', signalementLimiter, validateRequest(signalerTontineSchema), asyncHandler(C.signaler));
router.get('/alertes', asyncHandler(C.mesAlertes));
router.post('/alertes', validateRequest(alerteAnnuaireSchema), asyncHandler(C.creerAlerte));
router.delete('/alertes/:id', validateRequest(alerteIdSchema), asyncHandler(C.supprimerAlerte));
// Créer ou rejoindre un groupe demande au moins Finances. Un membre déjà engagé peut toujours payer : le groupe compte sur lui.
router.post('/', requireFonction('cotisations'), validateRequest(tontineCreerSchema), asyncHandler(C.creer));
router.post('/membres/:membreId/decision', validateRequest(tontineDecisionSchema), asyncHandler(C.decider));
router.post('/membres/:membreId/payer-pour', payerTontineLimiter, validateRequest(tontineMembreIdSchema), asyncHandler(C.payerPour));
router.post('/membres/:membreId/retirer', validateRequest(tontineMembreIdSchema), asyncHandler(C.retirer));
router.post('/membres/:membreId/rappel', envoiCotisationLimiter, validateRequest(tontineMembreIdSchema), asyncHandler(C.rappeler));
router.post('/membres/:membreId/caution', validateRequest(tontineMembreIdSchema), asyncHandler(C.utiliserCaution));
router.post('/membres/:membreId/especes', payerTontineLimiter, validateRequest(tontineMembreIdSchema), asyncHandler(C.noterEspeces));
router.post('/membres/:membreId/exclure', validateRequest(tontineMembreIdSchema), asyncHandler(C.exclure));
router.get('/:id', validateRequest(tontineIdSchema), asyncHandler(C.detail));
router.post('/:id/adherer', requireFonction('cotisations'), validateRequest(tontineAdhererSchema), asyncHandler(C.adherer));
router.post('/:id/inviter', envoiCotisationLimiter, validateRequest(tontineInviterSchema), asyncHandler(C.inviter));
router.post('/:id/rappels', validateRequest(tontineRappelsSchema), asyncHandler(C.reglerRappels));
router.post('/:id/regles', validateRequest(tontineReglesSchema), asyncHandler(C.reglerRegles));
router.post('/:id/ordre', validateRequest(tontineOrdreSchema), asyncHandler(C.ordonner));
router.post('/:id/quitter', validateRequest(tontineIdSchema), asyncHandler(C.quitter));
router.post('/:id/annuler', validateRequest(tontineIdSchema), asyncHandler(C.annuler));
router.post('/:id/demarrer', validateRequest(tontineIdSchema), asyncHandler(C.demarrer));
router.post('/:id/payer', payerTontineLimiter, validateRequest(tontinePayerSchema), asyncHandler(C.payer));
router.post('/:id/abandon', validateRequest(tontineIdSchema), asyncHandler(C.abandonner));
export default router;
