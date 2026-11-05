import { z } from 'zod';

import { erreurNomApp, nettoyerNomApp } from '../commun/nom-app.js';

const email = z.string({ required_error: 'Email requis' }).trim().toLowerCase().email('Email invalide');
const password = z.string({ required_error: 'Mot de passe requis' }).min(8, 'Le mot de passe doit faire au moins 8 caractères').max(128, 'Le mot de passe doit faire au plus 128 caractères').max(200);

/** Un email ou un numéro de téléphone ; `email` reste accepté pour les anciennes versions de l'app. */
const identifiant = z
  .object({ identifiant: z.string().trim().min(3).max(320).optional(), email: z.string().trim().max(320).optional() })
  .refine((b) => !!(b.identifiant || b.email), { message: 'Email ou téléphone requis' });
/** Un email, ou un numéro confirmé par SMS : le compte peut ne pas avoir d'email. */
export const registerSchema = z.object({
  body: z.object({ email: email.optional(), password, nom: z.string().trim().max(80).optional(), confirmation: z.enum(['email', 'sms']).optional(), telephone: z.string().trim().max(30).optional() }).refine((b) => !!b.email || (b.confirmation === 'sms' && !!b.telephone), { message: 'Email ou téléphone requis', path: ['email'] }),
});
export const confirmerSmsSchema = z.object({ body: identifiant.and(z.object({ code: z.string({ required_error: 'Code requis' }).trim().regex(/^\d{6}$/, 'Le code a 6 chiffres.') })) });
export const loginSchema = z.object({ body: identifiant.and(z.object({ password: z.string().min(1, 'Mot de passe requis').max(1000) })) });
export const identifiantSchema = z.object({ body: identifiant });
export const emailSchema = z.object({ body: z.object({ email }) });
export const contactSchema = z.object({
  body: z.object({
    nom: z.string({ required_error: 'Ton nom est requis.' }).trim().min(1, 'Ton nom est requis.').max(80),
    email,
    telephone: z.string().trim().max(30).regex(/^[+\d\s().-]*$/, 'Numéro invalide.').optional(),
    message: z.string({ required_error: 'Ton message est requis.' }).trim().min(10, 'Ton message est trop court.').max(3000, 'Ton message est trop long.'),
    site: z.string().max(200).optional(),
  }),
});
const jeton = z.string({ required_error: 'Lien incomplet' }).min(10, 'Lien incomplet').max(200);
export const jetonSchema = z.object({ body: z.object({ jeton }) });
export const reinitialiserSchema = z.object({ body: z.object({ jeton, password }) });
export const codeSchema = z.object({ body: z.object({ code: jeton }) });
export const supprimerCompteSchema = z.object({ body: z.object({ confirmation: z.string({ required_error: 'Confirmation requise' }).max(320) }) });
const fuseauValide = (f: string) => {
  try {
    new Intl.DateTimeFormat('fr', { timeZone: f });
    return true;
  } catch {
    return false;
  }
};

/** Nom de l'app choisi par l'utilisateur ; chaîne vide = revenir à « Me ». */
const nomApp = z
  .string()
  .max(100)
  .transform(nettoyerNomApp)
  .superRefine((v, ctx) => {
    const e = erreurNomApp(v);
    if (e) ctx.addIssue({ code: z.ZodIssueCode.custom, message: e });
  })
  .optional();
export const updateMeSchema = z.object({
  body: z.object({ email: email.optional(), nom: z.string().trim().max(80).optional(), fuseau: z.string().max(60).refine(fuseauValide, 'Fuseau horaire inconnu').optional(), nomApp, motDePasseActuel: z.string().optional(), nouveauMotDePasse: password.optional() }),
});

const document = z.record(z.unknown(), { invalid_type_error: 'Document JSON attendu' });
// baseRevision : la version de l'espace lue en dernier par l'appareil (absent pour les anciennes versions de l'app : la dernière écriture gagne).
export const putEspaceSchema = z.object({ body: z.object({ data: document, baseRevision: z.number().int().min(0).optional() }) });
// Synchro par différences (`commun/patch.ts`) : la version de départ est obligatoire, les opérations sont vérifiées à l'application.
const chemin = z.array(z.string().max(200)).max(20);
const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('mettre'), chemin, valeur: z.unknown() }),
  z.object({ op: z.literal('retirer'), chemin }),
  z.object({ op: z.literal('liste'), chemin, maj: z.array(z.record(z.unknown())).max(20000).optional(), retirer: z.array(z.string().max(200)).max(20000).optional(), ordre: z.array(z.string().max(200)).max(50000).optional() }),
]);
const differences = z.object({ baseRevision: z.number().int().min(0), operations: z.array(operation).min(1).max(5000) });
export const patchEspaceSchema = z.object({ body: differences });
export const putConfigSchema = z.object({ body: z.object({ data: document }) });

