# me-api

Le backend de « me », ton assistant personnel. Il sert l'app mobile [me-mobile](https://github.com/jeereq/me-mobile) :

- **comptes** avec email et mot de passe, rôle `ADMIN` ou `UTILISATEUR` (le premier compte créé devient admin) ;
- **espace privé** par compte (relances, tâches, habitudes, contacts, journal, agenda, sources, audio), que seul son propriétaire lit et écrit ;
- **configuration système** lisible par tous les comptes, modifiable par les admins ;
- **gestion des comptes** pour les admins ;
- **assistant IA** : relais vers OpenAI, la clé API reste sur le serveur ;
- **rappels** : calculés par le serveur selon le mode de chaque élément, visibles dans l'app et envoyés par email avec SendGrid ;
- **comptes connectés** : Google Agenda et Gmail, Outlook et Microsoft To Do, Trello, Slack, synchronisés toutes les 15 minutes.

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
- Start : `npm start` (applique aussi les migrations en attente avant de lancer le serveur)
- Pour vérifier : ouvre `https://ton-serveur/api/health`. `{"ok":true,"base":"ok"}` veut dire que la base répond et que ses tables existent ; sinon, le message dit quoi corriger.
- Variables : celles de `.env.example`.

Ensuite, dans l'app mobile, mets l'adresse du serveur dans `EXPO_PUBLIC_API_URL` (fichier `.env` de me-mobile).

## API

Toutes les routes sauf `health` et les routes publiques de `/api/auth` demandent l'en-tête `Authorization: Bearer <token>`.

| Méthode | Route | Rôle | Effet |
| --- | --- | --- | --- |
| GET | `/api/health` | public | Le serveur répond |
| GET | `/api/auth/options` | public | `{ google, email }` : connexion Google et emails de compte disponibles |
| POST | `/api/auth/register` | public | `{ email, password, nom? }` → `{ token, user }`, ou `{ verification: true, email }` si l'email doit être confirmé |
| POST | `/api/auth/login` | public | `{ email, password }` → `{ token, user }` ; 403 `EMAIL_NON_VERIFIE` tant que l'email n'est pas confirmé |
| POST | `/api/auth/verifier` | public | `{ jeton }` (lien reçu par email) → `{ token, user }` |
| POST | `/api/auth/verifier/renvoyer` | public | `{ email }` : renvoie le lien de confirmation |
| POST | `/api/auth/oubli` | public | `{ email }` : envoie un lien de réinitialisation (1 h) |
| POST | `/api/auth/reinitialiser` | public | `{ jeton, password }` → `{ token, user }` ; ferme les autres sessions |
| GET | `/api/auth/google/debut?retour=` | public | Redirige vers Google ; au retour, l'app reçoit `?google=<code>` (ou `?erreur_google=`) |
| POST | `/api/auth/google/echange` | public | `{ code }` → `{ token, user }` |
| GET | `/api/auth/me` | compte | Le compte connecté (`motDePasse`, `google` : modes de connexion) |
| PATCH | `/api/auth/me` | compte | `{ nom?, motDePasseActuel?, nouveauMotDePasse? }` ; un changement de mot de passe renvoie un nouveau `token` |
| GET | `/api/auth/me/export` | compte | Toutes les données du compte en JSON (espace, comptes connectés sans leurs jetons, notifications) |
| POST | `/api/auth/me/deconnecter-tout` | compte | Ferme les sessions de tous les appareils → nouveau `{ token, user }` pour celui-ci |
| DELETE | `/api/auth/me` | compte | `{ confirmation: email }` : supprime le compte et toutes ses données |
| GET | `/api/espace` | compte | `{ espace: { data, majLe } \| null }` |
| PUT | `/api/espace` | compte | `{ data }` → `{ majLe }` |
| GET | `/api/config` | compte | `{ config }` |
| PUT | `/api/config` | admin | `{ data }` → `{ config }` |
| GET | `/api/membres` | admin | Liste des comptes |
| PATCH | `/api/membres/:id` | admin | `{ role: "ADMIN" \| "UTILISATEUR" }` |
| DELETE | `/api/membres/:id` | admin | Supprime le compte et son espace |
| GET | `/api/assistant` | compte | `{ disponible }` : clé configurée et IA activée par l'admin |
| GET | `/api/assistant/modeles` | admin | `{ modeles, actuel }` : modèles OpenAI disponibles avec la clé du serveur |
| GET | `/api/integrations` | compte | Services configurés sur le serveur et comptes connectés |
| GET | `/api/integrations/:service/connecter?retour=` | compte | `{ url }` de la page d'autorisation (google, microsoft, trello, slack) |
| PATCH | `/api/integrations/:id` | compte | `{ ctx: "perso" \| "pro" }` |
| DELETE | `/api/integrations/:id` | compte | Déconnecte le compte et oublie ses jetons |
| GET | `/api/sync` | compte | Éléments importés : `{ integrations, agenda, taches, relances }` |
| POST | `/api/sync` | compte | Relit tous les comptes tout de suite, puis comme GET |
| GET | `/api/notifications` | compte | 50 derniers rappels et nombre de non lus |
| POST | `/api/notifications/lues` | compte | `{ ids? }` : marque lus (tous sans `ids`) |
| GET | `/api/notifications/push` | compte | Clé publique VAPID et nombre d'appareils abonnés |
| POST | `/api/notifications/push` | compte | Abonne ce navigateur aux notifications push |
| DELETE | `/api/notifications/push` | compte | Désabonne ce navigateur |
| POST | `/api/notifications/test` | compte | Envoie un rappel d'essai dans l'app et par email |
| POST | `/api/assistant` | compte | `{ type: "question" \| "plan" \| "relance", … }` → `{ text }` |

