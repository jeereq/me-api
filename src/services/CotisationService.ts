import { prisma } from '../utils/prisma.js';
import { Flexpaie, flexpaieConfigure } from './abonnements/flexpaie.js';
import { adresseApp } from './comptes/emails.js';
import { canauxSysteme, Envois } from './cotisations/envois.js';
import { creerCotisations } from './cotisations/moteur.js';
import { NotificationService } from './NotificationService.js';
import { NumerosAutorises } from './sms/numeros.js';

/** Fermé tant que l'encaissement pour le compte de tiers n'est pas confirmé avec FlexPaie. */
const enLigne = () => process.env.COTISATIONS_PAIEMENT === 'true' && flexpaieConfigure();

export const CotisationService = creerCotisations({
  db: prisma,
  flexpaie: Flexpaie,
  enLigne,
  flexpaiePret: flexpaieConfigure,
  adresseServeur: () => (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  adresseApp,
  exigerNumero: (telephone) => NumerosAutorises.exiger(telephone),
  prevenir: (userId, avis) => NotificationService.avisCompte(userId, avis),
  envoyer: (userId, c) => Envois.collecte(userId, c),
  canaux: canauxSysteme,
});
