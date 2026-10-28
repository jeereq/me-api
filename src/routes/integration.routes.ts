import { Router } from 'express';

import { IntegrationController } from '../controllers/IntegrationController.js';
import { requirePro } from '../middlewares/abonnement.js';
import { authenticateJWT } from '../middlewares/authenticateJWT.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { asyncHandler } from '../utils/http.js';
import { creerEvenementSchema, activerRegleSchema, creerTacheSchema, deplacerMailSchema, dossiersSchema, envoyerMailSchema, etiqueterMailSchema, filMailSchema, mailsDossierSchema, integrationParamsSchema, lireMailQuerySchema, majTacheSchema, modifierEvenementSchema, patchIntegrationSchema, repondreMailSchema, supprimerEvenementSchema, trelloJetonSchema } from '../validators/schemas.js';

const router = Router();
// Routes ouvertes : le navigateur y revient après l'autorisation, le `state` signé identifie le compte.
router.get('/trello/retour', IntegrationController.trelloRetour);
router.post('/trello/jeton', validateRequest(trelloJetonSchema), asyncHandler(IntegrationController.trelloJeton));
router.get('/:nom/callback', asyncHandler(IntegrationController.callback));

router.use(authenticateJWT);
router.get('/', asyncHandler(IntegrationController.liste));
// Sans Pro, on peut encore voir et déconnecter ses comptes, mais plus en connecter ni s'en servir.
router.delete('/:id', validateRequest(integrationParamsSchema), asyncHandler(IntegrationController.supprimer));
router.use(asyncHandler(requirePro('integrations')));
router.get('/:nom/connecter', asyncHandler(IntegrationController.connecter));
router.get('/:id/agendas', validateRequest(integrationParamsSchema), asyncHandler(IntegrationController.agendas));
router.patch('/:id', validateRequest(patchIntegrationSchema), asyncHandler(IntegrationController.modifier));
// Lire un mail en entier, à la demande.
router.get('/:id/mails/:mail', validateRequest(lireMailQuerySchema), asyncHandler(IntegrationController.lireMail));
// Poser ou retirer des étiquettes (libellés Gmail, catégories Outlook).
// L'environnement de la boîte : dossiers, mails d'un dossier page par page, ranger un mail, règles.
router.get('/:id/dossiers', validateRequest(dossiersSchema), asyncHandler(IntegrationController.dossiers));
router.get('/:id/dossiers/:dossier/mails', validateRequest(mailsDossierSchema), asyncHandler(IntegrationController.mailsDuDossier));
// Le mail d'origine d'une relance ou d'une tâche, retrouvé par son fil.
router.get('/:id/fils/:fil', validateRequest(filMailSchema), asyncHandler(IntegrationController.mailDuFil));
router.post('/:id/mails/:mail/deplacer', validateRequest(deplacerMailSchema), asyncHandler(IntegrationController.deplacer));
router.get('/:id/regles', validateRequest(integrationParamsSchema), asyncHandler(IntegrationController.regles));
router.patch('/:id/regles/:regle', validateRequest(activerRegleSchema), asyncHandler(IntegrationController.activerRegle));
router.post('/:id/mails/:mail/libelles', validateRequest(etiqueterMailSchema), asyncHandler(IntegrationController.etiqueter));
// Écriture dans le compte connecté (répondre, écrire, tenir l'agenda et les tâches).
router.post('/:id/repondre', validateRequest(repondreMailSchema), asyncHandler(IntegrationController.repondre));
router.post('/:id/envoyer', validateRequest(envoyerMailSchema), asyncHandler(IntegrationController.envoyer));
router.post('/:id/agenda', validateRequest(creerEvenementSchema), asyncHandler(IntegrationController.creerEvenement));
router.patch('/:id/agenda', validateRequest(modifierEvenementSchema), asyncHandler(IntegrationController.modifierEvenement));
router.post('/:id/agenda/supprimer', validateRequest(supprimerEvenementSchema), asyncHandler(IntegrationController.supprimerEvenement));
router.get('/:id/listes', validateRequest(integrationParamsSchema), asyncHandler(IntegrationController.listesTaches));
router.post('/:id/taches', validateRequest(creerTacheSchema), asyncHandler(IntegrationController.creerTache));
router.patch('/:id/taches', validateRequest(majTacheSchema), asyncHandler(IntegrationController.majTache));
export default router;