export const membreParamsSchema = z.object({ params: z.object({ id: z.string().min(1) }) });
export const patchMembreSchema = membreParamsSchema.extend({ body: z.object({ role: z.enum(['ADMIN', 'UTILISATEUR']) }) });

export const assistantSchema = z.object({
  body: z.object({
    type: z.enum(['question', 'conversation', 'plan', 'relance', 'copilote', 'mails', 'lot', 'synthese', 'boucle', 'relecture', 'relecture_nouveau', 'ajustement', 'redaction', 'etiquettes', 'traduction', 'compte_rendu']),
    /** Pour « redaction » : ce qu'il faut faire du nouveau mail. */
    redaction: z.enum(['contexte', 'court', 'formel', 'refaire']).optional(),
    /** Pour « ajustement » : ce qu'il faut faire du brouillon. */
    ajustement: z.enum(['court', 'formel', 'decliner', 'refaire', 'contexte']).optional(),
    /** Pour « traduction » : la langue voulue. */
    langue: z.enum(['fr', 'en', 'pt']).optional(),
    /** Pour « lot » et « synthese » : le périmètre choisi, en clair (« les mails de @ovh.com en octobre »). */
    perimetre: z.string().max(300).optional(),
    ton: z.string().max(40).optional(),
    /** Le nom de l'app choisi par l'utilisateur, pour que l'IA se présente sous ce nom ; absent ou invalide = « Me ». */
    nom: z.string().max(100).optional(),
    /** Pour « mails » et « lot » : les consignes de l'utilisateur sur la façon d'analyser (angle, priorités, ce qu'il cherche). */
    consignes: z.string().max(1000).optional(),
    donnees: z.string().max(200_000).optional(),
    question: z.string().max(2000).optional(),
    /** Pour « conversation » : les derniers échanges, du plus ancien au plus récent. */
    historique: z.array(z.object({ q: z.string().max(2000), r: z.string().max(4000) })).max(6).optional(),
    heure: z.string().max(20).optional(),
    contact: z.string().max(200).optional(),
    sujet: z.string().max(1000).optional(),
    boite: z.enum(['perso', 'pro']).optional(),
    /** Pour « relance » : la note de l'utilisateur sur la relance, et combien de fois la personne a déjà été relancée. */
    note: z.string().max(1000).optional(),
    deja: z.number().int().min(0).max(50).optional(),
  }),
});
/**
 * Ce que l'app sait des relances, tâches et projets de l'utilisateur pour analyser ses mails (voir analyses/regles.ts).
 * Ce contexte aide l'IA, il ne doit jamais empêcher l'analyse : un texte trop long est coupé, une liste trop longue est raccourcie
 * et un élément inutilisable est ignoré, au lieu de refuser toute la demande (un identifiant de tâche importée de To Do fait plus de 150 caractères).
 */
const coupe = (max: number) => z.string().transform((s) => s.slice(0, max));
/** La ref d'une relance ou d'un projet est rendue telle quelle par l'IA puis relue par l'app : on ne la coupe pas, un élément à la ref démesurée est ignoré. */
const refCrm = z.string().min(1).max(500);
const liste = <T extends z.ZodTypeAny>(element: T, max: number) =>
  z
    .array(z.unknown())
    .optional()
    .transform((xs) => (xs ?? []).flatMap((x) => {
      const r = element.safeParse(x);
      return r.success ? [r.data as z.output<T>] : [];
    }).slice(0, max));
