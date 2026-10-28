# Code commun au serveur et à l'app

Ce dossier est la **seule source** du code qui doit donner le même résultat dans `me-api` et dans `me-mobile` :

| Fichier | Rôle |
|---|---|
| `calcul.ts` | Rappels d'une journée : `rappelsDuJour` (serveur : push et email) et `rappelsDesElements` (relances, tâches, habitudes, résumés, bilans), que l'app reprend pour programmer les notifications du téléphone |
| `modes.ts` | Modes de rappel et leurs règles |
| `jours.ts` | Jours en texte « AAAA-MM-JJ » : décalage, semaine, habitude prévue, en retard, cochée |
| `projets.ts` | Tâches de projet à rappeler (ni résumés ni tâches bloquées) |
| `previsions.ts`, `objectifs.ts` | Alertes de budget, prévisions et rappels des objectifs |
| `patch.ts` | Synchro par différences : `differences(base, local)` côté app, `appliquer(doc, operations)` côté serveur |

## Règles

- **Rien d'autre que du TypeScript pur** : aucun import hors de ce dossier, ni Node, ni React Native, ni Prisma.
- **On modifie ici, jamais dans l'app.** L'app en garde une copie exacte dans `me-mobile/src/lib/commun/` (les imports y perdent seulement leur extension `.js`).
- Un fichier ajouté ici doit aussi entrer dans `fichiers.json` (un test le vérifie), d'après quoi l'app recopie le dossier.
- Après une modification fusionnée, dans `me-mobile` : `npm run commun` recopie les fichiers. La CI de l'app (`npm run commun:verifier`) échoue tant que sa copie diffère de celle-ci, sur la branche du même nom si elle existe, sinon sur `main`.
- Des tests de contrat dans l'app (`tests/commun.test.ts`) comparent ce code avec les versions de l'app qui restent séparées (planning des projets, mission du jour) : un écart fait échouer la CI au lieu de passer inaperçu.
