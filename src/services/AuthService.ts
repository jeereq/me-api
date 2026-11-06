import bcrypt from 'bcryptjs';

import type { Prisma } from '@prisma/client';

import { enCoffre, horsCoffre } from '../utils/coffre.js';
import { dechiffrer } from '../utils/crypto.js';
import { empreintesCompte } from './abonnements/essai-unique.js';
import { etatAbonnement, finEssai, type ChampsAbonnement } from './abonnements/offres.js';
import { HttpError } from '../utils/http.js';
import { generateToken } from '../utils/jwt.js';
import { prisma } from '../utils/prisma.js';
import { EmailsCompte, emailsActifs, adresseApp, lienReinitialisation } from './comptes/emails.js';
import { normaliserTelephone } from './abonnements/flexpaie.js';
import { NumerosAutorises } from './sms/numeros.js';
import { SmsService } from './SmsService.js';
import { refusMotDePasse } from '../commun/mot-de-passe.js';
import { ConnexionGoogle, type ProfilGoogle } from './comptes/google.js';
import { JetonService } from './comptes/JetonService.js';
import { StockJustificatifs } from './justificatifs/stock.js';

type Compte = { id: string; email: string | null; telephone?: string | null; emailVerifie?: boolean; nom: string; role: 'ADMIN' | 'UTILISATEUR'; passwordHash?: string | null; googleId?: string | null; nomApp?: string } & ChampsAbonnement;

const publicUser = (u: Compte) => ({ id: u.id, email: u.email, telephone: u.telephone ?? null, emailVerifie: u.emailVerifie, nom: u.nom, nomApp: u.nomApp ?? '', role: u.role, motDePasse: u.passwordHash !== null, google: !!u.googleId, abonnement: etatAbonnement(u) });
const session = (u: Compte) => ({ token: generateToken({ userId: u.id }), user: publicUser(u) });
// Les jetons de session ont une précision à la seconde : on tronque pour que la session ouverte juste après reste valable.
const maintenant = () => new Date(Math.floor(Date.now() / 1000) * 1000);

/**
 * Le compte d'un email ou d'un numéro de téléphone. Un numéro doit être vérifié, ou en attente de son code sur un compte qui
 * n'a rien d'autre ; s'il est lié à plusieurs comptes (ancien doublon), il ne désigne personne : il faut passer par l'email.
 */
async function trouverCompte(identifiant: string) {
  const brut = identifiant.trim();
  if (brut.includes('@')) return prisma.user.findUnique({ where: { email: brut.toLowerCase() } });
  const telephone = normaliserTelephone(brut);
  if (!telephone) return null;
  const verifies = await prisma.user.findMany({ where: { telephone }, take: 2 });
  if (verifies.length) return verifies.length === 1 ? verifies[0] : null;
  return prisma.user.findFirst({ where: { telephoneEnAttente: telephone, telephone: null, emailVerifie: false }, orderBy: { smsVerificationLe: 'desc' } });
}

const exigerBonMotDePasse = (mdp: string, c: { email?: string | null; nom?: string; telephone?: string | null }) => {
  const refus = refusMotDePasse(mdp, c);
  if (refus) throw new HttpError(400, `Mot de passe refusé : ${refus}`);
};

/** Prévient que le mot de passe vient de changer, par les canaux prouvés du compte. Une alerte perdue ne bloque rien. */
function alerterMotDePasse(u: { id: string; email: string | null; emailVerifie: boolean; telephone?: string | null }) {
  const envois: Promise<unknown>[] = [];
  if (u.email && u.emailVerifie && emailsActifs()) envois.push(EmailsCompte.motDePasseChange(u.email));
  if (u.telephone) envois.push(SmsService.envoyer(u.id, u.telephone, 'Me : ton mot de passe vient de changer. Si ce n\'est pas toi, utilise "Mot de passe oublie" tout de suite.'));
  Promise.allSettled(envois).catch(() => {});
}

/** Le lien de mot de passe oublié peut-il partir par SMS ? Il faut le service et l'adresse de l'app. */
const oubliParSms = () => SmsService.configure() && !!adresseApp();

