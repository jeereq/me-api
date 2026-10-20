# me-api

Le backend de « me », ton assistant personnel. Il sert l'app mobile [me-mobile](https://github.com/jeereq/me-mobile) :

- **comptes** avec email et mot de passe, rôle `ADMIN` ou `UTILISATEUR` (le premier compte créé devient admin) ;
- **espace privé** par compte (relances, tâches, habitudes, contacts, journal, agenda, sources, audio), que seul son propriétaire lit et écrit ;
- **configuration système** lisible par tous les comptes, modifiable par les admins ;
- **gestion des comptes** pour les admins ;
- **assistant IA** : relais vers OpenAI, la clé API reste sur le serveur.

Stack : Node 20+, Express, TypeScript, Prisma et PostgreSQL, JWT, zod, helmet, express-rate-limit.

## Lancer en local

```bash
git clone https://github.com/jeereq/me-api.git
cd me-api
npm install
cp .env.example .env        # puis remplis DATABASE_URL, JWT_SECRET et OPENAI_API_KEY
npm run prisma:migrate      # crée les tables
npm run dev                 # http://localhost:4000/api/health
```

Pour générer `JWT_SECRET` : `openssl rand -hex 32`. Le serveur refuse de démarrer sans une clé d'au moins 32 caractères.

## Déployer (Render, Railway, Fly…)

- Build : `npm install && npm run build && npm run prisma:migrate:deploy`
- Start : `npm start`
- Variables : celles de `.env.example`.

Ensuite, dans l'app mobile, mets l'adresse du serveur dans `EXPO_PUBLIC_API_URL` (fichier `.env` de me-mobile).

## API

Toutes les routes sauf `health`, `register` et `login` demandent l'en-tête `Authorization: Bearer <token>`.

| Méthode | Route | Rôle | Effet |
| --- | --- | --- | --- |
| GET | `/api/health` | public | Le serveur répond |
| POST | `/api/auth/register` | public | `{ email, password, nom? }` → `{ token, user }` |
| POST | `/api/auth/login` | public | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | compte | Le compte connecté |
| PATCH | `/api/auth/me` | compte | `{ nom?, motDePasseActuel?, nouveauMotDePasse? }` |
| GET | `/api/espace` | compte | `{ espace: { data, majLe } \| null }` |
| PUT | `/api/espace` | compte | `{ data }` → `{ majLe }` |
| GET | `/api/config` | compte | `{ config }` |
| PUT | `/api/config` | admin | `{ data }` → `{ config }` |
| GET | `/api/membres` | admin | Liste des comptes |
| PATCH | `/api/membres/:id` | admin | `{ role: "ADMIN" \| "UTILISATEUR" }` |
| DELETE | `/api/membres/:id` | admin | Supprime le compte et son espace |
| GET | `/api/assistant` | compte | `{ disponible }` : clé configurée et IA activée par l'admin |
| GET | `/api/assistant/modeles` | admin | `{ modeles, actuel }` : modèles OpenAI disponibles avec la clé du serveur |
| POST | `/api/assistant` | compte | `{ type: "question" \| "plan" \| "relance", … }` → `{ text }` |

Les erreurs ont la forme `{ "error": "message lisible" }`.

Règles :

- `SIGNUP_OPEN=false` ferme les inscriptions une fois le premier compte créé ; l'admin crée alors les comptes à la main ou les rouvre.
- Le modèle OpenAI se choisit dans l'app (Configuration, réservé à l'admin) ; sans choix, c'est `OPENAI_MODEL`, puis `gpt-4o-mini`.
- Le dernier admin ne peut être ni rétrogradé ni supprimé.
- Pour nommer un admin depuis le serveur : `npm run promote:admin -- email@exemple.com`.
- Limites : 10 connexions ratées par 15 min et par email, 30 demandes à l'IA par 10 min et par compte.

## Organisation

```
prisma/schema.prisma     modèles User, Espace, Config
src/app.ts               serveur Express et gestion des erreurs
src/routes/              une route par domaine
src/controllers/         lecture de la requête, réponse HTTP
src/services/            logique métier et accès à la base
src/middlewares/         JWT, rôle admin, validation zod, limites de débit
src/validators/          schémas zod
```

## Prochaines étapes

Connexion des comptes externes (Google Agenda et Gmail, Outlook, Trello, Slack) en OAuth côté serveur, synchronisation planifiée, et envoi des rappels par notification push depuis le serveur.