const contexteCrm = z.object({
  relances: liste(z.object({ ref: refCrm, contact: coupe(200), sujet: coupe(300), depuis: coupe(10) }), 30),
  // L'IA ne rend jamais la ref d'une tâche (elle sert seulement à ne pas en reproposer une) : une ref courte suffit et épargne des jetons.
  taches: liste(z.object({ ref: z.string(), titre: coupe(300), echeance: z.string().nullish().transform((e) => (e ? e.slice(0, 10) : null)) }), 40).transform((ts) => ts.map((t, i) => ({ ...t, ref: `t:${i + 1}` }))),
  projets: liste(z.object({ ref: refCrm, nom: coupe(200) }), 30),
});
/** L'analyse de mails que le serveur lit lui-même : `mails` sont des références `ext:<compte connecté>:<mail>`, dix au plus. */
export const analyseMailsSchema = z.object({
  body: z.object({
    mails: z.array(z.string().min(1).max(500)).min(1, 'Aucun mail à analyser.').max(10, 'Dix mails au plus par demande.'),
    ton: z.string().max(40).optional(),
    consignes: z.string().max(1000).optional(),
    crm: contexteCrm.optional(),
  }),
});
export type AnalyseMailsBody = z.infer<typeof analyseMailsSchema>['body'];

/** Comprendre une boucle de mails : le mail ouvert (`ext:<compte>:<mail>`), le ton et les consignes. */
export const analyseBoucleSchema = z.object({ body: z.object({ mail: z.string().min(1).max(500), ton: z.string().max(40).optional(), consignes: z.string().max(1000).optional() }) });
export type AnalyseBoucleBody = z.infer<typeof analyseBoucleSchema>['body'];

/** Relire une réponse avant son envoi : le mail auquel elle répond, et le brouillon. */
export const relireReponseSchema = z.object({ body: z.object({ mail: z.string().min(1).max(500), reponse: z.string().trim().min(1).max(8000), ton: z.string().max(40).optional(), consignes: z.string().max(1000).optional() }) });
export type RelireReponseBody = z.infer<typeof relireReponseSchema>['body'];

/** Ajuster une réponse : le mail, le brouillon, et ce qu'il faut en faire. Avec un contexte, le brouillon peut être vide. */
export const ajusterReponseSchema = z.object({
  body: z
    .object({ mail: z.string().min(1).max(500), reponse: z.string().trim().max(8000).optional(), action: z.enum(['court', 'formel', 'decliner', 'refaire', 'contexte']), contexte: z.string().trim().max(2000).optional(), ton: z.string().max(40).optional(), consignes: z.string().max(1000).optional() })
    .refine((b) => (b.action === 'contexte' ? !!b.contexte : !!b.reponse), { message: 'Rien à rédiger.' }),
});
export type AjusterReponseBody = z.infer<typeof ajusterReponseSchema>['body'];

const nouveauMail = { a: z.string().max(5000).optional(), sujet: z.string().max(500).optional(), boite: z.enum(['perso', 'pro']).optional(), ton: z.string().max(40).optional(), consignes: z.string().max(1000).optional() };
/** Écrire un nouveau mail avec le copilote. Avec un contexte, le brouillon peut être vide. */
export const redigerMailSchema = z.object({
  body: z
    .object({ ...nouveauMail, texte: z.string().trim().max(8000).optional(), action: z.enum(['contexte', 'court', 'formel', 'refaire']), contexte: z.string().trim().max(2000).optional() })
    .refine((b) => (b.action === 'contexte' ? !!b.contexte : !!b.texte), { message: 'Rien à rédiger.' }),
});
export type RedigerMailBody = z.infer<typeof redigerMailSchema>['body'];
/** Relire un nouveau mail avant de l'envoyer. */
export const relireNouveauSchema = z.object({ body: z.object({ ...nouveauMail, texte: z.string().trim().min(1).max(8000) }) });
export type RelireNouveauBody = z.infer<typeof relireNouveauSchema>['body'];

/** Proposer des étiquettes : le mail, celles du compte, et celles qu'il porte déjà. */
export const proposerEtiquettesSchema = z.object({ body: z.object({ mail: z.string().min(1).max(500), existantes: z.array(z.string().min(1).max(200)).max(200), posees: z.array(z.string().min(1).max(200)).max(50) }) });
export type ProposerEtiquettesBody = z.infer<typeof proposerEtiquettesSchema>['body'];

/** Ce qui est déjà analysé parmi les mails affichés. */
export const etatsAnalyseSchema = z.object({ body: z.object({ mails: z.array(z.string().min(1).max(500)).max(300) }) });

/** Traduire des textes : assez peu à la fois pour que la réponse de l'IA tienne entière. */
export const MAX_TRADUCTION = 16_000;
export const traduireSchema = z.object({
  body: z.object({
    langue: z.enum(['fr', 'en', 'pt']),
    textes: z
      .array(z.string().min(1).max(MAX_TRADUCTION))
      .min(1)
      .max(60)
      .refine((l) => l.reduce((n, t) => n + t.length, 0) <= MAX_TRADUCTION, 'Trop de texte à traduire d’un coup.'),
  }),
});

