import { Router } from 'express';

import { contactLimiter } from '../middlewares/rateLimits.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { adresseContact, emailContact } from '../services/contact.js';
import { EmailService } from '../services/EmailService.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { contactSchema } from '../validators/schemas.js';

/** Le formulaire de contact de la page d'accueil, ouvert sans compte. Le message part par email et n'est pas gardé. */
const router = Router();
router.post(
  '/',
  contactLimiter,
  validateRequest(contactSchema),
  asyncHandler(async (req, res) => {
    const { site, nom, email, telephone, message } = req.body;
    // Le champ `site` est invisible : seul un robot le remplit. Il croit avoir réussi.
    if (site) return void res.json({ ok: true });
    if (!EmailService.configure()) throw new HttpError(503, 'Le formulaire n’est pas disponible pour le moment.');
    const m = emailContact({ nom, email, telephone, message });
    if (!(await EmailService.envoyer(adresseContact(), m.sujet, m.texte, m.html, email))) throw new HttpError(502, 'Le message n’a pas pu partir. Réessaie dans un moment.');
    res.json({ ok: true });
  }),
);
export default router;
