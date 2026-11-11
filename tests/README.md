# `@midgaard/tests`

Neuf suites, de la plus rapide à la plus lente. Elles utilisent le lanceur
intégré à Node (`node --test`) et de vrais processus — aucun double, aucune
simulation de notre côté.

| Suite | Durée | Ce qu'elle protège |
|---|---|---|
| `npm run test:unit` | ~15 s | Machine à états (matrice complète), persistance, configuration, traversée de chemins, **coffres**, **worktrees** sur de vrais dépôts Git, `doctor` et `status` qui ne touchent pas la base (comparée octet pour octet) |
| `npm run test:worktrees` | ~5 s | Worktrees, écriture et `exec` seuls — `.github/workflows/worktrees.yml` les rejoue sur macOS, Linux et Windows ; sous Windows, les deux cas qui lancent un script `sh` sautent en le disant |
| `npm run test:vault` | ~1 s | Les coffres seuls : conformité du coffre **réel de la machine**, plus le repli |
| `npm run test:lock` | ~30 s | Un seul daemon vivant, sous concurrence |
| `npm run test:restart` | ~1 min | Redémarrage, reprise WebSocket, contrôles d'accès, expiration, inactivité, attente longue (`/api/tasks/:id/wait`) débloquée par la vraie CLI, `ensureDaemon` de la CLI sous concurrence |
| `npm run test:developer` | ~25 s | Le Developer dans un **vrai daemon**, face à un **faux fournisseur** qui joue des scénarios d'appels d'outils : commit sur la branche, dépôt de l'utilisateur intact, approbation d'une commande, échec sans branche trompeuse, redémarrage, diff par l'API, résultat qui porte la branche et le commit, retraits de worktrees, liste blanche par dépôt et préfixes, la vraie CLI, un sous-module vide annoncé partout où rien ne s'y écrit, un daemon tué net en pleine commande (la commande meurt avec lui) et deux Developer simultanés sur un même dépôt |
| `npm run test:orchestrator` | ~6 s | L'orchestrateur dans un **vrai daemon**, face au faux fournisseur (qui reprend l'identifiant des sous-tâches, `{{task_id:N}}`) : délégation parallèle, approbation d'un enfant que l'orchestrateur attend sans rien approuver et sans payer d'étape, annulation en cascade, arbre entièrement `interrupted` après un `SIGKILL`, ni profondeur 2 ni limite relevée — tâches actives **comptées en base** |
| `npm run test:security` | ~10 s | Le PLAN §8.4 de bout en bout, face au faux fournisseur : un agent détourné recopie une clé lue dans le projet partout où il peut écrire, et la base et le journal du daemon, **lus octet pour octet**, n'en contiennent rien ; chaque refus de lecture, de réseau (IMDS, boucle locale, `localhost`) et d'écriture est au journal ; `; rm -rf` reste un argument ; l'API ne répond sur aucune autre interface ; jeton et base en `0600` ; un orchestrateur qui recopie la clé dans un objectif, un contexte ou un motif d'annulation ne la fait pas persister ; le navigateur des agents (X7 à X9) : une saisie ou Entrée refusée n'atteint pas la page (vu par le serveur de la page), sept écritures d'adresses privées refusées, aucun Chromium vivant après un `SIGKILL` du daemon (Chromium figé avant, sans quoi il quitte seul et la garde n'est pas éprouvée), aucune capture en base — Chromium requis ; les serveurs MCP des agents (X10 à X13) : un outil non coché ou changé n'atteint pas le serveur, son secret ne persiste nulle part, un exécutant créé reste borné, aucun serveur vivant après un `SIGKILL` |
| `npm run test:ui` | ~1 min | Le dashboard **rendu dans un navigateur** : direct, approbation, reconnexion, diff d'une tâche Developer, formulaire « Nouvelle tâche », modèle d'un profil, arbre d'un orchestrateur |

`npm test` enchaîne `unit`, `lock`, `restart`, `developer`, `orchestrator` et `security`. `test:ui` et `test:vault` ont
chacune un prérequis qui ne peut pas être supposé, et se lancent à part ; `test:worktrees` rejoue une partie de `unit`.
`test:security` demande lui aussi le navigateur de Playwright (ci-dessous) :
sans lui, X7 à X9 **échouent** en donnant la commande, parce qu'une preuve de
sécurité qui saute ne doit pas avoir l'air d'une réussite.

## Les deux suites à prérequis

**`test:ui`** demande le dashboard compilé (`npm run build`) et le navigateur de
Playwright, que `npm ci` ne télécharge pas :

```
npx playwright install chromium
```

La suite vérifie les deux avant son premier scénario et dit la commande exacte
qui manque, plutôt que d'échouer sur une erreur de bibliothèque.

**`test:vault`** éprouve le coffre système **de la machine qui l'exécute** : le
trousseau macOS sur un Mac, DPAPI sous Windows, libsecret sous Linux de bureau.
Elle n'écrit jamais sous une référence réelle — toutes les siennes commencent par
`test.conformance.<pid>.` — et nettoie derrière elle.

Comme une machine n'en prouve qu'un, `.github/workflows/vault.yml` la lance sur
quatre postes : macOS, Windows, Linux avec trousseau, et Linux **sans**. Chaque
poste pose `MIDGAARD_REQUIRE_VAULT`, et la suite échoue si ce n'est pas ce
coffre-là qui a été retenu — sans quoi un poste sans trousseau sauterait la
batterie et passerait au vert sans rien avoir éprouvé.

## Deux principes

**Tester l'invariant, pas son symptôme.** En Slice 0, un test vérifiait que deux
clients voyaient le même daemon — ce qui reste vrai même quand deux daemons
tournent, puisque les clients lisent le même fichier de découverte. Deux daemons
orphelins ont survécu à une suite entièrement verte. `single-instance.ts` compte
donc les **processus vivants**.

**Vérifier ce qu'on annonce.** Quand le daemon annonce l'URL du dashboard, D1
(`test:ui`) la **charge** et vérifie qu'elle sert une application qui démarre,
pas seulement un fichier.

## Isolation

Chaque suite travaille dans un `MIDGAARD_HOME` temporaire et sur le port 0, choisi
par le système. Aucune ne touche au daemon de développement (`~/.midgaard`), et
deux suites peuvent tourner en même temps.

Une exception, et elle est inévitable : **`test:vault` écrit dans le trousseau de
l'utilisateur**, parce que le coffre système est par utilisateur et qu'aucune
variable ne le déplace. C'est précisément pour cela qu'il a si longtemps échappé
aux tests. L'isolation se fait donc par la **référence** : chaque exécution tire
un préfixe `test.conformance.<pid>.<aléa>`, et supprime ce qu'elle a déposé même
quand un cas échoue. Les autres suites, elles, continuent de poser
`MIDGAARD_VAULT=file` : écrire `provider.venice` depuis un test écraserait la
vraie clé de l'utilisateur, sous la même référence, sans rien dire.

## Ce qui n'est pas ici

- **Le rendu visuel.** `test:ui` vérifie des comportements — un texte attendu, un
  clic qui débloque, un badge qui change — pas des pixels. Il n'y a pas de
  capture de référence, et c'est volontaire : une régression visuelle coûte moins
  cher qu'une suite qui rougit à chaque retouche de style.
- **L'adaptateur Gemini contre l'API réelle**, faute de clé. Les réponses
  enregistrées le couvrent, l'API ne le confirme pas.