/** Lecture d'un justificatif par l'IA : son identifiant Cloudinary, et de quoi bien lire (date du jour, devise, catégories). */
export const analyseJustificatifSchema = z.object({
  body: z.object({
    id: z.string().trim().min(1).max(300),
    aujourdhui: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date du jour attendue (AAAA-MM-JJ)'),
    devise: z.string().trim().min(1).max(8).default('USD'),
    categories: z.array(z.object({ id: z.string().min(1).max(80), nom: z.string().trim().min(1).max(80) })).max(80).default([]),
  }),
});
export type AnalyseJustificatifBody = z.infer<typeof analyseJustificatifSchema>['body'];

export type AssistantBody = z.infer<typeof assistantSchema>['body'];

export const integrationParamsSchema = z.object({ params: z.object({ id: z.string().min(1) }) });
export const patchIntegrationSchema = integrationParamsSchema.extend({
  body: z
    .object({
      ctx: z.enum(['perso', 'pro']).optional(),
      agendas: z.array(z.string().min(1).max(300)).max(50).optional(),
      boitesPartagees: z.array(z.string().trim().email('Adresse de boîte partagée invalide.').max(320)).max(10, 'Dix boîtes partagées au plus.').optional(),
      chargement: z.object({ jours: z.number().int().min(1).max(90).optional(), max: z.number().int().min(10).max(100).optional() }).optional(),
      signatures: z.array(z.object({ id: z.string().min(1).max(40), nom: z.string().trim().min(1).max(60), texte: z.string().trim().min(1, 'Écris le texte de la signature.').max(2000) })).max(10, 'Dix signatures au plus.').optional(),
      signatureDefaut: z.string().max(40).nullable().optional(),
      analyseAuto: z.boolean().optional(),
    })
    .refine((b) => b.ctx !== undefined || b.agendas !== undefined || b.boitesPartagees !== undefined || b.chargement !== undefined || b.analyseAuto !== undefined || b.signatures !== undefined || b.signatureDefaut !== undefined, { message: 'Rien à modifier : donne « ctx », « agendas », « boitesPartagees », « chargement » ou « analyseAuto ».' }),
});

const DATE_TXT = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.');
const HEURE_TXT = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure attendue au format HH:MM.');
const rendezvous = {
  agendaId: z.string().min(1).max(300),
  titre: z.string().min(1).max(300),
  date: DATE_TXT,
  debut: HEURE_TXT.optional(),
  fin: HEURE_TXT.optional(),
  lieu: z.string().max(300).optional(),
  journee: z.boolean().optional(),
};

