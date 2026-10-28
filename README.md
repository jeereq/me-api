# me-api

Le backend de « Me », ton assistant personnel. Il sert l'app mobile [me-mobile](https://github.com/jeereq/me-mobile) :

- **comptes** avec email et mot de passe, rôle `ADMIN` ou `UTILISATEUR` (le premier compte créé devient admin) ;
- **espace privé** par compte (relances, tâches, habitudes, contacts, journal, agenda, sources, audio), que seul son propriétaire lit et écrit ;
- **configuration système** lisible par tous les comptes, modifiable par les admins ;
- **gestion des comptes** pour les admins ;
- **assistant IA** : relais vers OpenAI, la clé API reste sur le serveur ;
- **rappels** : calculés par le serveur selon le mode de chaque élément, visibles dans l'app et envoyés par email avec SendGrid ;
- **comptes connectés** : Google Agenda et Gmail, Outlook et Microsoft To Do, Trello, Slack, synchronisés toutes les 15 minutes ;
- **abonnements** : essai Pro de 14 jours, offre gratuite et Pro prépayé par mobile money avec FlexPaie ;
- **justificatifs de dépenses** : photos de reçus et PDF de factures, stockés chez Cloudinary (la clé reste sur le serveur).

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
| GET | `/api/espace` | compte | `{ espace: { data, majLe, revision } \| null }` |
| PUT | `/api/espace` | compte | `{ data, baseRevision? }` → `{ majLe, revision }`, ou **409** `{ code: "CONFLIT", espace }` (voir ci-dessous) |
| PATCH | `/api/espace` | compte | Seulement ce qui a changé : `{ baseRevision, operations }` → `{ majLe, revision }`, **409** comme `PUT`, **404** `ESPACE_ABSENT`, **422** `DIFFERENCES_INVALIDES` |
| GET | `/api/config` | compte | `{ config }` |
| GET | `/api/equipes` | compte | Les équipes du compte, avec leurs membres (et les invitations en attente pour un propriétaire) |
| POST | `/api/equipes` | compte | `{ nom, emoji? }` → `{ id }` ; celui qui crée est propriétaire |
| PATCH | `/api/equipes/:id` | propriétaire | `{ nom?, emoji? }` |
| DELETE | `/api/equipes/:id` | propriétaire | Supprime l'équipe, ses membres, ses invitations et son espace |
| POST | `/api/equipes/:id/invitations` | propriétaire | `{ email, role }` → envoie le lien par email, ou le renvoie dans `lien` si les emails ne sont pas configurés |
| DELETE | `/api/equipes/:id/invitations/:invitationId` | propriétaire | Annule une invitation en attente |
| POST | `/api/equipes/invitation/apercu` | compte | `{ jeton }` → quelle équipe, qui invite, et si ce compte peut accepter |
| POST | `/api/equipes/invitation/rejoindre` | compte | `{ jeton }` → `{ id }` ; le compte doit porter l'adresse invitée |
| PATCH | `/api/equipes/:id/membres/:membreId` | propriétaire | `{ role }` |
| DELETE | `/api/equipes/:id/membres/:membreId` | propriétaire, ou soi-même | Retire quelqu'un, ou quitte l'équipe |
| GET | `/api/equipes/:id/espace` | membre | `{ espace: { data, majLe, revision } \| null }` |
| PUT | `/api/equipes/:id/espace` | membre sauf lecteur | `{ data, baseRevision? }` → `{ majLe, revision }`, ou **409** `{ code: "CONFLIT", espace }` |
| PATCH | `/api/equipes/:id/espace` | membre sauf lecteur | Comme `PATCH /api/espace`, avec les mêmes avis d'affectation que `PUT` |
| PUT | `/api/config` | admin | `{ data }` → `{ config }` |
| GET | `/api/membres` | admin | Liste des comptes |
| PATCH | `/api/membres/:id` | admin | `{ role: "ADMIN" \| "UTILISATEUR" }` |
| DELETE | `/api/membres/:id` | admin | Supprime le compte et son espace |
| GET | `/api/assistant` | compte | `{ disponible }` : clé configurée et IA activée par l'admin |
| GET | `/api/assistant/modeles` | admin | `{ modeles, actuel }` : modèles OpenAI disponibles avec la clé du serveur |
| GET | `/api/integrations` | compte | Services configurés sur le serveur et comptes connectés |
| GET | `/api/integrations/:service/connecter?retour=` | compte | `{ url }` de la page d'autorisation (google, microsoft, trello, slack) |
| GET | `/api/integrations/:id/agendas` | compte | `{ agendas, choisis }` : agendas du compte (Google, Microsoft) et ceux cochés |
| PATCH | `/api/integrations/:id` | compte | `{ ctx?: "perso" \| "pro", agendas?: string[] }` → `{ integration }` ; changer les agendas relit le compte |
| GET | `/api/integrations/:id/mails/:mail` | compte | `{ mail }` : le mail en entier (texte, destinataires, pièces jointes, étiquettes) et les messages plus anciens du fil (`fil`, 10 au plus), lu à la demande et marqué comme lu |
| GET | `/api/integrations/:id/dossiers?boite=` | compte | `{ dossiers }` : les dossiers de la boîte (Outlook, arbre sur 3 niveaux) ou les libellés qui en tiennent lieu (Gmail), avec les non lus |
| GET | `/api/integrations/:id/dossiers/:dossier/mails?boite=&suivant=` | compte | `{ mails, suivant }` : une page de mails du dossier (taille = réglage du compte) ; `suivant` pour la page d'après |
| GET | `/api/integrations/:id/fils/:fil` | compte | `{ mail }` : le dernier message d'un fil (le mail d'origine d'une relance ou d'une tâche), même hors de la réception relue (envoyés, dossier) ; il est gardé avec les mails vus pour le lire et y répondre |
| POST | `/api/integrations/:id/mails/:mail/deplacer` | compte | `{ dossier, depuis? }` : range le mail (Outlook : déplacer ; Gmail : poser le libellé, retirer celui d'origine) |
| GET | `/api/integrations/:id/regles` | compte | `{ regles }` : les règles de la boîte Outlook, conditions et actions en français |
| PATCH | `/api/integrations/:id/regles/:regle` | compte | `{ active }` : active ou coupe une règle Outlook |
| POST | `/api/integrations/:id/mails/:mail/libelles` | compte | `{ ajouter?, retirer? }` → `{ libelles }` : pose ou retire des étiquettes (libellés Gmail sur tout le fil, catégories Outlook) ; une étiquette inconnue de Gmail y est créée |
| POST | `/api/integrations/:id/repondre` | compte | `{ mail, texte }` : envoie la réponse dans le fil du message |
| POST | `/api/integrations/:id/envoyer` | compte | `{ a, cc?, sujet?, texte }` : écrit un nouveau mail (adresses séparées par des virgules) |
| POST \| PATCH | `/api/integrations/:id/agenda` | compte | Crée (`{ agendaId, titre, date, debut?, fin?, lieu?, journee? }`) ou modifie (avec `id`) un rendez-vous |
| POST | `/api/integrations/:id/agenda/supprimer` | compte | `{ agendaId, id }` : supprime le rendez-vous |
| GET | `/api/integrations/:id/listes` | compte | `{ listes }` : listes de tâches du compte (Google Tasks, To Do) |
| POST \| PATCH | `/api/integrations/:id/taches` | compte | Crée (`{ listeId, titre, echeance? }`) ou met à jour (avec `id`, `fait`) une tâche |
| DELETE | `/api/integrations/:id` | compte | Déconnecte le compte et oublie ses jetons |
| GET | `/api/sync` | compte | Éléments importés : `{ integrations, agenda, taches, relances, mails }` |
| POST | `/api/sync` | compte | Relit tous les comptes tout de suite, puis comme GET |
| GET | `/api/notifications` | compte | 50 derniers rappels et nombre de non lus |
| POST | `/api/notifications/lues` | compte | `{ ids? }` : marque lus (tous sans `ids`) |
| GET | `/api/notifications/push` | compte | Clé publique VAPID et nombre d'appareils abonnés |
| POST | `/api/notifications/push` | compte | Abonne ce navigateur aux notifications push |
| DELETE | `/api/notifications/push` | compte | Désabonne ce navigateur |
| POST | `/api/notifications/test` | compte | Envoie un rappel d'essai dans l'app et par email |
| POST | `/api/assistant` | compte, Pro | `{ type: "question" \| "plan" \| "relance" \| "copilote" \| "mails" \| "lot" \| "compte_rendu", … }` → `{ text }` ; `consignes` (texte libre, 600 caractères retenus) oriente l'analyse « mails » et « lot » |
| GET | `/api/abonnement/offres` | public | Prix, durée de l'essai, ce que Pro débloque, `paiement` : FlexPaie configuré |
| GET | `/api/abonnement` | compte | `{ abonnement, paiements }` : offre en cours et 10 derniers paiements |
| POST | `/api/abonnement/paiement` | compte | `{ periode: "mensuel" \| "annuel", telephone, accepteCgv: true, accesImmediat: true }` → `{ paiement }` en attente de validation sur le téléphone |
| GET | `/api/abonnement/paiements/:reference` | compte | Revérifie le paiement chez FlexPaie → `{ paiement, abonnement, paiements }` |
| POST | `/api/abonnement/flexpaie/retour` | public | Retour de FlexPaie ; la commande est toujours revérifiée chez FlexPaie |
| GET | `/api/justificatifs` | compte | `{ disponible, tailleMax }` : Cloudinary configuré, taille maximale d'un fichier |
| POST | `/api/justificatifs` | compte (membre sauf lecteur pour `equipe`) | Formulaire `multipart/form-data` : `fichier` (JPEG, PNG, WebP, HEIC ou PDF, 10 Mo au plus), `equipe?` → **201** `{ justificatif: { id, url, apercu?, nom, sorte, taille, pages?, ajouteLe } }` à ranger dans la dépense ; 60 fichiers / heure |

Les erreurs ont la forme `{ "error": "message lisible" }`.

Règles :

- **Compte admin principal** : `ADMIN_EMAIL` et `ADMIN_PASSWORD` créent ce compte au démarrage, toujours admin. Changer `ADMIN_PASSWORD` puis redémarrer remplace son mot de passe. Sans ces variables, le premier compte inscrit devient admin.
- `SIGNUP_OPEN=false` ferme les inscriptions une fois le premier compte créé ; l'admin crée alors les comptes à la main ou les rouvre.
- Le modèle OpenAI se choisit dans l'app (Configuration, réservé à l'admin) ; sans choix, c'est `OPENAI_MODEL`, puis `gpt-4o-mini`. Si OpenAI retire le modèle choisi (404, « deprecated »), le serveur essaie les suivants de cette liste et le dit dans les logs ; si aucun n'existe, l'app demande d'en choisir un autre.
- Le dernier admin ne peut être ni rétrogradé ni supprimé.
- Pour nommer un admin depuis le serveur : `npm run promote:admin -- email@exemple.com`.
- Limites : 10 connexions ratées par 15 min et par email, 30 demandes à l'IA par 10 min et par compte.

