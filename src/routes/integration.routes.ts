import { Router } from 'express';

import { IntegrationController } from '../controllers/IntegrationController.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { creerEvenementSchema, creerTacheSchema, envoyerMailSchema, integrationParamsSchema, lireMailSchema, majTacheSchema, modifierEvenementSchema, patchIntegrationSchema, repondreMailSchema, supprimerEvenementSchema, trelloJetonSchema } from '../validators/schemas.js';

const router = Router();
// Routes ouvertes : le navigateur y revient après l'autorisation, le `state` signé identifie le compte.
router.get('/trello/retour', IntegrationController.trelloRetour);
router.post('/trello/jeton', validateRequest(trelloJetonSchema), asyncHandler(IntegrationController.trelloJeton));
router.get('/:nom/callback', asyncHandler(IntegrationController.callback));

router.use(authenticateJWT);
router.get('/', asyncHandler(IntegrationController.liste));
router.get('/:nom/connecter', asyncHandler(IntegrationController.connecter));
router.get('/:id/agendas', validateRequest(integrationParamsSchema), asyncHandler(IntegrationController.agendas));
router.patch('/:id', validateRequest(patchIntegrationSchema), asyncHandler(IntegrationController.modifier));
// Lire un mail en entier, à la demande.
router.get('/:id/mails/:mail', validateRequest(lireMailSchema), asyncHandler(IntegrationController.lireMail));
// Écriture dans le compte connecté (répondre, écrire, tenir l'agenda et les tâches).
router.post('/:id/repondre', validateRequest(repondreMailSchema), asyncHandler(IntegrationController.repondre));
router.post('/:id/envoyer', validateRequest(envoyerMailSchema), asyncHandler(IntegrationController.envoyer));
router.post('/:id/agenda', validateRequest(creerEvenementSchema), asyncHandler(IntegrationController.creerEvenement));
router.patch('/:id/agenda', validateRequest(modifierEvenementSchema), asyncHandler(IntegrationController.modifierEvenement));
router.post('/:id/agenda/supprimer', validateRequest(supprimerEvenementSchema), asyncHandler(IntegrationController.supprimerEvenement));
router.get('/:id/listes', validateRequest(integrationParamsSchema), asyncHandler(IntegrationController.listesTaches));
router.post('/:id/taches', validateRequest(creerTacheSchema), asyncHandler(IntegrationController.creerTache));
router.patch('/:id/taches', validateRequest(majTacheSchema), asyncHandler(IntegrationController.majTache));
router.delete('/:id', validateRequest(integrationParamsSchema), asyncHandler(IntegrationController.supprimer));
export default router;
