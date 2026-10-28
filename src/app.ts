import './loadEnv.js';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';

import abonnementRoutes from './routes/abonnement.routes.js';
import assistantRoutes from './routes/assistant.routes.js';
import authRoutes from './routes/auth.routes.js';
import configRoutes from './routes/config.routes.js';
import equipeRoutes from './routes/equipe.routes.js';
import espaceRoutes from './routes/espace.routes.js';
import membreRoutes from './routes/membre.routes.js';
import { initRappelsCron } from './cron/rappels.js';
import { initJustificatifsCron } from './cron/justificatifs.js';
import { initSynchronisationCron } from './cron/synchronisation.js';
import integrationRoutes from './routes/integration.routes.js';
import justificatifRoutes from './routes/justificatif.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import syncRoutes from './routes/sync.routes.js';
import { assurerAdmin } from './services/AdminSeed.js';
import { HttpError } from './utils/http.js';
import { messagePrisma, prisma } from './utils/prisma.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET doit être défini (32 caractères minimum) : sans lui, les sessions seraient signées avec une clé devinable.');
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
// L'app mobile n'envoie pas d'en-tête Origin ; seules les origines web listées sont acceptées.
app.use(cors({ origin: (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean), methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
// L'envoi complet d'un espace (première synchro, ancienne version de l'app) peut dépasser 2 Mo ; les synchros suivantes
// n'envoient que les différences (PATCH), bien plus légères.
app.use(['/api/espace', '/api/equipes/:id/espace'], express.json({ limit: '10mb' }));
app.use(express.json({ limit: '2mb' }));

// Vérifie aussi la base : ouvrir /api/health dans un navigateur dit si elle répond et si les tables existent.
app.get('/api/health', async (_req, res) => {
  try {
    await prisma.user.count();
    res.json({ ok: true, base: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(503).json({ ok: false, base: messagePrisma(err) ?? 'erreur inconnue, voir les logs du serveur' });
  }
});
app.use('/api/auth', authRoutes);
app.use('/api/espace', espaceRoutes);
app.use('/api/equipes', equipeRoutes);
app.use('/api/config', configRoutes);
app.use('/api/membres', membreRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/abonnement', abonnementRoutes);
app.use('/api/justificatifs', justificatifRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json(err.code ? { error: err.message, code: err.code } : { error: err.message });
    return;
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Données trop volumineuses.' });
    return;
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON invalide.' });
    return;
  }
  console.error(err);
  const base = messagePrisma(err);
  res.status(base ? 503 : 500).json({ error: base ?? 'Erreur serveur' });
});

const port = Number(process.env.PORT) || 4000;
// Le compte admin des variables d'environnement est prêt avant d'accepter des connexions.
await assurerAdmin();

app.listen(port, () => {
  console.log(`me-api écoute sur le port ${port}`);
  // RUN_CRONS=false : cette instance ne fait que répondre aux requêtes (les tâches planifiées tournent sur une autre).
  if (process.env.RUN_CRONS?.trim().toLowerCase() === 'false') {
    console.log('Tâches planifiées désactivées sur cette instance (RUN_CRONS=false).');
    return;
  }
  initSynchronisationCron();
  initRappelsCron();
  initJustificatifsCron();
});