## Comptes : Google, confirmation, mot de passe oublié

- **Confirmation de l'email** : si SendGrid et l'adresse de l'app (`APP_URL`) sont configurés, un nouveau compte reçoit un lien (valable 24 h) et ne peut se connecter qu'après l'avoir ouvert. Sinon, le compte est actif tout de suite. Les comptes créés avant cette version sont considérés comme confirmés.
- **Mot de passe oublié** : lien valable 1 h, à usage unique ; le nouveau mot de passe ferme toutes les autres sessions. Les demandes répondent pareil que l'email ait un compte ou non.
- **Continuer avec Google** : utilise le même client OAuth que les sources Google (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL`), avec seulement `openid email profile`. Ajoute l'URI de redirection `{PUBLIC_URL}/api/auth/google/callback` dans la console Google. Un compte existant avec la même adresse est relié (s'il n'avait jamais été confirmé, son mot de passe est retiré, par sécurité).
- Les liens des emails et le retour de Google pointent vers `APP_URL` (sinon la première adresse https d'`APP_REDIRECT_URLS`). Seule l'empreinte des jetons est gardée en base.

## Sources Google : messages d'erreur

L'écran « Agendas & outils » affiche la raison du refus de Google :

- **« l'API correspondante n'est pas activée dans Google Cloud »** : active *Google Calendar API* et *Gmail API* (API et services → Bibliothèque) dans le projet du client OAuth. Reconnecter ne sert à rien tant que ce n'est pas fait.
- **« Autorisations insuffisantes »** : ajoute les scopes `calendar.readonly` et `gmail.readonly` à l'écran de consentement, puis reconnecte le compte en acceptant toutes les cases.
- **« L'autorisation a expiré ou a été retirée »** : en mode *Test*, Google révoque les jetons après 7 jours ; reconnecte le compte (ou passe l'application en production).

## Rappels (app et email)

Toutes les 5 minutes, le serveur calcule les rappels de chaque compte dans son fuseau horaire, avec les mêmes règles que l'app : briefing du matin, mode normal le jour J à 9 h, agressif à J-3, J-1, matin et soir puis chaque jour de retard, coach le soir, bilan hebdo le dimanche soir. Le mode passif n'envoie rien.

**Les modes sont configurables** : la configuration (`PUT /api/config`, champ `modes.<mode>`) accepte pour chaque mode, en plus de `actif` et `desc`, les règles `jourJ` (heures `matin`, `soir` ou `HH:MM`), `avant` (jours avant l'échéance), `retard` (rappel chaque jour de retard), `heure` (des rappels à l'avance et en retard), `resume` (message du soir qui regroupe les habitudes) et `bilan` (`{ jour, heure }`, `null` pour aucun). Une règle absente prend la valeur d'origine ; les valeurs invalides sont ignorées. Le code est dans `src/commun/modes.ts` (partagé avec l'app, voir `src/commun/README.md`) et les tests dans `tests/modes.test.ts`.

- Avec les récompenses (réglage « Mission et série » dans Mon compte, actif par défaut), le briefing du matin annonce la mission du jour : nombre d'actions, points à gagner, série à tenir. À l'heure du rappel du soir, un coup de pouce part seulement s'il sert : série en danger (aucun point aujourd'hui), mission pas commencée, ou journée parfaite à 3 actions près.
- **Projets importés d'un plan Excel** : un plan peut compter des centaines de tâches. Le serveur ne rappelle ni les **résumés** (tâches qui ont des sous-tâches) ni les tâches **bloquées** par une tâche précédente pas finie, et une tâche de projet n'entre dans la mission ou le briefing que par son échéance (jamais par sa seule priorité), sans rappel quotidien pour un retard de plus de 3 jours. Règle dans `src/commun/projets.ts` (copie de `tachesActives` de `me-mobile/src/lib/planning.ts`, à garder identique).
- **Objectifs financiers** : l'espace peut porter `finances.objectifs` (épargne ou dette, avec cible, échéance, plan et versements, voir l'onglet Objectifs de l'app). Le serveur envoie, avec les réglages d'alertes de budget (heure, push, email), un rappel le jour d'un **versement prévu** (s'il n'est pas déjà noté), un rappel de **retard sur le plan** au plus une fois par semaine, une alerte d'**échéance passée** (une fois) et un message d'**objectif atteint** (une fois, dans les deux jours). Les archivés et ceux qui n'ont pas commencé sont ignorés, et `finances.alertes.objectifs: false` (l'interrupteur « Rappels des objectifs » de l'app) coupe le tout. Calcul dans `src/commun/objectifs.ts` (copie réduite de `me-mobile/src/lib/objectifs.ts`, à garder identique pour les dates de versement et l'état), tests dans `tests/objectifs.test.ts`.
- **Budgets par catégories** : un budget peut suivre des catégories ; une dépense va dans le budget choisi à la main, sinon dans le premier budget qui suit l'une de ses catégories (`idBudgetDe` dans `previsions.ts`, copie de `me-mobile/src/lib/categories.ts`).
- **Budgets jusqu'à une date** : un budget peut avoir une date de fin (et de début pour une enveloppe qui couvre toute la durée). Sur chaque horizon, il compte au prorata des jours où il est actif (`plafondSur`, copie de `me-mobile/src/lib/finances.ts`) ; après sa fin il ne compte plus et ne suit plus ses catégories.
- Avec des budgets (Plus › Finances dans l'app), le briefing du matin donne **ce qui reste sur les budgets en cours**, et à l'heure choisie (par défaut celle du rappel du soir) partent les **alertes de budget** : « presque atteint » puis « dépassé », pour les budgets par jour, par semaine, par mois, par trimestre et par an. Tout se calcule sur les seules dépenses notées : chaque budget sur sa propre période (son mois pour un budget au mois, toute sa durée pour une enveloppe), son montant moins ce qui y est rangé. Rien n'est supposé : ni budget du jour tiré d'un budget au mois, ni « à ce rythme ». Chaque alerte part une seule fois par période et par niveau. Horizons, seuil (80 %, 90 % ou 100 % du budget), heure, push et email se règlent dans l'app.
- **Restes reportés** : le reste non dépensé d'un budget sur une période, l'utilisateur peut le reporter sur le budget d'une autre période (un jour, une semaine, un mois) ou le verser sur un objectif (`reports` dans les finances de l'espace). Le plafond de départ baisse d'autant et celui d'arrivée monte d'autant ; les restes et les alertes en tiennent compte, comme l'app. Un report vers un objectif ne compte que tant que son versement existe.
- Chaque rappel apparaît dans le centre de notifications de l'app (cloche), une seule fois.
- Si SendGrid est configuré (`SENDGRID_API_KEY`, `SENDGRID_FROM`) et que l'admin n'a pas coupé le canal « Mail à moi-même », les rappels d'un même passage partent en un seul email.
- Si les clés VAPID sont configurées (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, générées par `npx web-push generate-vapid-keys`), chaque appareil activé dans l'app reçoit aussi une notification push, même app fermée. Sur iPhone, il faut l'app web ajoutée à l'écran d'accueil (iOS 16.4 ou plus).
- Chacun peut couper les emails ou les notifications dans l'app (Mon compte > Notifications).

## Comptes connectés

Chaque compte me peut connecter plusieurs comptes externes (par exemple Gmail perso et Google Workspace pro), depuis l'écran **Agendas & outils** de l'app. Le serveur garde les jetons chiffrés et relit les comptes toutes les 15 minutes.

| Service | Agenda | Tâches | Relances | Mails |
| --- | --- | --- | --- | --- |
| Google | Rendez-vous des 14 prochains jours (agendas cochés pour le compte, sinon ceux affichés ou ceux du filtre) | Mails suivis (étoile) des 30 derniers jours, et les tâches ouvertes de Google Tasks | Fils où ton dernier message attend une réponse depuis plus de N jours | Réception des 7 derniers jours, un message par fil |
| Microsoft | Rendez-vous des 14 prochains jours (mêmes règles) | Mails avec drapeau, tâches To Do ouvertes | Mails envoyés sans réponse depuis plus de N jours | Réception des 7 derniers jours, un message par fil |
| Trello | Échéances des 14 prochains jours | Cartes où tu es membre, non terminées | | |
| Slack | | Messages des derniers jours qui te mentionnent ou t'écrivent en direct | Tes questions restées sans réponse dans leur fil | |

N est le « délai avant relance » de la configuration système (3 jours par défaut). Les filtres et les types d'import se règlent par source dans l'app.

**Quels agendas** (`src/services/integrations/choix.ts`, module pur testé) : les agendas cochés pour ce compte dans l'app (`PATCH /api/integrations/:id`, champ `agendas`) ; sinon ceux dont le nom contient le filtre de la source ; sinon ceux que le service affiche par défaut. Un agenda coché puis disparu est ignoré, et si tous ont disparu on revient au défaut plutôt que de ne rien importer.

**Mails** : la synchro ne garde que l'objet, le contact, la date, l'état lu/non lu, un extrait d'une ligne (160 caractères), les étiquettes et le lien vers le fil d'origine. Un seul message par fil, le plus récent, 25 au maximum par compte. Le texte d'un mail n'est lu qu'à la demande (`GET /api/integrations/:id/mails/:mail`), quand tu l'ouvres dans l'app, et n'est jamais enregistré ; l'ouvrir le marque comme lu chez Gmail ou Outlook. Le texte vient de la partie texte du message, sinon du HTML converti (`src/services/integrations/lecture.ts`, module pur testé).

### Écrire dans les comptes

Me peut lire et écrire des mails, répondre dans un fil, tenir l'agenda et les tâches depuis l'app. Ce que ça implique :

- **Chargement des mails** : `PATCH /api/integrations/:id` avec `{ chargement: { jours, max } }` (1 à 90 jours, 10 à 100 fils ; 7 et 25 par défaut) règle la boîte de réception relue et la taille des pages de dossier.
- **Plusieurs comptes Microsoft, de domaines différents** : chaque connexion ajoute un compte (clé : utilisateur + fournisseur + adresse), et Microsoft demande à chaque fois quel compte utiliser. Pour accepter plusieurs domaines (par ex. `itmafrica.com` et un autre) : dans l'application Azure, « Types de comptes pris en charge » = **comptes de n'importe quel annuaire organisationnel et comptes Microsoft personnels**, et `MICROSOFT_TENANT_ID=common`. Si l'administrateur d'un domaine exige son accord, il autorise l'application une fois dans Microsoft Entra. Quand Microsoft ou Google refuse un compte pour ces raisons, l'app affiche la cause et quoi faire en français (`expliquerRefus`).
- **Boîtes partagées** (Microsoft 365) : `PATCH /api/integrations/:id` avec `{ boitesPartagees: ["ventes@entreprise.fr"] }` (10 au plus). Chaque boîte est lue avec le compte (`/users/{adresse}`), ses mails portent `boite`, et y répondre part de la boîte partagée. Une boîte refusée n'arrête pas la synchro : son erreur est rendue dans `boites` du compte. Gmail n'ouvre pas les boîtes déléguées à une application : on connecte la boîte comme un compte Google de plus.
- **Autorisations demandées** : Google `calendar.events`, `gmail.readonly`, `gmail.modify` (marquer comme lu un mail ouvert dans Me, poser des libellés), `gmail.send`, `tasks` ; active aussi **Google Tasks API** dans la bibliothèque Google Cloud ; Microsoft `Calendars.ReadWrite`, `Mail.ReadWrite`, `Mail.Send`, `Tasks.ReadWrite`, `Mail.ReadWrite.Shared` et `Mail.Send.Shared` (boîtes partagées), `MailboxSettings.ReadWrite` (couleurs des catégories, lire et couper les règles). Ajoute-les à l'écran de consentement Google et aux autorisations d'API de l'application Azure, **puis reconnecte chaque compte** : un compte relié avant ces autorisations ne peut pas écrire, et Me répond alors « Autorisations insuffisantes : reconnecte ce compte ».
- **Réponse à un mail** : le destinataire, l'objet et les en-têtes du fil viennent du message gardé lors de la dernière relecture (`donnees.mails`), pas de l'app. Gmail reçoit un message RFC 2822 complet (`In-Reply-To`, `References`), Outlook passe par `POST /messages/{id}/reply`. Un **nouveau mail** (`/envoyer`) part en texte simple : `messages/send` chez Gmail, `sendMail` chez Outlook. La mise en forme du message est dans `src/services/integrations/ecriture.ts` (module pur testé).
- **Tâches dans les deux sens** : une tâche importée de Google Tasks ou de Microsoft To Do garde sa liste d'origine (`liste`, et un identifiant `gtask:<liste>:<tâche>` ou `todo:<liste>:<tâche>`) ; la cocher dans Me la coche à la source.
- **Rendez-vous et tâches** : le compte est relu juste après l'écriture, pour que l'app voie le résultat sans attendre les 15 minutes. Un envoi de mail ne relit rien : la réponse part dans les messages envoyés, pas dans la réception.
- **Vérification Google** : `gmail.send` et `gmail.modify` sont un niveau d'accès restreint. Tant que l'application OAuth est en mode « Test », il fonctionne pour les utilisateurs test ; pour la publier, Google demande une validation.

Pour activer un service, crée son application OAuth (les étapes sont dans `.env.example`), remplis ses variables, `PUBLIC_URL` et `ENCRYPTION_KEY`, puis redémarre. Le bouton « Connecter » apparaît alors dans l'app.

## Équipes : un espace partagé

Une équipe réunit plusieurs comptes autour d'un **espace partagé** : budgets, projets, tâches et habitudes communs, à côté de l'espace privé de chacun.

Trois rôles (`src/services/equipes/droits.ts`) :

- **Propriétaire** : tout, y compris inviter, changer un rôle, retirer quelqu'un et supprimer l'équipe.
- **Membre** : lit et écrit l'espace partagé.
- **Lecteur** : lit seulement ; une écriture renvoie **403** `LECTURE_SEULE`.

Une équipe garde toujours au moins un propriétaire : rétrograder ou retirer le dernier renvoie **400** `DERNIER_PROPRIETAIRE`.

**Invitations** : un lien valable 7 jours, à usage unique, dont seule l'empreinte SHA-256 est gardée, comme les liens de compte. Le compte qui accepte doit porter l'adresse invitée (sinon **403** `AUTRE_ADRESSE`). Sans SendGrid ni `APP_URL`, la réponse contient le `lien` : à celui qui invite de le transmettre. On n'invite pas directement un propriétaire : on nomme la personne une fois qu'elle a rejoint. **Suivi par le propriétaire** : `GET /api/equipes` donne pour chaque invitation en attente son `etat` : `envoyee` (lien jamais ouvert), `ouverte` (ouvert avec le compte invité, pas encore accepté) ou `autre_compte` (ouvert avec un compte d'une autre adresse, donnée dans `ouvertePar` : il ne pourra pas accepter, il faut inviter cette adresse). L'ouverture est notée par l'aperçu (`POST /api/equipes/invitation/apercu`, colonnes `ouverteLe` et `ouvertePar`, migration `invitation_ouverture`). Les adresses se comparent sans tenir compte des majuscules, et une invitation dont l'adresse est déjà celle d'un membre n'est plus listée.

**Affecter une tâche, une relance ou un rendez-vous** : dans l'espace d'une équipe, une tâche, une relance (`relances`) ou un rendez-vous créé dans Me (`agenda`, avec un `id`) peut être confié à un membre (`affecteA` : l'identifiant de son compte, en plus du nom affiché dans `responsable`). Le serveur ne lit pas les éléments un à un ; à chaque `PUT` ou `PATCH /api/equipes/:id/espace` réussi qui contient des éléments affectés, il compare avec la version gardée (`src/services/equipes/affectations.ts`, testé dans `tests/affectations.test.ts`) et prévient la personne à qui un élément vient d'être confié ou reconfié : message dans la cloche de l'app, push et email (`NotificationService.affecter`). On ne prévient pas celui qui s'affecte lui-même, un compte qui n'est plus membre, ni pour une tâche faite ou une relance déjà obtenue ; 20 avis au plus par enregistrement. C'est un message d'un collègue et non un rappel : il part sans condition d'abonnement, mais chacun peut couper les emails et les notifications dans Mon compte › Notifications (et l'admin le canal « Mail à moi-même »). Un échec d'envoi n'empêche jamais l'enregistrement.

L'espace de l'équipe suit **exactement les mêmes révisions et les mêmes conflits** que l'espace privé : les deux passent par `src/services/espaces/document.ts` (voir la section suivante).

## Synchro entre appareils : versions et conflits

Chaque espace a un numéro de `revision`, augmenté de 1 à chaque écriture. L'app envoie avec son `PUT` la `baseRevision` qu'elle a lue en dernier ; l'écriture n'a lieu que si le serveur est encore à cette version (une seule requête SQL, donc sans course entre deux appareils). Sinon le serveur répond **409** avec la version actuelle, l'app fusionne les deux versions puis réessaie, au lieu d'écraser les changements de l'autre appareil.

Une app plus ancienne, qui n'envoie pas `baseRevision`, continue de fonctionner : sa dernière écriture gagne, comme avant.

**Synchro par différences** : une fois l'espace enregistré, l'app n'envoie plus tout le document mais seulement ce qui a changé depuis la version lue (`PATCH`, opérations calculées par `src/commun/patch.ts`) : une dépense ajoutée, une relance modifiée, une clé retirée. Les listes d'éléments à identifiant (relances, tâches, dépenses…) changent élément par élément ; le reste valeur par valeur. Mêmes versions et mêmes conflits que `PUT`. Si le serveur ne peut pas appliquer les différences (404 espace absent, 422 différences invalides) ou est ancien, l'app renvoie l'espace en entier. Un envoi complet accepte 10 Mo (2 Mo pour le reste de l'API), un espace enregistré 20 Mo au plus.

## Tâches planifiées, plusieurs instances

Les rappels (toutes les 5 min) et la synchro des comptes connectés (toutes les 15 min) tournent dans le processus du serveur. Un **verrou à bail dans la base** (table `VerrouCron`) garantit qu'un seul passage tourne à la fois, même avec plusieurs instances ou un redémarrage en plein passage : si l'instance tombe, son bail expire et une autre reprend au passage suivant.

Pour ne faire tourner les tâches que sur une instance, mets `RUN_CRONS=false` sur les autres (par défaut, toutes les instances les lancent, ce qui reste sûr grâce au verrou).

## Sauvegardes

- **Base hébergée** (Render, Neon, Railway…) : active les sauvegardes automatiques du plan, et vérifie qu'une restauration fonctionne.
- **Sauvegarde manuelle** : `scripts/sauvegarde.sh` fait un `pg_dump` compressé de `DATABASE_URL` (`./scripts/sauvegarde.sh [dossier]`). Restauration : `pg_restore --clean --if-exists -d "$DATABASE_URL" fichier.dump`.
- **Données d'un seul compte** : chaque utilisateur peut les exporter avec `GET /api/auth/me/export`.

## Tests

```bash
npm test    # lanceur natif de Node via tsx : rappels (dont plans de projet), prévisions et budgets par catégories, modes, équipes, chiffrement des jetons, JWT, validation
```

## Organisation

```
prisma/schema.prisma     modèles User, Espace, Config, Integration, Equipe, VerrouCron…
src/app.ts               serveur Express et gestion des erreurs
src/routes/              une route par domaine
src/controllers/         lecture de la requête, réponse HTTP
src/services/            logique métier et accès à la base
src/services/integrations/  un connecteur par service externe
src/services/espaces/    le contrat de révision, partagé par l'espace privé et celui d'une équipe
src/services/equipes/    les droits de chaque rôle
src/commun/              code partagé avec l'app, qui en garde une copie exacte vérifiée par sa CI (voir src/commun/README.md) :
                         rappels (calcul.ts, modes.ts, jours.ts), previsions.ts, objectifs.ts, projets.ts, synchro par différences (patch.ts)
src/cron/                synchronisation (15 min) et rappels (5 min)
src/middlewares/         JWT, rôle admin, validation zod, limites de débit
src/validators/          schémas zod
src/utils/crypto.ts      chiffrement des jetons
```

## Prochaines étapes

D'autres services (Notion, Asana, Todoist, iCloud), et, si les données grossissent encore, sortir de l'espace JSON les listes qui s'allongent (dépenses, relances, journal) vers des tables SQL : la synchro par différences envoie déjà ces listes élément par élément.

## Justificatifs de dépenses (Cloudinary)

Une dépense peut porter des photos de reçus et des PDF de factures. L'app envoie le fichier à `POST /api/justificatifs`, me-api le dépose chez Cloudinary avec sa clé secrète et renvoie une fiche que l'app range dans la dépense (`justificatifs`), donc dans l'espace synchronisé.

- **Configurer** : sur [cloudinary.com](https://cloudinary.com) (l'offre gratuite suffit), copie l'« API environment variable » du tableau de bord dans `CLOUDINARY_URL` (`cloudinary://<clé>:<secret>@<cloud>`), ou remplis `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` et `CLOUDINARY_API_SECRET`. Sans elles, `GET /api/justificatifs` répond `disponible: false` et l'app cache le bouton.
- **PDF** : sur un compte gratuit, Cloudinary bloque l'ouverture des PDF tant que *Settings > Security > « Allow delivery of PDF and ZIP files »* n'est pas coché. Les vignettes (première page en JPEG) marchent sans.
- **Rangement** : un dossier par compte (`me/justificatifs/<userId>`) et un par équipe (`me/justificatifs/equipe-<id>`) ; `CLOUDINARY_DOSSIER` change la racine.
- **Ménage** : la table `Justificatif` garde chaque dépôt. Chaque nuit, un fichier déposé il y a plus de 7 jours qu'aucune dépense de son espace ne mentionne plus (retiré, dépense supprimée, ajout abandonné) est effacé de Cloudinary. Supprimer un compte efface ses justificatifs, supprimer une équipe ceux de son espace.
- Les adresses des fichiers sont publiques mais impossibles à deviner (identifiant aléatoire), comme un lien de partage.
- Le code est dans `src/services/justificatifs/` (`cloudinary.ts` : appels REST signés sans SDK ; `fichiers.ts` : types acceptés, vignettes ; `stock.ts` : ménage), testé dans `tests/justificatifs.test.ts`.

## Abonnements

Activés par `ABONNEMENTS=true` ; sans cette variable, tout reste ouvert comme avant. Le code est dans `src/services/abonnements/` (`offres.ts`, module pur testé dans `tests/abonnements.test.ts`).

| Offre | Ce qu'elle donne |
| --- | --- |
| **Essai** | Tout Pro pendant 14 jours, sans paiement, à la création du compte. Les comptes existants au moment de la migration commencent leur essai ce jour-là. |
| **Gratuit** | Tout l'espace personnel : tâches, relances, habitudes, projets, finances, statistiques, récompenses, rappels dans l'app. Rejoindre une équipe sur invitation. |
| **Pro** | En plus : copilote IA, comptes connectés (connexion, lecture, écriture, synchro), création d'équipes et invitations, rappels par email et push. 4,99 $ par mois ou 49,99 $ par an. |

- Une route Pro sans abonnement répond **402** `ABONNEMENT_REQUIS` (avec `fonction`). Les admins ont toujours tout. Sans Pro, on peut encore voir et déconnecter ses comptes connectés ; la synchro planifiée les ignore, et les rappels restent dans l'app.
- **Paiement prépayé, sans renouvellement automatique** : un paiement FlexPaie (mobile money) ouvre un mois ou un an. Payer avant la fin ajoute la période à la fin en cours. Rien n'est prélevé automatiquement : Me prévient 7 jours puis la veille de la fin (dans l'app et par email), et 3 jours avant la fin de l'essai.
- **Sécurité du paiement** : le retour de FlexPaie sert seulement à retrouver la commande, qui est toujours revérifiée auprès de FlexPaie (montant et devise compris) ; un paiement ne prolonge Pro qu'une fois, même si le retour arrive deux fois. Les paiements dont le retour s'est perdu sont revérifiés toutes les 5 minutes pendant 24 h.
- **Suppression du compte** : les paiements restent pour la comptabilité, détachés du compte et sans numéro de téléphone.
- **CGV** : payer exige `accepteCgv` et `accesImmediat` (demande d'accès immédiat, qui encadre le droit de rétractation). La date et la version des CGV acceptées sont gardées sur le compte (`VERSION_CGV` dans `offres.ts`, à changer avec `cgv.html` de me-mobile).
- Les prix de `offres.ts` doivent rester identiques à ceux de `me-mobile/public/cgv.html`.
