import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';

import type { Formule, Palier } from './abonnements/offres.js';
import { filtrerMembres, finEssaiProlonge, finOfferte, ligneMembre, statsMembres, type FiltreMembres } from './membres/gestion.js';
import { abonnementsActifs, SELECT_ABONNEMENT } from './abonnements/offres.js';
import { StockJustificatifs } from './justificatifs/stock.js';
import { modulesValides } from './membres/modules.js';
import { NotificationService } from './NotificationService.js';

const select = { id: true, email: true, nom: true, role: true, modules: true, createdAt: true } as const;

/** Garde au moins un admin : sans lui, plus personne ne pourrait toucher à la configuration. */
async function assertPasDernierAdmin(id: string) {
  const cible = await prisma.user.findUnique({ where: { id } });
  if (!cible) throw new HttpError(404, 'Compte introuvable.');
  if (cible.role === 'ADMIN' && (await prisma.user.count({ where: { role: 'ADMIN' } })) <= 1) throw new HttpError(400, 'Il faut garder au moins un admin.');
}

const CHAMPS_GESTION = { id: true, email: true, telephone: true, nom: true, photoUrl: true, emailVerifie: true, createdAt: true, approbation: { select: { statut: true } }, ...SELECT_ABONNEMENT } as const;
const PAR_PAGE = 50;
const jourFr = (d: Date) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const nomOffre = (f: Formule, p: Palier) => (f === 'finances' ? 'Finances' : f === 'projets' ? 'Projets' : p ? `Pro ${p}` : 'Pro');

export type ActionAdmin = { action: 'offrir'; formule: Formule; palier: number; mois: number; note?: string } | { action: 'essai'; jours: number; note?: string } | { action: 'retirer'; note?: string };

export const MembreService = {
  list: () => prisma.user.findMany({ select, orderBy: { createdAt: 'asc' } }),

  /** Seul un commercial garde des modules : un admin a tout, un utilisateur rien. */
  async setRole(id: string, role: 'ADMIN' | 'COMMERCIAL' | 'UTILISATEUR', modules?: string[]) {
    if (role !== 'ADMIN') await assertPasDernierAdmin(id);
    return prisma.user.update({ where: { id }, data: { role, modules: role === 'COMMERCIAL' ? modulesValides(modules) : [] }, select });
  },

  async remove(id: string, parId: string) {
    if (id === parId) throw new HttpError(400, 'Tu ne peux pas supprimer ton propre compte ici.');
    await assertPasDernierAdmin(id);
    // Les paiements restent pour la comptabilité, sans le numéro de téléphone.
    await prisma.paiement.updateMany({ where: { userId: id }, data: { telephone: '' } });
    await StockJustificatifs.purgerCompte(id);
    await prisma.user.delete({ where: { id } });
  },

  /** La liste de l'onglet Utilisateurs : un filtre, une recherche, une page, et les chiffres de toute la plateforme. */
  async gestion(filtre: FiltreMembres, q: string, page: number) {
    const [comptes, paiements] = await Promise.all([prisma.user.findMany({ select: CHAMPS_GESTION }), prisma.paiement.findMany({ where: { statut: 'paye' }, select: { montant: true, devise: true, payeLe: true } })]);
    const maintenant = new Date();
    const lignes = comptes.map((c) => ligneMembre(c, maintenant));
    const trouves = filtrerMembres(lignes, filtre, q);
    return { membres: trouves.slice((page - 1) * PAR_PAGE, page * PAR_PAGE), total: trouves.length, page, parPage: PAR_PAGE, stats: statsMembres(lignes, paiements, maintenant), abonnementsActifs: abonnementsActifs() };
  },

  /** La fiche d'un compte : son offre, ses paiements et les gestes de l'admin. Ni l'espace privé, ni le numéro complet. */
  async fiche(id: string) {
    const u = await prisma.user.findUnique({
      where: { id },
      select: {
        ...CHAMPS_GESTION,
        modules: true,
        espace: { select: { majLe: true } },
        paiements: { orderBy: { createdAt: 'desc' }, take: 50, select: { reference: true, formule: true, palier: true, periode: true, montant: true, devise: true, statut: true, payeLe: true, telephone: true, createdAt: true } },
        actionsAbonnement: { orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, parNom: true, action: true, formule: true, palier: true, duree: true, finApres: true, note: true, createdAt: true } },
      },
    });
    if (!u) throw new HttpError(404, 'Compte introuvable.');
    const { paiements, actionsAbonnement, espace } = u;
    return {
      membre: ligneMembre(u),
      modules: u.modules,
      derniereActivite: espace?.majLe ?? null,
      paiements: paiements.map(({ telephone, ...p }) => ({ ...p, telephone: telephone ? `…${telephone.slice(-4)}` : '' })),
      actions: actionsAbonnement,
    };
  },

  /** Offrir une formule, prolonger un essai ou retirer un abonnement. Chaque geste est noté, et le compte est prévenu. */
  async agir(id: string, par: { id: string }, a: ActionAdmin) {
    const u = await prisma.user.findUnique({ where: { id }, select: { id: true, ...SELECT_ABONNEMENT } });
    if (!u) throw new HttpError(404, 'Compte introuvable.');
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: par.id }, select: { nom: true, email: true } });
    const parNom = admin.nom || admin.email || 'Admin';
    const note = a.note || null;
    let journal: { action: string; formule?: string; palier?: number; duree: string | null; finApres: Date | null };
    let avis: { titre: string; corps: string };

    if (a.action === 'offrir') {
      const palier = (a.formule === 'pro' ? a.palier : 0) as Palier;
      const fin = finOfferte(u, a.formule, palier, a.mois);
      const nom = nomOffre(a.formule, palier);
      await prisma.user.update({ where: { id }, data: { abonnementFormule: a.formule, abonnementPalier: palier, abonnementPeriode: a.mois >= 12 ? 'annuel' : 'mensuel', abonnementFinLe: fin } });
      journal = { action: 'offrir', formule: a.formule, palier, duree: `${a.mois} mois`, finApres: fin };
      avis = { titre: `${nom} t'est offert`, corps: `${nom} est ouvert jusqu'au ${jourFr(fin)}. Rien à payer, et rien ne sera prélevé.` };
    } else if (a.action === 'essai') {
      const fin = finEssaiProlonge(u, a.jours);
      await prisma.user.update({ where: { id }, data: { essaiJusqua: fin } });
      journal = { action: 'essai', duree: `${a.jours} jours`, finApres: fin };
      avis = { titre: 'Ton essai est prolongé', corps: `Tu gardes tout Pro jusqu'au ${jourFr(fin)}.` };
    } else {
      if (!u.abonnementFinLe) throw new HttpError(400, 'Ce compte n’a pas d’abonnement à retirer.');
      await prisma.user.update({ where: { id }, data: { abonnementFormule: null, abonnementPalier: 0, abonnementPeriode: null, abonnementFinLe: null } });
      journal = { action: 'retirer', duree: null, finApres: null };
      avis = { titre: 'Ton abonnement a pris fin', corps: 'Ton compte repasse à l’offre gratuite. Tes données restent là.' };
    }

    const act = await prisma.actionAbonnement.create({ data: { userId: id, parNom, note, ...journal } });
    // Le geste est fait : un avis qui échoue ne l'annule pas.
    await NotificationService.avisCompte(id, { cle: `abonnement:admin:${act.id}`, ...avis, parEmail: true }).catch((e) => console.error('Avis abonnement admin', e));
    return this.fiche(id);
  },
};
