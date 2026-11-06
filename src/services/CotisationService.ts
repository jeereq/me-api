import { prisma } from '../utils/prisma.js';
import { Flexpaie, flexpaieConfigure } from './abonnements/flexpaie.js';
import { creerCotisations } from './cotisations/moteur.js';
import { NotificationService } from './NotificationService.js';

/** Anciennes collectes : lecture, suppression, et vérification des paiements déjà partis. */
export const CotisationService = creerCotisations({
  db: prisma,
  flexpaie: Flexpaie,
  flexpaiePret: flexpaieConfigure,
  prevenir: (userId, avis) => NotificationService.avisCompte(userId, avis),
});