export const repondreMailSchema = integrationParamsSchema.extend({ body: z.object({ mail: z.string().min(1).max(500), /** Le fil du mail : il peut avoir changé de dernier message depuis l'ouverture. */ fil: z.string().max(500).optional(), texte: z.string().min(1, 'Écris ta réponse avant de l’envoyer.').max(20_000), /** Les destinataires choisis ; absents, la réponse va à toutes les personnes du mail. */ a: z.array(z.string().min(3).max(320)).min(1).max(50).optional(), cc: z.array(z.string().min(3).max(320)).max(50).optional(), /** La signature choisie ; `null` : aucune ; absente : celle par défaut. */ signature: z.string().max(40).nullable().optional() }) });
export const lireMailSchema = z.object({ params: z.object({ id: z.string().min(1), mail: z.string().min(1).max(500) }) });
/** `lu=0` : lire sans marquer comme lu (analyse des mails par le copilote). */
export const lireMailQuerySchema = lireMailSchema.extend({ query: z.object({ lu: z.enum(['0', '1']).optional() }).passthrough() });
const libelle = z.string().trim().min(1).max(100, 'Une étiquette tient en 100 caractères.');
const boiteQuery = z.string().trim().email().max(320).optional();
export const dossiersSchema = integrationParamsSchema.extend({ query: z.object({ boite: boiteQuery }).passthrough() });
export const mailsDossierSchema = z.object({ params: z.object({ id: z.string().min(1), dossier: z.string().min(1).max(500) }), query: z.object({ boite: boiteQuery, suivant: z.string().max(2000).optional() }).passthrough() });
const jourQuery = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.').optional();
/** Chercher les mails d'un lot à analyser : au moins un critère (personne, domaine, dossier, boîte, période, non lus, pièce jointe ou objet). */
export const personnesSchema = z.object({ query: z.object({ q: z.string().trim().min(2).max(100) }).passthrough() });
export const chercherMailsSchema = integrationParamsSchema.extend({
  query: z
    .object({ de: z.string().max(320).optional(), domaine: z.string().max(253).optional(), dossier: z.string().max(500).optional(), boite: boiteQuery, depuis: jourQuery, jusqua: jourQuery, nonLus: z.enum(['1']).optional(), pj: z.enum(['1']).optional(), objet: z.string().trim().max(200).optional(), suivant: z.string().max(2000).optional(), max: z.string().regex(/^\d{1,3}$/).optional() })
    .passthrough()
    .refine((q) => !!(q.de || q.domaine || q.dossier || q.boite || q.depuis || q.jusqua || q.nonLus || q.pj || q.objet), { message: 'Choisis au moins une personne, un domaine, un dossier, une boîte, une période ou un filtre.' }),
});
export const filMailSchema = z.object({ params: z.object({ id: z.string().min(1), fil: z.string().min(1).max(500) }) });
export const trierMailsSchema = z.object({ params: z.object({ id: z.string().min(1) }), body: z.object({ action: z.enum(['lu', 'archiver']), mails: z.array(z.string().min(1).max(500)).min(1).max(100) }) });
export const deplacerMailSchema = lireMailSchema.extend({ body: z.object({ dossier: z.string().min(1).max(500), depuis: z.string().min(1).max(500).optional() }) });
export const activerRegleSchema = z.object({ params: z.object({ id: z.string().min(1), regle: z.string().min(1).max(500) }), body: z.object({ active: z.boolean() }) });
export const etiqueterMailSchema = lireMailSchema.extend({
  body: z
    .object({ ajouter: z.array(libelle).max(10).optional(), retirer: z.array(libelle).max(10).optional() })
    .refine((b) => (b.ajouter?.length ?? 0) + (b.retirer?.length ?? 0) > 0, { message: 'Choisis une étiquette à poser ou à retirer.' }),
});
export const envoyerMailSchema = integrationParamsSchema.extend({
  body: z.object({ signature: z.string().max(40).nullable().optional(), a: z.string().min(3, 'Indique à qui envoyer ce mail.').max(5000), cc: z.string().max(5000).optional(), sujet: z.string().max(500).optional(), texte: z.string().min(1, 'Écris ton message avant de l’envoyer.').max(20_000) }),
});
export const creerEvenementSchema = integrationParamsSchema.extend({ body: z.object(rendezvous) });
export const modifierEvenementSchema = integrationParamsSchema.extend({ body: z.object({ ...rendezvous, id: z.string().min(1).max(500) }) });
export const supprimerEvenementSchema = integrationParamsSchema.extend({ body: z.object({ agendaId: z.string().min(1).max(300), id: z.string().min(1).max(500) }) });
export const creerTacheSchema = integrationParamsSchema.extend({ body: z.object({ listeId: z.string().min(1).max(300), titre: z.string().min(1).max(300), echeance: DATE_TXT.nullish() }) });
export const majTacheSchema = integrationParamsSchema.extend({ body: z.object({ listeId: z.string().min(1).max(300), id: z.string().min(1).max(500), titre: z.string().min(1).max(300), echeance: DATE_TXT.nullish(), fait: z.boolean().optional() }) });
export const trelloJetonSchema = z.object({ body: z.object({ state: z.string().max(2000).optional(), token: z.string().max(500).nullable().optional() }) });
export const notificationsLuesSchema = z.object({ body: z.object({ ids: z.array(z.string()).max(200).optional() }).optional() });

const endpoint = z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'Adresse push invalide.');
export const pushAbonnementSchema = z.object({
  body: z.object({ endpoint, keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }), appareil: z.string().max(120).optional() }),
});
export const pushDesabonnementSchema = z.object({ body: z.object({ endpoint }) });

// Équipes : un espace partagé entre plusieurs comptes, avec un rôle par membre (voir services/equipes/droits.ts).
const nomEquipe = z.string({ required_error: "Nom de l'équipe requis" }).trim().min(1, "Nom de l'équipe requis").max(60);
const emojiEquipe = z.string().trim().max(8).optional();
const roleEquipe = z.enum(['PROPRIETAIRE', 'MEMBRE', 'LECTEUR'], { required_error: 'Rôle requis', invalid_type_error: 'Rôle inconnu' });
const equipeParams = z.object({ id: z.string().min(1) });

