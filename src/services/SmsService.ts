import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';
import { NumerosAutorises } from './sms/numeros.js';
import { normaliserTelephone } from './abonnements/flexpaie.js';
import { ConfigService } from './ConfigService.js';
import { Asmsc, cleValide, codeValide, configSms, creerCode, empreinteCode, ErreurSms, placeSms, preparerTexte, statutLivraison, texteCode, texteReinitialisation, type ConfigSms } from './sms/asmsc.js';
import { forfaitSms, maxCodesParJour, maxCotisationsParJour, placeForfait, resteForfait } from './sms/forfait.js';

export { maxCodesParJour, maxCotisationsParJour };
import { SELECT_ABONNEMENT } from './abonnements/offres.js';

/** Un code reçu par SMS sert 10 minutes. */
const VALIDITE_CODE_MS = 10 * 60 * 1000;
const JOUR_MS = 24 * 3600 * 1000;
const HISTORIQUE_JOURS = 60;
const secretCode = () => process.env.JWT_SECRET as string;

/** SMS par compte sur 24 h : chaque envoi coûte. */
export const maxParJour = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.SMS_MAX_PAR_JOUR);
  return Number.isInteger(n) && n > 0 ? n : 5;
};

/** SMS d'inscription sur 24 h, tous comptes confondus. */
export const maxInscriptionsParJour = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.SMS_INSCRIPTIONS_PAR_JOUR);
  return Number.isInteger(n) && n > 0 ? n : 50;
};

function exiger(): ConfigSms {
  const cfg = configSms();
  if (!cfg) throw new HttpError(503, "Le SMS n'est pas configuré sur le serveur.");
  return cfg;
}

/** Une erreur du service devient un message clair pour l'app ; les autres remontent. */
async function surService<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ErreurSms) throw new HttpError(502, e.message);
    throw e;
  }
}

/** L'adresse où aSMSC signale la livraison : seulement en https, avec une clé. */
function adresseRetour() {
  const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '');
  const cle = process.env.SMS_CALLBACK_CLE?.trim();
  return base?.startsWith('https://') && cle ? `${base}/api/sms/retour?cle=${encodeURIComponent(cle)}` : undefined;
}

/** Le numéro sert à se connecter : il ne peut désigner qu'un seul compte. */
async function exigerNumeroLibre(userId: string, telephone: string) {
  if (await prisma.user.count({ where: { telephone, NOT: { id: userId } } })) throw new HttpError(409, 'Ce numéro est déjà lié à un autre compte.');
}

