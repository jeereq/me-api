import './loadEnv.js';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';

import assistantRoutes from './routes/assistant.routes.js';
import authRoutes from './routes/auth.routes.js';
import configRoutes from './routes/config.routes.js';
import espaceRoutes from './routes/espace.routes.js';
import membreRoutes from './routes/membre.routes.js';
import { initRappelsCron } from './cron/rappels.js';
import { initSynchronisationCron } from './cron/synchronisation.js';
import integrationRoutes from './routes/integration.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import syncRoutes from './routes/sync.routes.js';
import { HttpError } from './utils/http.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET doit être défini (32 caractères minimum) : sans lui, les sessions seraient signées avec une clé devinable.');
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
// L'app mobile n'envoie pas d'en-tête Origin ; seules les origines web listées sont acceptées.
app.use(cors({ origin: (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean), methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api/auth', authRoutes);
app.use('/api/espace', espaceRoutes);
app.use('/api/config', configRoutes);
app.use('/api/membres', membreRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/notifications', notificationRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
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
  res.status(500).json({ error: 'Erreur serveur' });
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`me-api écoute sur le port ${port}`);
  initSynchronisationCron();
  initRappelsCron();
});
