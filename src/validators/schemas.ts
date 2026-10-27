import { z } from 'zod';

const email = z.string({ required_error: 'Email requis' }).trim().toLowerCase().email('Email invalide');
const password = z.string({ required_error: 'Mot de passe requis' }).min(8, 'Le mot de passe doit faire au moins 8 caractères').max(200);

export const registerSchema = z.object({ body: z.object({ email, password, nom: z.string().trim().max(80).optional() }) });
export const loginSchema = z.object({ body: z.object({ email, password: z.string().min(1, 'Mot de passe requis') }) });
export const emailSchema = z.object({ body: z.object({ email }) });
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

export const updateMeSchema = z.object({
  body: z.object({ nom: z.string().trim().max(80).optional(), fuseau: z.string().max(60).refine(fuseauValide, 'Fuseau horaire inconnu').optional(), motDePasseActuel: z.string().optional(), nouveauMotDePasse: password.optional() }),
});

const document = z.record(z.unknown(), { invalid_type_error: 'Document JSON attendu' });
// baseRevision : la version de l'espace lue en dernier par l'appareil (absent pour les anciennes versions de l'app : la dernière écriture gagne).
export const putEspaceSchema = z.object({ body: z.object({ data: document, baseRevision: z.number().int().min(0).optional() }) });
export const putConfigSchema = z.object({ body: z.object({ data: document }) });

export const membreParamsSchema = z.object({ params: z.object({ id: z.string().min(1) }) });
export const patchMembreSchema = membreParamsSchema.extend({ body: z.object({ role: z.enum(['ADMIN', 'UTILISATEUR']) }) });

export const assistantSchema = z.object({
  body: z.object({
    type: z.enum(['question', 'plan', 'relance']),
    ton: z.string().max(40).optional(),
    donnees: z.string().max(200_000).optional(),
    question: z.string().max(2000).optional(),
    heure: z.string().max(20).optional(),
    contact: z.string().max(200).optional(),
    sujet: z.string().max(1000).optional(),
    boite: z.enum(['perso', 'pro']).optional(),
  }),
});
export type AssistantBody = z.infer<typeof assistantSchema>['body'];

export const integrationParamsSchema = z.object({ params: z.object({ id: z.string().min(1) }) });
export const patchIntegrationSchema = integrationParamsSchema.extend({
  body: z
    .object({
      ctx: z.enum(['perso', 'pro']).optional(),
      agendas: z.array(z.string().min(1).max(300)).max(50).optional(),
      boitesPartagees: z.array(z.string().trim().email('Adresse de boîte partagée invalide.').max(320)).max(10, 'Dix boîtes partagées au plus.').optional(),
    })
    .refine((b) => b.ctx !== undefined || b.agendas !== undefined || b.boitesPartagees !== undefined, { message: 'Rien à modifier : donne « ctx », « agendas » ou « boitesPartagees ».' }),
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

export const repondreMailSchema = integrationParamsSchema.extend({ body: z.object({ mail: z.string().min(1).max(500), texte: z.string().min(1, 'Écris ta réponse avant de l’envoyer.').max(20_000) }) });
export const lireMailSchema = z.object({ params: z.object({ id: z.string().min(1), mail: z.string().min(1).max(500) }) });
const libelle = z.string().trim().min(1).max(100, 'Une étiquette tient en 100 caractères.');
export const etiqueterMailSchema = lireMailSchema.extend({
  body: z
    .object({ ajouter: z.array(libelle).max(10).optional(), retirer: z.array(libelle).max(10).optional() })
    .refine((b) => (b.ajouter?.length ?? 0) + (b.retirer?.length ?? 0) > 0, { message: 'Choisis une étiquette à poser ou à retirer.' }),
});
export const envoyerMailSchema = integrationParamsSchema.extend({
  body: z.object({ a: z.string().min(3, 'Indique à qui envoyer ce mail.').max(5000), cc: z.string().max(5000).optional(), sujet: z.string().max(500).optional(), texte: z.string().min(1, 'Écris ton message avant de l’envoyer.').max(20_000) }),
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
