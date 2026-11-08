import { limitesDe, reglesPlateformeDe } from '../commun/cotisations.js';
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
  avertir: (userId, telephone, avis, mode) => Envois.avertir(userId, telephone, avis, mode),
  comptesApprouves: (ids) => ApprobationService.comptesApprouves(ids),
  adresseApp,
  limites: async () => {
    const c = await prisma.config.findUnique({ where: { id: 1 } });
    return limitesDe((c?.data as { limitesCotisations?: unknown } | null)?.limitesCotisations);
  },
  envoyerInvitation: (userId, c) => Envois.invitation(userId, c),
  reglesPlateforme: async () => {
    const c = await prisma.config.findUnique({ where: { id: 1 } });
    return reglesPlateformeDe((c?.data as { reglesPlateforme?: unknown } | null)?.reglesPlateforme);
  },
  // Ceux qui valident les versements : les admins, et les commerciaux qui ont le module « versements ».
  responsablesVersements: async () =>
    (await prisma.user.findMany({ where: { OR: [{ role: 'ADMIN' }, { role: 'COMMERCIAL', modules: { has: 'versements' } }] }, select: { id: true } })).map((u) => u.id),
});