Les erreurs ont la forme `{ "error": "message lisible" }`.

Règles :

- **Compte admin principal** : `ADMIN_EMAIL` et `ADMIN_PASSWORD` créent ce compte au démarrage, toujours admin. Changer `ADMIN_PASSWORD` puis redémarrer remplace son mot de passe. Sans ces variables, le premier compte inscrit devient admin.
- `SIGNUP_OPEN=false` ferme les inscriptions une fois le premier compte créé ; l'admin crée alors les comptes à la main ou les rouvre.
- Le modèle OpenAI se choisit dans l'app (Configuration, réservé à l'admin) ; sans choix, c'est `OPENAI_MODEL`, puis `gpt-4o-mini`.
- Le dernier admin ne peut être ni rétrogradé ni supprimé.
- Pour nommer un admin depuis le serveur : `npm run promote:admin -- email@exemple.com`.
- Limites : 10 connexions ratées par 15 min et par email, 30 demandes à l'IA par 10 min et par compte.

## Comptes : Google, confirmation, mot de passe oublié

- **Confirmation de l'email** : si SendGrid et l'adresse de l'app (`APP_URL`) sont configurés, un nouveau compte reçoit un lien (valable 24 h) et ne peut se connecter qu'après l'avoir ouvert. Sinon, le compte est actif tout de suite. Les comptes créés avant cette version sont considérés comme confirmés.
- **Mot de passe oublié** : lien valable 1 h, à usage unique ; le nouveau mot de passe ferme toutes les autres sessions. Les demandes répondent pareil que l'email ait un compte ou non.
- **Continuer avec Google** : utilise le même client OAuth que les sources Google (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL`), avec seulement `openid email profile`. Ajoute l'URI de redirection `{PUBLIC_URL}/api/auth/google/callback` dans la console Google. Un compte existant avec la même adresse est relié (s'il n'avait jamais été confirmé, son mot de passe est retiré, par sécurité).
- Les liens des emails et le retour de Google pointent vers `APP_URL` (sinon la première adresse https d'`APP_REDIRECT_URLS`). Seule l'empreinte des jetons est gardée en base.

## Rappels (app et email)

Toutes les 5 minutes, le serveur calcule les rappels de chaque compte dans son fuseau horaire, avec les mêmes règles que l'app : briefing du matin, mode normal le jour J à 9 h, agressif à J-3, J-1, matin et soir puis chaque jour de retard, coach le soir, bilan hebdo le dimanche soir. Le mode passif n'envoie rien.

- Avec les récompenses (réglage « Mission et série » dans Mon compte, actif par défaut), le briefing du matin annonce la mission du jour : nombre d'actions, points à gagner, série à tenir. À l'heure du rappel du soir, un coup de pouce part seulement s'il sert : série en danger (aucun point aujourd'hui), mission pas commencée, ou journée parfaite à 3 actions près.
- Avec des budgets (Plus › Finances dans l'app), le briefing du matin donne le **budget du jour**, et à l'heure choisie (par défaut celle du rappel du soir) partent les **alertes de prévision** : budget du jour dépassé, puis, pour la semaine, le mois, le trimestre et l'année, « à ce rythme le budget sera dépassé » et « budget dépassé ». Chaque alerte part une seule fois par période et par niveau. Horizons, seuil (80 %, 90 % ou 100 % de la prévision), heure, push et email se règlent dans l'app.
- Chaque rappel apparaît dans le centre de notifications de l'app (cloche), une seule fois.
- Si SendGrid est configuré (`SENDGRID_API_KEY`, `SENDGRID_FROM`) et que l'admin n'a pas coupé le canal « Mail à moi-même », les rappels d'un même passage partent en un seul email.
- Si les clés VAPID sont configurées (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, générées par `npx web-push generate-vapid-keys`), chaque appareil activé dans l'app reçoit aussi une notification push, même app fermée. Sur iPhone, il faut l'app web ajoutée à l'écran d'accueil (iOS 16.4 ou plus).
- Chacun peut couper les emails ou les notifications dans l'app (Mon compte > Notifications).

## Comptes connectés

Chaque compte me peut connecter plusieurs comptes externes (par exemple Gmail perso et Google Workspace pro), depuis l'écran **Agendas & outils** de l'app. Le serveur garde les jetons chiffrés et relit les comptes toutes les 15 minutes.

| Service | Agenda | Tâches | Relances |
| --- | --- | --- | --- |
| Google | Rendez-vous des 14 prochains jours (agendas affichés, ou ceux du filtre) | Mails suivis (étoile) des 30 derniers jours | Fils où ton dernier message attend une réponse depuis plus de N jours |
| Microsoft | Rendez-vous des 14 prochains jours (agenda principal, ou ceux du filtre) | Mails avec drapeau, tâches To Do ouvertes | Mails envoyés sans réponse depuis plus de N jours |
| Trello | Échéances des 14 prochains jours | Cartes où tu es membre, non terminées | |
| Slack | | Messages des derniers jours qui te mentionnent ou t'écrivent en direct | Tes questions restées sans réponse dans leur fil |

N est le « délai avant relance » de la configuration système (3 jours par défaut). Les filtres et les types d'import se règlent par source dans l'app.

Pour activer un service, crée son application OAuth (les étapes sont dans `.env.example`), remplis ses variables, `PUBLIC_URL` et `ENCRYPTION_KEY`, puis redémarre. Le bouton « Connecter » apparaît alors dans l'app.

## Organisation

```
prisma/schema.prisma     modèles User, Espace, Config, Integration
src/app.ts               serveur Express et gestion des erreurs
src/routes/              une route par domaine
src/controllers/         lecture de la requête, réponse HTTP
src/services/            logique métier et accès à la base
src/services/integrations/  un connecteur par service externe
src/cron/                synchronisation (15 min) et rappels (5 min)
src/middlewares/         JWT, rôle admin, validation zod, limites de débit
src/validators/          schémas zod
src/utils/crypto.ts      chiffrement des jetons
```

## Prochaines étapes

Envoi des rappels par notification push depuis le serveur, et d'autres services (Notion, Asana, Todoist, iCloud).
