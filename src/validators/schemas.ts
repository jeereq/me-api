import { z } from 'zod';

const email = z.string({ required_error: 'Email requis' }).trim().toLowerCase().email('Email invalide');
const password = z.string({ required_error: 'Mot de passe requis' }).min(8, 'Le mot de passe doit faire au moins 8 caractères').max(200);

export const registerSchema = z.object({ body: z.object({ email, password, nom: z.string().trim().max(80).optional() }) });
export const loginSchema = z.object({ body: z.object({ email, password: z.string().min(1, 'Mot de passe requis') }) });
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
export const putEspaceSchema = z.object({ body: z.object({ data: document }) });
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
export const patchIntegrationSchema = integrationParamsSchema.extend({ body: z.object({ ctx: z.enum(['perso', 'pro']) }) });
export const trelloJetonSchema = z.object({ body: z.object({ state: z.string().max(2000).optional(), token: z.string().max(500).nullable().optional() }) });
export const notificationsLuesSchema = z.object({ body: z.object({ ids: z.array(z.string()).max(200).optional() }).optional() });