export const equipeParamsSchema = z.object({ params: equipeParams });
export const creerEquipeSchema = z.object({ body: z.object({ nom: nomEquipe, emoji: emojiEquipe }) });
export const patchEquipeSchema = z.object({ params: equipeParams, body: z.object({ nom: nomEquipe.optional(), emoji: emojiEquipe }) });
export const inviterEquipeSchema = z.object({ params: equipeParams, body: z.object({ email, role: roleEquipe }) });
export const invitationParamsSchema = z.object({ params: equipeParams.extend({ invitationId: z.string().min(1) }) });
export const jetonInvitationSchema = z.object({ body: z.object({ jeton }) });
export const equipeMembreParamsSchema = z.object({ params: equipeParams.extend({ membreId: z.string().min(1) }) });
export const roleMembreSchema = z.object({ params: equipeParams.extend({ membreId: z.string().min(1) }), body: z.object({ role: roleEquipe }) });
export const putEspaceEquipeSchema = z.object({ params: equipeParams, body: z.object({ data: document, baseRevision: z.number().int().min(0).optional() }) });
export const patchEspaceEquipeSchema = z.object({ params: equipeParams, body: differences });

/** S'abonner : la case des CGV et la demande d'accès immédiat (droit de rétractation) sont obligatoires. */
export const paiementSchema = z.object({
  body: z.object({
    periode: z.enum(['mensuel', 'annuel'], { errorMap: () => ({ message: 'Choisis mensuel ou annuel.' }) }),
    /** Absente pour les anciennes versions de l'app, qui ne vendaient que Pro. */
    formule: z.enum(['finances', 'pro'], { errorMap: () => ({ message: 'Choisis la formule Finances ou Pro.' }) }).default('pro'),
    /** Palier de réunions de Pro (0 à 3) : son prix s'ajoute à celui de Pro. */
    palier: z.number().int().min(0).max(3).default(0),
    telephone: z.string({ required_error: 'Numéro de téléphone requis' }).trim().min(8, 'Numéro de téléphone requis').max(20),
    accepteCgv: z.literal(true, { errorMap: () => ({ message: 'Accepte les conditions générales de vente pour continuer.' }) }),
    accesImmediat: z.literal(true, { errorMap: () => ({ message: "Demande l'accès immédiat à ta formule pour continuer." }) }),
  }),
});
export const referencePaiementSchema = z.object({ params: z.object({ reference: z.string().regex(/^[A-Z0-9]{6,40}$/, 'Référence invalide') }) });
export const smsTelephoneSchema = z.object({ body: z.object({ telephone: z.string({ required_error: 'Numéro requis' }).trim().min(8, 'Numéro requis').max(20) }) });
export const numeroAutoriseSchema = z.object({ body: z.object({ indicatif: z.string().regex(/^[1-9]\d{0,3}$/, 'Indicatif invalide'), numero: z.string().regex(/^\d{0,14}$/, 'Numéro invalide').default('') }) });
export const numeroAutoriseParamsSchema = z.object({ params: z.object({ id: z.string().min(1) }) });
export const smsCodeSchema = z.object({ body: z.object({ code: z.string({ required_error: 'Code requis' }).trim().regex(/^\d{3,10}$/, 'Code invalide') }) });
export const gestionMembresSchema = z.object({
  query: z.object({
    filtre: z.enum(['tous', 'abonnes', 'essai', 'sans', 'expirent', 'anciens']).default('tous'),
    q: z.string().trim().max(120).default(''),
    page: z.coerce.number().int().min(1).default(1),
  }),
});
const noteAdmin = z.string().trim().max(300).optional();
export const actionAbonnementSchema = membreParamsSchema.extend({
  body: z.discriminatedUnion('action', [
    z.object({ action: z.literal('offrir'), formule: z.enum(['finances', 'pro']), palier: z.number().int().min(0).max(3).default(0), mois: z.number().int().min(1).max(24), note: noteAdmin }),
    z.object({ action: z.literal('essai'), jours: z.number().int().min(1).max(90), note: noteAdmin }),
    z.object({ action: z.literal('retirer'), note: noteAdmin }),
  ]),
});
