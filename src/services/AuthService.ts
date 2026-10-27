import bcrypt from 'bcryptjs';

import type { Prisma } from '@prisma/client';

import { dechiffrer } from '../utils/crypto.js';
import { etatAbonnement, finEssai, type ChampsAbonnement } from './abonnements/offres.js';
import { HttpError } from '../utils/http.js';
import { generateToken } from '../utils/jwt.js';
import { prisma } from '../utils/prisma.js';
import { EmailsCompte, emailsActifs } from './comptes/emails.js';
import { ConnexionGoogle, type ProfilGoogle } from './comptes/google.js';
import { JetonService } from './comptes/JetonService.js';

type Compte = { id: string; email: string; nom: string; role: 'ADMIN' | 'UTILISATEUR'; passwordHash?: string | null; googleId?: string | null } & ChampsAbonnement;

const publicUser = (u: Compte) => ({ id: u.id, email: u.email, nom: u.nom, role: u.role, motDePasse: u.passwordHash !== null, google: !!u.googleId, abonnement: etatAbonnement(u) });
const session = (u: Compte) => ({ token: generateToken({ userId: u.id }), user: publicUser(u) });
// Les jetons de session ont une précision à la seconde : on tronque pour que la session ouverte juste après reste valable.
const maintenant = () => new Date(Math.floor(Date.now() / 1000) * 1000);

/** Crée un compte (inscription ou premier passage par Google) en respectant SIGNUP_OPEN et la règle du premier admin. */
function creerCompte(data: Omit<Prisma.UserCreateInput, 'role'>) {
  // Transaction sérialisable : deux inscriptions simultanées ne peuvent pas créer deux « premiers » admins.
  return prisma.$transaction(
    async (tx) => {
      const count = await tx.user.count();
      if (count > 0 && process.env.SIGNUP_OPEN === 'false') throw new HttpError(403, "Les inscriptions sont fermées. Demande à l'admin.");
      if (await tx.user.findUnique({ where: { email: data.email } })) throw new HttpError(409, 'Un compte existe déjà avec cet email.');
      // Chaque nouveau compte commence par l'essai Pro.
      return tx.user.create({ data: { ...data, essaiJusqua: finEssai(), role: count === 0 && !process.env.ADMIN_EMAIL ? 'ADMIN' : 'UTILISATEUR' } });
    },
    { isolationLevel: 'Serializable' },
  );
}

async function envoyerVerification(user: { id: string; email: string }) {
  const jeton = await JetonService.creer(user.id, 'VERIFICATION', 24 * 60);
  if (!(await EmailsCompte.verification(user.email, jeton))) throw new HttpError(503, "L'email de confirmation n'a pas pu partir. Réessaie dans un moment.");
}

