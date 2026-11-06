import { prisma } from '../utils/prisma.js';
import { Flexpaie, flexpaieConfigure } from './abonnements/flexpaie.js';
import { adresseApp } from './comptes/emails.js';
import { creerApprobations } from './cotisations/approbations.js';
import { Envois } from './cotisations/envois.js';
import { creerTontines } from './cotisations/tontines.js';
import { NumerosAutorises } from './sms/numeros.js';

/** Fermé tant que l'avis juridique et l'accord de FlexPaie ne sont pas obtenus. « admins » sert à tester sur de petits montants. */
const paiementOuvert = (role: string | null) => {
  const v = process.env.TONTINES_PAIEMENT;
  if (!flexpaieConfigure()) return false;
  return v === 'true' || (v === 'admins' && role === 'ADMIN');
};

export const ApprobationService = creerApprobations({
  db: prisma,
  avertir: (userId, telephone, avis) => Envois.avertir(userId, telephone, avis),
});

export const TontineService = creerTontines({
  db: prisma,
  flexpaie: Flexpaie,
  paiementOuvert,
  versementApi: () => process.env.TONTINES_VERSEMENT_API === 'true' && flexpaieConfigure(),
  flexpaiePret: flexpaieConfigure,
  adresseServeur: () => (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  exigerNumero: (telephone) => NumerosAutorises.exiger(telephone),
  avertir: (userId, telephone, avis, seulementApp) => Envois.avertir(userId, telephone, avis, seulementApp),
  comptesApprouves: (ids) => ApprobationService.comptesApprouves(ids),
  adresseApp,
  envoyerInvitation: (userId, c) => Envois.collecte(userId, c),
});