/** Crée un compte (inscription ou premier passage par Google) en respectant SIGNUP_OPEN et la règle du premier admin. */
function creerCompte(data: Omit<Prisma.UserCreateInput, 'role'>) {
  // Transaction sérialisable : deux inscriptions simultanées ne peuvent pas créer deux « premiers » admins.
  return prisma.$transaction(
    async (tx) => {
      const count = await tx.user.count();
      if (count > 0 && process.env.SIGNUP_OPEN === 'false') throw new HttpError(403, "Les inscriptions sont fermées. Demande à l'admin.");
      if (data.email && (await tx.user.findUnique({ where: { email: data.email } }))) throw new HttpError(409, 'Un compte existe déjà avec cet email.');
      // Chaque nouveau compte commence par l'essai Pro, sauf si la même personne l'a déjà eu avec un compte supprimé.
      const dejaEu = await tx.essaiUtilise.count({ where: { empreinte: { in: empreintesCompte({ email: data.email, googleId: data.googleId, telephone: data.telephoneEnAttente }) } } });
      return tx.user.create({ data: { ...data, essaiJusqua: dejaEu ? null : finEssai(), role: count === 0 && !process.env.ADMIN_EMAIL ? 'ADMIN' : 'UTILISATEUR' } });
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
  options: async () => ({ google: ConnexionGoogle.configure(), email: emailsActifs(), oubli: emailsActifs() || oubliParSms(), sms: await SmsService.inscriptionOuverte(), indicatifs: await NumerosAutorises.indicatifs() }),

  /**
   * Inscription. La personne choisit comment confirmer son compte : par email, ou par un code reçu par SMS.
   * Par email, si les emails de compte sont configurés, le compte attend la confirmation ; sinon il est utilisable tout de suite.
   * Par SMS, l'adresse n'est pas prouvée : aucun email ne lui part tant qu'elle n'est pas confirmée.
   */
  async register(email: string | undefined, password: string, nom = '', choix: { confirmation?: 'email' | 'sms'; telephone?: string } = {}) {
    exigerBonMotDePasse(password, { email, nom, telephone: choix.telephone });
    if (choix.confirmation === 'sms') return this.registerSms(email, password, nom, choix.telephone ?? '');
    if (!email) throw new HttpError(400, 'Email ou téléphone requis.');
    const verifier = emailsActifs();
    const user = await creerCompte({ email, nom, passwordHash: await bcrypt.hash(password, 12), emailVerifie: !verifier });
    if (!verifier) return session(user);
    await envoyerVerification({ id: user.id, email });
    return { verification: true, email };
  },

  async registerSms(email: string | undefined, password: string, nom: string, brut: string) {
    if (!(await SmsService.inscriptionOuverte())) throw new HttpError(503, 'La confirmation par SMS n’est pas disponible. Choisis l’email.');
    const telephone = normaliserTelephone(brut);
    if (!telephone) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
    await NumerosAutorises.exiger(telephone);
    // Un numéro, un compte : sinon un même téléphone ouvrirait autant d'essais Pro que d'adresses inventées.
    if (await prisma.user.findFirst({ where: { OR: [{ telephone }, { telephoneEnAttente: telephone, smsVerificationLe: { gte: new Date(Date.now() - 86_400_000) } }] }, select: { id: true } })) throw new HttpError(409, 'Ce numéro a déjà un compte. Connecte-toi, ou choisis l’email.');
    // Un essai resté sans code : le numéro est à nouveau libre (pas de doublon qui le rendrait ambigu à la connexion).
    await prisma.user.deleteMany({ where: { email: null, telephone: null, emailVerifie: false, telephoneEnAttente: telephone } });
    if (await SmsService.plafondInscriptionsAtteint()) throw new HttpError(429, 'Trop d’inscriptions par SMS aujourd’hui. Choisis l’email, ou réessaie demain.');
    const user = await creerCompte({ email, nom, passwordHash: await bcrypt.hash(password, 12), emailVerifie: false, telephoneEnAttente: telephone });
    if (!(await SmsService.codeInscription(user.id, telephone))) {
      // Sans code reçu, le compte ne servirait à rien et bloquerait l'adresse.
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
      throw new HttpError(502, 'Le SMS n’a pas pu partir. Vérifie le numéro, ou choisis l’email.');
    }
    return { verification: true, par: 'sms', email: user.email, telephone };
  },

  /** Le code reçu par SMS confirme le compte et ouvre sa session. */
  async confirmerSms(identifiant: string, code: string) {
    const u = await trouverCompte(identifiant);
    if (!u?.telephoneEnAttente || u.telephone || u.emailVerifie) throw new HttpError(400, 'Code expiré. Demande-en un nouveau.');
    await SmsService.confirmerCode(u.id, code);
    return session(await prisma.user.findUniqueOrThrow({ where: { id: u.id } }));
  },

  /** Renvoie le code. Répond pareil que le compte existe ou non ; pas plus d'un code par minute. */
  async renvoyerCodeSms(identifiant: string) {
    const u = await trouverCompte(identifiant);
    const attendre = !!u?.smsVerificationLe && Date.now() - u.smsVerificationLe.getTime() < 60_000;
    if (u?.telephoneEnAttente && !u.telephone && !u.emailVerifie && !attendre) await SmsService.codeInscription(u.id, u.telephoneEnAttente);
    return { ok: true };
  },

  async login(identifiant: string, password: string) {
    const user = await trouverCompte(identifiant);
    // Même message dans tous les cas pour ne pas révéler quels emails ont un compte.
    if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new HttpError(401, user && !user.passwordHash ? 'Ce compte se connecte avec Google, ou choisis un mot de passe avec « Mot de passe oublié ».' : 'Identifiant ou mot de passe incorrect.');
    }
    // Un numéro confirmé par SMS suffit pour entrer ; l'adresse, elle, reste à prouver.
    if (!user.emailVerifie && !user.telephone) {
      if (user.telephoneEnAttente) throw new HttpError(403, 'Entre le code reçu par SMS pour activer ton compte.', 'SMS_NON_VERIFIE');
      if (emailsActifs()) throw new HttpError(403, 'Confirme ton email avant de te connecter : ouvre le lien reçu à cette adresse.', 'EMAIL_NON_VERIFIE');
    }
    return session(user);
  },

  async verifier(jeton: string) {
    const u = await JetonService.consommer(jeton, 'VERIFICATION', 'Ce lien de confirmation n’est plus valable. Connecte-toi pour en recevoir un nouveau.');
    const user = u.emailVerifie ? u : await prisma.user.update({ where: { id: u.id }, data: { emailVerifie: true } });
    return session(user);
  },

  /** Renvoie le lien de confirmation. Répond pareil que le compte existe ou non. */
  async renvoyerVerification(identifiant: string) {
    if (!emailsActifs()) throw new HttpError(503, "Les emails de compte ne sont pas configurés sur le serveur.");
    const user = await trouverCompte(identifiant);
    if (user?.email && !user.emailVerifie && !(await JetonService.recent(user.id, 'VERIFICATION'))) await envoyerVerification({ id: user.id, email: user.email });
    return { ok: true };
  },

  /** Mot de passe oublié : envoie un lien valable 1 h, par email et au numéro vérifié du compte. Répond pareil que le compte existe ou non. */
  async oubli(identifiant: string) {
    const parEmail = emailsActifs();
    if (!parEmail && !oubliParSms()) throw new HttpError(503, "La réinitialisation n'est pas configurée sur le serveur. Demande à l'admin.");
    const user = await trouverCompte(identifiant);
    if (user && !(await JetonService.recent(user.id, 'REINITIALISATION'))) {
      const jeton = await JetonService.creer(user.id, 'REINITIALISATION', 60);
      const parSms = !!user.telephone && oubliParSms() && (await SmsService.reinitialisation(user.id, user.telephone, lienReinitialisation(jeton)));
      if (parEmail && user.email && !(await EmailsCompte.reinitialisation(user.email, jeton)) && !parSms) throw new HttpError(503, "L'email n'a pas pu partir. Réessaie dans un moment.");
    }
    return { ok: true };
  },

  /** Nouveau mot de passe depuis le lien reçu : ferme les autres sessions et ouvre celle-ci. */
  async reinitialiser(jeton: string, password: string) {
    // Avant de consommer le lien : un mot de passe refusé ne doit pas le griller.
    const titulaire = await JetonService.lire(jeton, 'REINITIALISATION');
    if (titulaire) exigerBonMotDePasse(password, titulaire);
    const u = await JetonService.consommer(jeton, 'REINITIALISATION', 'Ce lien n’est plus valable. Refais une demande de mot de passe oublié.');
    await JetonService.annulerTous(u.id, 'REINITIALISATION');
    // Ouvrir le lien reçu par email prouve aussi l'adresse ; avec un numéro vérifié, il a pu arriver par SMS : rien n'est prouvé.
    const user = await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(password, 12), motDePasseLe: maintenant(), emailVerifie: u.emailVerifie || !u.telephone } });
    alerterMotDePasse(user);
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

  async updateMe(userId: string, input: { email?: string; nom?: string; fuseau?: string; nomApp?: string; motDePasseActuel?: string; nouveauMotDePasse?: string }) {
    const data: Prisma.UserUpdateInput = {};
    if (input.nom !== undefined) data.nom = input.nom;
    if (input.fuseau !== undefined) data.fuseau = input.fuseau;
    if (input.nomApp !== undefined) data.nomApp = input.nomApp;
    if (input.email) {
      // Seul un compte créé avec son numéro n'a pas d'adresse ; elle reste à confirmer.
      const moi = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
      if (moi.email) throw new HttpError(400, 'Ton compte a déjà une adresse email.');
      if (await prisma.user.findUnique({ where: { email: input.email } })) throw new HttpError(409, 'Un compte existe déjà avec cet email.');
      data.email = input.email;
      data.emailVerifie = !emailsActifs();
    }
    if (input.nouveauMotDePasse) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      // Un compte créé avec Google n'a pas encore de mot de passe : il peut en choisir un sans l'ancien.
      if (user.passwordHash && (!input.motDePasseActuel || !(await bcrypt.compare(input.motDePasseActuel, user.passwordHash)))) throw new HttpError(400, 'Mot de passe actuel incorrect.');
      exigerBonMotDePasse(input.nouveauMotDePasse, user);
      data.passwordHash = await bcrypt.hash(input.nouveauMotDePasse, 12);
      data.motDePasseLe = maintenant();
    }
    const user = await prisma.user.update({ where: { id: userId }, data });
    // Changer le mot de passe ferme les autres sessions : celle-ci reçoit un nouveau jeton.
    if (input.nouveauMotDePasse) alerterMotDePasse(user);
    if (input.email && emailsActifs()) await envoyerVerification({ id: user.id, email: input.email }).catch(() => {});
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
        envoisSms: { select: { statut: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
        tontines: { select: { etat: true, rang: true, cautionStatut: true, createdAt: true, tontine: { select: { nom: true, montant: true, devise: true, rythme: true, etat: true } } } },
        cotisations: { include: { membres: { select: { contact: true, createdAt: true } }, paiements: { select: { reference: true, periode: true, montant: true, devise: true, mode: true, statut: true, telephone: true, payeLe: true, createdAt: true } } } },
        paiements: { select: { reference: true, periode: true, montant: true, devise: true, statut: true, payeLe: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    return {
      exporteLe: new Date().toISOString(),
      compte: { email: u.email, telephone: u.telephone, nom: u.nom, nomApp: u.nomApp, role: u.role, fuseau: u.fuseau, emailVerifie: u.emailVerifie, connexionGoogle: !!u.googleId, creeLe: u.createdAt },
      espace: u.espace?.data ?? null,
      comptesConnectes: u.integrations.map((i) => ({ ...i, donnees: horsCoffre(i.donnees) })),
      tontines: u.tontines,
      cotisations: u.cotisations.map((c) => ({ titre: c.titre, montant: c.montant, devise: c.devise, rythme: c.rythme, debut: c.debut, archive: c.archive, createdAt: c.createdAt, membres: c.membres.map((m) => horsCoffre(m.contact)), paiements: c.paiements })),
      notifications: u.notifications,
      appareilsPush: u.abonnementsPush,
      envoisSms: u.envoisSms,
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
    if (user.email ? confirmation.trim().toLowerCase() !== user.email : normaliserTelephone(confirmation) !== user.telephone) {
      throw new HttpError(400, user.email ? 'Tape ton adresse email exacte pour confirmer.' : 'Tape ton numéro exact pour confirmer.');
    }
    if (user.role === 'ADMIN' && (await prisma.user.count({ where: { role: 'ADMIN' } })) <= 1 && (await prisma.user.count()) > 1) {
      throw new HttpError(400, 'Tu es le seul admin : nomme un autre admin dans Membres avant de supprimer ton compte.');
    }
    // L'argent d'un groupe en cours ne peut pas disparaître avec un compte.
    const engagements = await prisma.tontineMembre.count({ where: { userId, OR: [{ etat: 'accepte', tontine: { etat: 'en_cours' } }, { cautionStatut: { in: ['payee', 'a_rendre'] } }] } });
    if (engagements) throw new HttpError(409, 'Tu participes à une tontine en cours ou une caution reste à régler : termine-la avant de supprimer ton compte.');
    if (await prisma.tontine.count({ where: { organisateurId: userId, etat: 'ouvert' } })) throw new HttpError(409, 'Annule d’abord le groupe que tu organises.');
    await prisma.tontineMembre.updateMany({ where: { userId }, data: { contact: enCoffre({ nom: 'Ancien membre', telephone: '' }) } });
    // Rend l'accès aux comptes Google connectés (Agenda, Gmail) ; les autres jetons disparaissent avec le compte.
    for (const i of user.integrations.filter((x) => x.fournisseur === 'GOOGLE')) {
      try {
        await ConnexionGoogle.revoquer(dechiffrer(i.refreshToken || i.accessToken));
      } catch {
        // Jeton illisible ou Google injoignable : la suppression continue.
      }
    }
    // Les paiements restent pour la comptabilité, sans le numéro de téléphone (le lien au compte disparaît avec lui).
    await prisma.paiement.updateMany({ where: { userId }, data: { telephone: '' } });
    // Les encaissements mobiles des cotisations restent aussi ; les paiements notés à la main n'ont plus d'utilité.
    await prisma.paiementCotisation.deleteMany({ where: { mode: 'main', cotisation: { userId } } });
    // L'essai Pro est unique par personne : on garde seulement une empreinte de l'email et du compte Google.
    if (user.essaiJusqua) {
      await prisma.essaiUtilise.createMany({ data: empreintesCompte(user).map((empreinte) => ({ empreinte })), skipDuplicates: true });
    }
    await StockJustificatifs.purgerCompte(userId);
    await prisma.user.delete({ where: { id: userId } });
    return { ok: true };
  },
};