export const AuthService = {
  /** Ce que l'écran de connexion peut proposer. */
  options: () => ({ google: ConnexionGoogle.configure(), email: emailsActifs() }),

  /**
   * Inscription. Si les emails de compte sont configurés, le compte attend la confirmation de l'adresse
   * avant la première connexion ; sinon il est utilisable tout de suite.
   */
  async register(email: string, password: string, nom = '') {
    const verifier = emailsActifs();
    const user = await creerCompte({ email, nom, passwordHash: await bcrypt.hash(password, 12), emailVerifie: !verifier });
    if (!verifier) return session(user);
    await envoyerVerification(user);
    return { verification: true, email: user.email };
  },

  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    // Même message dans tous les cas pour ne pas révéler quels emails ont un compte.
    if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new HttpError(401, user && !user.passwordHash ? 'Ce compte se connecte avec Google, ou choisis un mot de passe avec « Mot de passe oublié ».' : 'Email ou mot de passe incorrect.');
    }
    if (!user.emailVerifie && emailsActifs()) throw new HttpError(403, 'Confirme ton email avant de te connecter : ouvre le lien reçu à cette adresse.', 'EMAIL_NON_VERIFIE');
    return session(user);
  },

  async verifier(jeton: string) {
    const u = await JetonService.consommer(jeton, 'VERIFICATION', 'Ce lien de confirmation n’est plus valable. Connecte-toi pour en recevoir un nouveau.');
    const user = u.emailVerifie ? u : await prisma.user.update({ where: { id: u.id }, data: { emailVerifie: true } });
    return session(user);
  },

  /** Renvoie le lien de confirmation. Répond pareil que le compte existe ou non. */
  async renvoyerVerification(email: string) {
    if (!emailsActifs()) throw new HttpError(503, "Les emails de compte ne sont pas configurés sur le serveur.");
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifie && !(await JetonService.recent(user.id, 'VERIFICATION'))) await envoyerVerification(user);
    return { ok: true };
  },

  /** Mot de passe oublié : envoie un lien valable 1 h. Répond pareil que le compte existe ou non. */
  async oubli(email: string) {
    if (!emailsActifs()) throw new HttpError(503, "La réinitialisation par email n'est pas configurée sur le serveur. Demande à l'admin.");
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !(await JetonService.recent(user.id, 'REINITIALISATION'))) {
      const jeton = await JetonService.creer(user.id, 'REINITIALISATION', 60);
      if (!(await EmailsCompte.reinitialisation(user.email, jeton))) throw new HttpError(503, "L'email n'a pas pu partir. Réessaie dans un moment.");
    }
    return { ok: true };
  },

  /** Nouveau mot de passe depuis le lien reçu : ferme les autres sessions et ouvre celle-ci. */
  async reinitialiser(jeton: string, password: string) {
    const u = await JetonService.consommer(jeton, 'REINITIALISATION', 'Ce lien n’est plus valable. Refais une demande de mot de passe oublié.');
    await JetonService.annulerTous(u.id, 'REINITIALISATION');
    // Ouvrir le lien reçu par email prouve aussi l'adresse.
    const user = await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(password, 12), motDePasseLe: maintenant(), emailVerifie: true } });
    return session(user);
  },

  /**
   * Retour de Google : retrouve le compte par son identifiant Google, sinon par son email (vérifié par Google),
   * sinon en crée un. Renvoie un code à usage unique que l'app échange contre une session.
   */
  async google(profil: ProfilGoogle) {
    let user = await prisma.user.findUnique({ where: { googleId: profil.sub } });
    if (!user) {
      if (!profil.emailVerifie) throw new HttpError(400, "Ton adresse Google n'est pas vérifiée chez Google.");
      const existant = await prisma.user.findUnique({ where: { email: profil.email } });
      if (existant) {
        // Compte jamais confirmé : quelqu'un a pu l'inscrire avec cette adresse sans en être le propriétaire.
        // Son mot de passe est donc retiré au moment où le vrai propriétaire le relie à Google.
        user = await prisma.user.update({
          where: { id: existant.id },
          data: { googleId: profil.sub, emailVerifie: true, ...(existant.emailVerifie ? {} : { passwordHash: null, motDePasseLe: maintenant() }) },
        });
      } else {
        user = await creerCompte({ email: profil.email, nom: profil.nom, googleId: profil.sub, emailVerifie: true });
      }
    }
    return JetonService.creer(user.id, 'CONNEXION', 2);
  },

  async echangerGoogle(code: string) {
    return session(await JetonService.consommer(code, 'CONNEXION', 'Connexion Google expirée, recommence.'));
  },

  async moi(userId: string) {
    return publicUser(await prisma.user.findUniqueOrThrow({ where: { id: userId } }));
  },

  async updateMe(userId: string, input: { nom?: string; fuseau?: string; motDePasseActuel?: string; nouveauMotDePasse?: string }) {
    const data: Prisma.UserUpdateInput = {};
    if (input.nom !== undefined) data.nom = input.nom;
    if (input.fuseau !== undefined) data.fuseau = input.fuseau;
    if (input.nouveauMotDePasse) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      // Un compte créé avec Google n'a pas encore de mot de passe : il peut en choisir un sans l'ancien.
      if (user.passwordHash && (!input.motDePasseActuel || !(await bcrypt.compare(input.motDePasseActuel, user.passwordHash)))) throw new HttpError(400, 'Mot de passe actuel incorrect.');
      data.passwordHash = await bcrypt.hash(input.nouveauMotDePasse, 12);
      data.motDePasseLe = maintenant();
    }
    const user = await prisma.user.update({ where: { id: userId }, data });
    // Changer le mot de passe ferme les autres sessions : celle-ci reçoit un nouveau jeton.
    return input.nouveauMotDePasse ? session(user) : { user: publicUser(user) };
  },

  /**
   * Toutes les données du compte gardées par le serveur, pour l'export (droit d'accès et de portabilité).
   * Les jetons d'accès aux comptes connectés n'en font pas partie : ce sont des secrets, pas des données de la personne.
   */
  async exporter(userId: string) {
    const u = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        espace: true,
        integrations: { select: { fournisseur: true, compte: true, ctx: true, derniereSync: true, donnees: true, createdAt: true } },
        notifications: { select: { titre: true, corps: true, mode: true, quand: true, lu: true, parEmail: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
        abonnementsPush: { select: { appareil: true, createdAt: true } },
        paiements: { select: { reference: true, periode: true, montant: true, devise: true, statut: true, payeLe: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    return {
      exporteLe: new Date().toISOString(),
      compte: { email: u.email, nom: u.nom, role: u.role, fuseau: u.fuseau, emailVerifie: u.emailVerifie, connexionGoogle: !!u.googleId, creeLe: u.createdAt },
      espace: u.espace?.data ?? null,
      comptesConnectes: u.integrations,
      notifications: u.notifications,
      appareilsPush: u.abonnementsPush,
      abonnement: { ...etatAbonnement(u), cgvAccepteesLe: u.cgvAccepteesLe, cgvVersion: u.cgvVersion },
      paiements: u.paiements,
    };
  },

  /** Ferme toutes les sessions ouvertes (autres appareils compris) ; celle-ci reçoit un nouveau jeton. */
  async deconnecterTout(userId: string) {
    return session(await prisma.user.update({ where: { id: userId }, data: { sessionsLe: maintenant() } }));
  },

  /** Suppression définitive du compte et de toutes ses données, confirmée en retapant son email. */
  async supprimer(userId: string, confirmation: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { integrations: true } });
    if (confirmation.trim().toLowerCase() !== user.email) throw new HttpError(400, 'Tape ton adresse email exacte pour confirmer.');
    if (user.role === 'ADMIN' && (await prisma.user.count({ where: { role: 'ADMIN' } })) <= 1 && (await prisma.user.count()) > 1) {
      throw new HttpError(400, 'Tu es le seul admin : nomme un autre admin dans Membres avant de supprimer ton compte.');
    }
    // Rend l'accès aux comptes Google connectés (Agenda, Gmail) ; les autres jetons disparaissent avec le compte.
    for (const i of user.integrations.filter((x) => x.fournisseur === 'GOOGLE')) {
      try {
        await ConnexionGoogle.revoquer(dechiffrer(i.refreshToken || i.accessToken));
      } catch {
        // Jeton illisible ou Google injoignable : la suppression continue.
      }
    }
    await prisma.user.delete({ where: { id: userId } });
    return { ok: true };
  },
};
