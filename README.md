# Midgaard Neo

Un harness local d'agents, dans l'esprit d'OpenCode : tu parles à un
**orchestrateur**, qui délègue à des **agents exécutants**, chacun sur le
fournisseur et le modèle de ton choix. Tu **vois ce qu'ils font**, tu leur fixes
un **budget**, et les actions sensibles attendent ton **approbation**.

Les agents ont trois capacités, et rien d'autre :

- **le terminal** — lire, écrire et lancer des commandes dans un worktree Git ;
- **la navigation web** — `http_fetch`, lecture d'images, et un Chromium isolé
  piloté sous approbation ;
- **des outils MCP** — les serveurs MCP que tu déclares et attaches à un profil.

```text
  dashboard (navigateur ou fenêtre desktop) ─┐
  CLI harness ───────────────────────────────┼─ HTTP 127.0.0.1 + jeton ─► daemon ─► SQLite
                                             │                             │
                                             └──────── WebSocket ◄─────────┤
                                                                           └─► agent-runtime
                                                                                ├─► fournisseurs (compatibles OpenAI, Gemini)
                                                                                └─► outils (fichiers, exec, web,
                                                                                    navigateur, MCP, délégation)
```

## D'où vient ce dépôt

Midgaard Neo est une copie élaguée de
[Midgaard](https://github.com/AndyD9/Midgaard), prise au commit `effe3f4`
(2026-11-10). Ont été retirés :

| Retiré | Pourquoi |
|---|---|
| La façade MCP vers Claude Code (`harness_*`, `npm run init`, `.mcp.json`) | L'orchestrateur est intégré : Claude Code n'est plus dans la boucle |
| La VM Windows par SSH (`windows_run`, `harness windows`) | Spécialisation sécurité |
| Les échantillons, l'environnement Python, les findings et le pipeline à portes | Spécialisation sécurité |
| Les playbooks | Spécialisation sécurité |
| L'explorateur de fichiers et l'éditeur de code du dashboard | L'interface vise le style terminal |

Le dossier [docs/](docs/) est l'**historique de Midgaard d'origine**, gardé tel
quel : il explique d'où viennent les invariants, mais décrit aussi des briques
qui n'existent plus ici.

Deux choses restent de l'origine, à connaître :

- **Le dossier runtime est le même** (`~/.midgaard`) : Midgaard et Midgaard Neo
  partagent base, jeton et port s'ils tournent sur la même machine. Vise un
  autre dossier avec `--home` ou `MIDGAARD_HOME` pour les séparer.
- **Le schéma SQLite n'a pas été réduit** : les tables et colonnes des briques
  retirées restent, inutilisées, pour qu'une base existante continue de s'ouvrir.

## État

Ce qui marche, vérifié par les suites de tests : l'orchestrateur et ses
sous-tâches, les profils Researcher, Developer et Navigator, les approbations,
les budgets et les coûts, le coffre des clés, les serveurs MCP des agents, le
dashboard, une interface tout terminal (le flux d'un arbre de tâches, ses
approbations, l'invite vers l'orchestrateur).

L'**application autonome** se construit (`npm run desktop:bundle`) : un
bundle qui embarque Node, le daemon et le dashboard, et ne demande rien
d'autre à la machine. Constatée sous macOS ; construite en CI pour Linux et
Windows, où elle n'a jamais été lancée.

Ce qui n'est **pas** fait :

- **La signature et la mise à jour de l'application.** Les bundles ne sont pas
  signés (macOS : signature ad hoc seulement, sans notarisation), et une
  nouvelle version se réinstalle à la main. Le navigateur des agents
  (Chromium) n'est pas embarqué.

## Installer

Depuis un clone. **Prérequis :** Node **24 ou plus** et Git.

```bash
git clone https://github.com/AndyD9/Midgaard-Neo.git
cd Midgaard-Neo
npm ci                 # dépendances exactes du package-lock
npm run build          # compile les paquets et le dashboard
npm run doctor         # diagnostic de l'installation
```

Le navigateur des agents est celui de Playwright, que `npm ci` ne télécharge
pas :

```bash
npx playwright install chromium
```

## Déclarer un fournisseur de modèles

Sans fournisseur, seul le profil `simulated` tourne — des étapes minutées qui
n'appellent aucun modèle.

```bash
npm run harness -- providers add venice --model deepseek-v4-flash-0731
```

La clé est demandée **sans écho** et déposée dans le coffre système (trousseau
macOS, DPAPI sur Windows, libsecret sur Linux) ; la base n'en garde qu'une
référence. `--preset openai` ou `--preset gemini` visent ces fournisseurs ;
`--preset custom --base-url …` vise **tout endpoint compatible OpenAI**.

Plusieurs fournisseurs se déclarent sous des identifiants différents, et chaque
profil choisit le sien : c'est ainsi qu'un orchestrateur tourne sur un modèle
et ses exécutants sur un autre. Le choix se fait dans le dashboard, vue
« Profils », où un fournisseur s'ajoute aussi sans terminal.

## Lancer

```bash
npm run harness -- start   # démarre le daemon et affiche l'adresse du dashboard
```

Dans le dashboard : « Nouvelle tâche », profil `orchestrator`, un objectif et
le dossier du projet. L'orchestrateur délègue, la conversation se poursuit dans
le chat, et chaque commande ou saisie sensible attend ton approbation — dans le
dashboard, ou par `npm run harness -- approve`.

Un Developer travaille dans un worktree sous `~/.midgaard/worktrees` : **rien
n'arrive dans ton dépôt** tant que tu n'as pas mergé toi-même la branche
`midgaard/…`. `npm run harness -- workspaces clean` retire ensuite les
worktrees lus.

Le daemon s'arrête de lui-même après 30 minutes sans tâche active, sans
dashboard connecté et sans requête.

### La fenêtre desktop, facultative

Il faut [Rust](https://rustup.rs) (`cargo`) pour la construire.

```bash
npm run desktop:build  # une fois, et après chaque mise à jour du clone ou de Node
npm run desktop        # ouvre la fenêtre ; démarre le daemon au besoin
```

### L'application autonome

Le même code, en bundle : Node, le daemon et le dashboard embarqués.

```bash
npm run desktop:bundle # assemble l'arbre embarqué, puis construit le bundle
```

Le bundle est dans `apps/desktop/src-tauri/target/release/bundle/` : `.app` et
`.dmg` sous macOS, `.deb` sous Linux, installeur NSIS sous Windows. Il n'est
**pas signé** : macOS demande de l'autoriser (clic droit → Ouvrir). Dans
l'application, la CLI se lance par le lanceur embarqué, que le dashboard cite
à la place de `npm run harness --`.

Détail, garanties et ce qui n'a pas été constaté :
[apps/desktop/README.md](apps/desktop/README.md).

## Commandes

Depuis la racine du dépôt. `npm run harness -- --help` donne la liste complète.

| Commande | Rôle |
|---|---|
| `npm run build` | Compile les paquets (`dist/`) et le dashboard |
| `npm run typecheck` | Vérification des types, dashboard compris |
| `npm run doctor` | Diagnostic de l'installation |
| `npm run harness -- <cmd>` | La CLI : `start`, `stop`, `status`, `approve`, `reject` ; `--home <dossier>` avant la commande vise un autre dossier runtime |
| `npm run harness -- agents` | Profils d'exécution, et pourquoi certains sont désactivés ; `agents limits` les règle |
| `npm run harness -- providers` | Fournisseurs déclarés ; `add`, `test`, `remove` |
| `npm run harness -- pricing` | Tarifs en vigueur ; `refresh <id>` les relève chez le fournisseur |
| `npm run harness -- mcp` | Serveurs MCP des agents ; `add`, `test`, `tools`, `allow`, `revoke`, `remove`, `attach`, `detach` |
| `npm run harness -- workspaces` | Worktrees des tâches Developer ; `remove`, `clean` (la branche reste toujours) |
| `npm run harness -- exec` | Commandes lancées sans approbation dans ce dépôt ; `allow`, `revoke` |
| `npm run dashboard:dev` | Dashboard avec rechargement à chaud (lance `harness start` avant) |
| `npm run desktop` | Ouvre la fenêtre desktop |

## Tests

| Suite | Contenu |
|---|---|
| `npm test` | Enchaîne les six suites ci-dessous |
| `npm run test:unit` | Machine à états, persistance, adaptateurs, coûts, outils, boucle d'agent, coffres, worktrees, navigateur, client MCP |
| `npm run test:lock` | Instance unique du daemon sous concurrence |
| `npm run test:restart` | Redémarrage, reprise WebSocket, attente d'une approbation, inactivité |
| `npm run test:developer` | Le Developer dans un vrai daemon, face à un faux fournisseur |
| `npm run test:orchestrator` | Délégation parallèle, approbation d'un enfant, annulation en cascade, arrêt brutal |
| `npm run test:security` | Aucun secret en base ni au journal, refus tracés, API sur la seule boucle locale, navigateur et serveurs MCP bornés |

À part :

| Suite | Contenu |
|---|---|
| `npm run test:ui` | Le dashboard dans un vrai navigateur ; il lui faut `npm run build` |
| `npm run test:standalone` | L'arbre embarqué de l'application autonome, assemblé puis lancé hors du clone ; il lui faut `npm run build` |
| `npm run test:vault` | Les coffres seuls, sur le coffre **réel de la machine** |
| `npm run test:live` | Essai contre un vrai fournisseur — **dépense de l'argent**, s'abstient sans clé |

Le développement se fait **sans étape de build** : Node exécute le TypeScript
directement. `npm run build` ne sert qu'au dashboard, que le daemon sert depuis
`apps/dashboard/dist`.

## Organisation du dépôt

```text
apps/
  dashboard/      Interface React tout terminal : tâches, flux, profils
  desktop/        Coque Tauri autour du dashboard
packages/
  contracts/      Schémas et types partagés
  daemon/         Tâches, moteurs, API HTTP et WebSocket
  agent-runtime/  Boucle d'agent, contexte, budget
  tools/          Outils des agents : fichiers, exec, web, navigateur, MCP, délégation
  providers/      Adaptateurs de modèles, tarifs
  browser/        Chromium isolé derrière un proxy gardé
  mcp-client/     Client MCP stdio des agents
  persistence/    Base SQLite et migrations
  secrets/        Coffres système
  workspace/      Worktrees Git
  cli/            La commande `harness`
tests/            Suites unitaires et de bout en bout
docs/             Historique de Midgaard d'origine
```

Chaque paquet a son `README.md`.

## Licence

MIT — voir [LICENSE](LICENSE).
