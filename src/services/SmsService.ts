import { HttpError } from '../utils/http.js';
import { prisma } from '../utils/prisma.js';
import { normaliserTelephone } from './abonnements/flexpaie.js';
import { ConfigService } from './ConfigService.js';
import { Asmsc, cleValide, codeValide, configSms, creerCode, empreinteCode, ErreurSms, placeSms, statutLivraison, texteCode, texteReinitialisation, type ConfigSms } from './sms/asmsc.js';

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

export const SmsService = {
  configure: () => configSms() !== null,

  async etat(userId: string) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { telephone: true, telephoneEnAttente: true, smsVerificationLe: true } });
    const attente = u.telephoneEnAttente && u.smsVerificationLe && Date.now() - u.smsVerificationLe.getTime() < VALIDITE_CODE_MS ? u.telephoneEnAttente : null;
    return { disponible: this.configure(), telephone: u.telephone, enAttente: attente };
  },

  /** Envoie un code au numéro : il ne reçoit des rappels qu'une fois le code confirmé. */
  async demanderCode(userId: string, brut: string) {
    const cfg = exiger();
    const telephone = normaliserTelephone(brut);
    if (!telephone) throw new HttpError(400, 'Numéro invalide. Exemple : 243 81 234 5678.');
    const code = creerCode();
    await surService(() => Asmsc.envoyer(cfg, { telephone, texte: texteCode(cfg.marque, code), uid: `code-${userId}` }));
    // smsVerificationId garde l'empreinte du code, jamais le code.
    await prisma.user.update({ where: { id: userId }, data: { telephoneEnAttente: telephone, smsVerificationId: empreinteCode(code, userId, telephone, secretCode()), smsVerificationLe: new Date() } });
    return this.etat(userId);
  },

  async confirmerCode(userId: string, code: string) {
    exiger();
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { telephoneEnAttente: true, smsVerificationId: true, smsVerificationLe: true } });
    if (!u.telephoneEnAttente || !u.smsVerificationId || !u.smsVerificationLe || Date.now() - u.smsVerificationLe.getTime() >= VALIDITE_CODE_MS) throw new HttpError(400, 'Code expiré. Demande-en un nouveau.');
    if (!codeValide(code, u.smsVerificationId, userId, u.telephoneEnAttente, secretCode())) throw new HttpError(400, 'Code incorrect.');
    await prisma.user.update({ where: { id: userId }, data: { telephone: u.telephoneEnAttente, telephoneEnAttente: null, smsVerificationId: null, smsVerificationLe: null } });
    return this.etat(userId);
  },

  async retirer(userId: string) {
    await prisma.user.update({ where: { id: userId }, data: { telephone: null, telephoneEnAttente: null, smsVerificationId: null, smsVerificationLe: null } });
    return this.etat(userId);
  },

  /**
   * Envoie un SMS à un compte, dans la limite du jour. Ne lève jamais : un SMS perdu ne doit pas arrêter les rappels.
   * Le texte et le numéro ne sont pas gardés dans l'historique : seulement la date et l'état.
   */
  async envoyer(userId: string, telephone: string, texte: string, secondaire = false): Promise<boolean> {
    const cfg = configSms();
    if (!cfg) return false;
    const depuis = new Date(Date.now() - JOUR_MS);
    // Un envoi refusé par le service (sans identifiant de message) n'a rien coûté : il ne compte pas dans la limite.
    if (!placeSms(await prisma.envoiSms.count({ where: { userId, createdAt: { gte: depuis }, NOT: { statut: 'echec', messageId: null } } }), maxParJour(), secondaire)) return false;
    const envoi = await prisma.envoiSms.create({ data: { userId } });
    try {
      const r = await Asmsc.envoyer(cfg, { telephone, texte, uid: envoi.id, retour: adresseRetour() });
      await prisma.envoiSms.update({ where: { id: envoi.id }, data: { messageId: r.messageId } });
      return true;
    } catch (e) {
      console.error('SMS', (e as Error).message);
      await prisma.envoiSms.update({ where: { id: envoi.id }, data: { statut: 'echec' } });
      return false;
    }
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
    return this.envoyer(userId, telephone, texteCode(cfg.marque, code));
  },

  /** Mot de passe oublié : le lien part aussi au numéro vérifié du compte, dans la limite du jour. Ne lève jamais. */
  async reinitialisation(userId: string, telephone: string, lien: string): Promise<boolean> {
    const cfg = configSms();
    const texte = cfg && texteReinitialisation(cfg.marque, lien);
    return texte ? this.envoyer(userId, telephone, texte) : false;
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