export const SmsService = {
  configure: () => configSms() !== null,

  async etat(userId: string) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { telephone: true, telephoneEnAttente: true, smsVerificationLe: true } });
    const attente = u.telephoneEnAttente && u.smsVerificationLe && Date.now() - u.smsVerificationLe.getTime() < VALIDITE_CODE_MS ? u.telephoneEnAttente : null;
    return { disponible: this.configure(), telephone: u.telephone, enAttente: attente, forfait: await this.forfait(userId) };
  },

  /** Le forfait du compte : SMS permis sur la période, déjà comptés (en segments) et restants. */
  async forfait(userId: string, maintenant = new Date()) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: SELECT_ABONNEMENT });
    const f = forfaitSms(u, maintenant);
    const { _sum } = await prisma.envoiSms.aggregate({ _sum: { segments: true }, where: { userId, genre: 'compte', createdAt: { gte: f.depuis }, NOT: { statut: 'echec', messageId: null } } });
    const utilises = _sum.segments ?? 0;
    return { limite: f.limite, utilises, reste: resteForfait(utilises, f.limite), periode: f.periode, depuis: f.depuis.toISOString() };
  },

  /** Envoie un code au numéro : il ne reçoit des rappels qu'une fois le code confirmé. */
  async demanderCode(userId: string, brut: string) {
    const cfg = exiger();
    const telephone = normaliserTelephone(brut);
    if (!telephone) throw new HttpError(400, 'Numéro invalide. Vérifie l’indicatif et le numéro.');
    await NumerosAutorises.exiger(telephone);
    await exigerNumeroLibre(userId, telephone);
    // Chaque code envoyé coûte : un compte ne peut pas en réclamer sans fin (ni faire payer des SMS à des numéros au hasard).
    const depuis = new Date(Date.now() - JOUR_MS);
    if ((await prisma.envoiSms.count({ where: { userId, genre: 'code', createdAt: { gte: depuis } } })) >= maxCodesParJour()) throw new HttpError(429, 'Trop de codes demandés aujourd’hui. Réessaie demain.');
    const code = creerCode();
    const envoi = await prisma.envoiSms.create({ data: { userId, genre: 'code' } });
    try {
      const r = await Asmsc.envoyer(cfg, { telephone, texte: texteCode(cfg.marque, code), uid: envoi.id, retour: adresseRetour() });
      await prisma.envoiSms.update({ where: { id: envoi.id }, data: { messageId: r.messageId } });
    } catch (e) {
      await prisma.envoiSms.update({ where: { id: envoi.id }, data: { statut: 'echec' } });
      if (e instanceof ErreurSms) throw new HttpError(502, e.message);
      throw e;
    }
    // smsVerificationId garde l'empreinte du code, jamais le code.
    await prisma.user.update({ where: { id: userId }, data: { telephoneEnAttente: telephone, smsVerificationId: empreinteCode(code, userId, telephone, secretCode()), smsVerificationLe: new Date() } });
    return this.etat(userId);
  },

  async confirmerCode(userId: string, code: string) {
    exiger();
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { telephoneEnAttente: true, smsVerificationId: true, smsVerificationLe: true } });
    if (!u.telephoneEnAttente || !u.smsVerificationId || !u.smsVerificationLe || Date.now() - u.smsVerificationLe.getTime() >= VALIDITE_CODE_MS) throw new HttpError(400, 'Code expiré. Demande-en un nouveau.');
    if (!codeValide(code, u.smsVerificationId, userId, u.telephoneEnAttente, secretCode())) throw new HttpError(400, 'Code incorrect.');
    await exigerNumeroLibre(userId, u.telephoneEnAttente);
    await prisma.user.update({ where: { id: userId }, data: { telephone: u.telephoneEnAttente, telephoneEnAttente: null, smsVerificationId: null, smsVerificationLe: null } });
    return this.etat(userId);
  },

  async retirer(userId: string) {
    // Sans email confirmé, le numéro est le seul moyen d'entrer dans le compte.
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, emailVerifie: true, telephone: true, googleId: true } });
    if (u.telephone && !u.googleId && !(u.email && u.emailVerifie)) throw new HttpError(400, 'Ajoute et confirme un email avant de retirer ton numéro.');
    await prisma.user.update({ where: { id: userId }, data: { telephone: null, telephoneEnAttente: null, smsVerificationId: null, smsVerificationLe: null } });
    return this.etat(userId);
  },

  /** Envoie le SMS et l'inscrit à l'historique (date, état, segments : jamais le texte ni le numéro). Ne lève jamais. */
  async expedier(cfg: ConfigSms, userId: string, telephone: string, texte: string, genre: 'compte' | 'securite' | 'cotisation', segments: number): Promise<boolean> {
    const envoi = await prisma.envoiSms.create({ data: { userId, genre, segments: preparerTexte(texte, { segments }).segments } });
    try {
      const r = await Asmsc.envoyer(cfg, { telephone, texte, uid: envoi.id, retour: adresseRetour(), segments });
      await prisma.envoiSms.update({ where: { id: envoi.id }, data: { messageId: r.messageId } });
      return true;
    } catch (e) {
      console.error('SMS', (e as Error).message);
      await prisma.envoiSms.update({ where: { id: envoi.id }, data: { statut: 'echec' } });
      return false;
    }
  },

  /**
   * Envoie un SMS de service (rappel, rapport, avis de groupe) à un compte, dans la limite du jour et dans son forfait
   * de SMS (comptés en segments : un SMS long en coûte plusieurs). Ne lève jamais : un SMS perdu ne doit pas arrêter les rappels.
   * Un envoi refusé par le service (sans identifiant de message) n'a rien coûté : il ne compte pas.
   */
  async envoyer(userId: string, telephone: string, texte: string, secondaire = false, segments = 1): Promise<boolean> {
    const cfg = configSms();
    if (!cfg) return false;
    const depuis = new Date(Date.now() - JOUR_MS);
    if (!placeSms(await prisma.envoiSms.count({ where: { userId, genre: 'compte', createdAt: { gte: depuis }, NOT: { statut: 'echec', messageId: null } } }), maxParJour(), secondaire)) return false;
    const f = await this.forfait(userId);
    if (!placeForfait(f.utilises, preparerTexte(texte, { segments }).segments, f.limite)) return false;
    return this.expedier(cfg, userId, telephone, texte, 'compte', segments);
  },

  /** Un SMS de sécurité (code d'inscription, mot de passe) : hors forfait, avec sa propre limite du jour. */
  async envoyerSecurite(userId: string, telephone: string, texte: string): Promise<boolean> {
    const cfg = configSms();
    if (!cfg) return false;
    const depuis = new Date(Date.now() - JOUR_MS);
    if ((await prisma.envoiSms.count({ where: { userId, genre: 'securite', createdAt: { gte: depuis }, NOT: { statut: 'echec', messageId: null } } })) >= maxParJour()) return false;
    return this.expedier(cfg, userId, telephone, texte, 'securite', 1);
  },

  /** Une invitation envoyée pour un groupe : sa propre limite, pour ne pas priver l'organisateur de ses rappels. */
  async envoyerCotisation(userId: string, telephone: string, texte: string): Promise<boolean> {
    const cfg = configSms();
    if (!cfg) return false;
    const depuis = new Date(Date.now() - JOUR_MS);
    const envoyes = await prisma.envoiSms.count({ where: { userId, genre: 'cotisation', createdAt: { gte: depuis }, NOT: { statut: 'echec', messageId: null } } });
    if (envoyes >= maxCotisationsParJour()) return false;
    return this.expedier(cfg, userId, telephone, texte, 'cotisation', 1);
  },

  /** Peut-on confirmer un compte par SMS ? Le service marche, et l'admin n'a coupé ni le SMS ni cette option. */
  async inscriptionOuverte() {
    if (!this.configure()) return false;
    const canaux = ((await ConfigService.get()) as { canaux?: { sms?: boolean; inscriptionSms?: boolean } }).canaux;
    return canaux?.sms !== false && canaux?.inscriptionSms !== false;
  },

  /** Le plafond du jour, tous comptes en attente confondus : un formulaire public ne doit pas pouvoir vider le solde. */
  async plafondInscriptionsAtteint(maintenant = new Date()) {
    const envoyes = await prisma.envoiSms.count({ where: { createdAt: { gte: new Date(maintenant.getTime() - JOUR_MS) }, user: { telephone: null, emailVerifie: false } } });
    return envoyes >= maxInscriptionsParJour();
  },

  /** Le code qui confirme un compte tout juste créé, compté dans la limite du jour de ce compte. */
  async codeInscription(userId: string, telephone: string) {
    const cfg = exiger();
    const code = creerCode();
    await prisma.user.update({ where: { id: userId }, data: { telephoneEnAttente: telephone, smsVerificationId: empreinteCode(code, userId, telephone, secretCode()), smsVerificationLe: new Date() } });
    return this.envoyerSecurite(userId, telephone, texteCode(cfg.marque, code));
  },

  /** Mot de passe oublié : le lien part aussi au numéro vérifié du compte, dans la limite du jour. Ne lève jamais. */
  async reinitialisation(userId: string, telephone: string, lien: string): Promise<boolean> {
    const cfg = configSms();
    const texte = cfg && texteReinitialisation(cfg.marque, lien);
    return texte ? this.envoyerSecurite(userId, telephone, texte) : false;
  },

  async tester(userId: string) {
    exiger();
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { telephone: true } });
    if (!u.telephone) throw new HttpError(400, 'Ajoute d’abord ton numéro.');
    if (!(await this.envoyer(userId, u.telephone, 'Essai : les rappels par SMS de Me fonctionnent.'))) throw new HttpError(502, 'SMS non envoyé. Réessaie plus tard.');
  },

  /** Livraison signalée par aSMSC : la clé de l'adresse prouve que l'appel vient bien de lui. */
  async retour(cle: unknown, corps: { uid?: unknown; DLRStatus?: unknown } | undefined) {
    if (!cleValide(cle, process.env.SMS_CALLBACK_CLE?.trim())) throw new HttpError(403, 'Clé invalide.');
    if (typeof corps?.uid !== 'string' || !corps.uid) return;
    await prisma.envoiSms.updateMany({ where: { id: corps.uid }, data: { statut: statutLivraison(corps.DLRStatus) } });
  },

  async solde() {
    const cfg = exiger();
    return surService(() => Asmsc.solde(cfg));
  },

  async purger(maintenant = new Date()) {
    await prisma.envoiSms.deleteMany({ where: { createdAt: { lt: new Date(maintenant.getTime() - HISTORIQUE_JOURS * JOUR_MS) } } });
  },
};
