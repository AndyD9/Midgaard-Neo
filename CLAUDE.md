# Consignes pour un agent de code — dépôt Midgaard-Neo

Harness local d'agents (paquets `@midgaard/*`) : l'humain parle à un
**orchestrateur intégré** au daemon, qui délègue à des agents exécutants ; le
harness les observe et soumet leurs actes sensibles à une approbation humaine.
Trois capacités : le terminal (`exec`, lecture et écriture dans un worktree
Git), la navigation web (Chromium isolé, `read_image`) et les outils de
serveurs MCP déclarés par l'humain. L'interface est le dashboard servi par le
daemon, ouvert dans un navigateur ou dans la fenêtre desktop.

**Lire d'abord** : [README.md](README.md), puis le `README.md` du paquet
auquel on touche — chaque paquet a le sien.

`docs/` est **l'historique du Midgaard d'origine**, gardé tel quel : il
explique d'où viennent les invariants ci-dessous (`docs/PLAN.md`,
`docs/SLICE0.md` à `docs/SLICE8.md`), mais il décrit aussi des briques
**retirées** de ce dépôt — la façade MCP vers Claude Code (`harness_*`,
`.mcp.json`), les playbooks, les échantillons, les findings, la VM Windows,
l'explorateur de fichiers du dashboard. Ne rien y lire comme un état des
lieux, et ne pas le modifier.

## Conventions

- **Langue** : français pour les échanges, les commentaires et la documentation.
  Exception : les descriptions d'outils, les consignes des profils et les
  messages renvoyés au modèle sont en anglais, car c'est le modèle qui les lit.
- **Toujours documenter et commenter le code**, sans attendre qu'on le demande,
  y compris les tests :
  - un en-tête par fichier (rôle du module, place dans l'architecture) ;
  - une JSDoc sur chaque élément exporté (rôle, paramètres, retour, erreurs) ;
  - des commentaires sur le *pourquoi* des choix non évidents (sécurité, délais,
    pièges de plateforme), jamais la paraphrase du code ;
  - un README par module, et la documentation tenue à jour quand le comportement change.
- **Commandes à donner à l'utilisateur** : complètes et prêtes à copier, sans
  `<placeholder>` (zsh lit `<` et `>` comme des redirections).

## Architecture

```text
  CLI harness ──┐
                ├─ HTTP 127.0.0.1 + jeton ─► daemon ─► SQLite
  dashboard ────┘                             │
  (navigateur ou fenêtre desktop) ◄─ WebSocket┘
```

Un seul daemon par dossier runtime. Une tâche se lance du dashboard
(`POST /api/tasks`) ; l'orchestrateur délègue par ses outils
(`delegate_task`, `wait_for_task`, `create_agent`…), profondeur 1. Profils
livrés : `orchestrator`, `researcher`, `developer`, `navigator`, et
`simulated` pour les tests.

| Paquet | Rôle |
|---|---|
| `packages/contracts` | Schémas Zod, types, machine à états, protocole ; aucun effet de bord au chargement |
| `packages/persistence` | SQLite (`node:sqlite`), migrations, `record()` |
| `packages/daemon` | API HTTP locale, WebSocket, bus d'événements, gérant des tâches, moteurs |
| `packages/agent-runtime` | Boucle d'un agent : limites, approbations, résultat structuré |
| `packages/tools` | Outils des agents : lecture, écriture dans le worktree, `exec`, `http_fetch`, navigateur, délégation, outils MCP |
| `packages/workspace` | Worktrees Git des agents écrivants |
| `packages/browser` | Chromium jetable derrière un proxy gardé |
| `packages/mcp-client` | Client MCP du daemon : serveurs stdio déclarés par l'humain |
| `packages/providers` | Adaptateurs de modèles (compatible OpenAI, Gemini), tarifs |
| `packages/secrets` | Coffre système pour les clés d'API |
| `packages/cli` | Ligne de commande `harness` ; `ensureDaemon` (`src/daemon-client.ts`) |
| `apps/dashboard` | Interface React servie par le daemon |
| `apps/desktop` | Coque Tauri autour du dashboard |
| `tests` | Suites unitaires et d'intégration |

## Commandes (à la racine)

| Commande | Rôle |
|---|---|
| `npm ci` | Dépendances |
| `npm run doctor` | Diagnostic de l'installation |
| `npm run typecheck` | Vérification des types, dashboard compris |
| `npm run build` | Compile les paquets et le dashboard |
| `npm run dashboard:dev` | Serveur Vite du dashboard, rechargement à chaud (daemon démarré avant) |
| `npm run desktop:build` | Construit la coque Tauri (`apps/desktop`, Rust requis) ; facultatif |
| `npm run desktop` | Ouvre la fenêtre desktop du dashboard, démarre le daemon au besoin |
| `npm run harness -- <cmd>` | CLI : `start`, `stop`, `status`, `doctor`, `desktop`, `approve`, `reject` ; `--home <dossier>` avant la commande vise un autre runtime |
| `npm run harness -- providers add <id> --model <m>` | Déclare un fournisseur ; clé saisie sans écho. Aussi `providers test`, `providers remove`, `pricing`, `pricing refresh` |
| `npm run harness -- agents` | Profils d'exécution, et pourquoi certains sont désactivés ; `agents limits <profil> --timeout 900` les règle (relèvement confirmé) |
| `npm run harness -- workspaces` | Worktrees : `remove`, `clean` — la branche reste toujours |
| `npm run harness -- exec` | Liste blanche `exec` du dépôt : `allow` (avertit, confirme ; `--prefix` couvre tout ce qui suit, jamais un interpréteur nu), `revoke` |
| `npm run harness -- mcp` | Serveurs MCP des agents : `add` (programme résolu, testé dans la foulée), `test`, `tools`, `allow` (avertit, confirme), `revoke`, `remove`, `attach`/`detach` (à un profil) |
| `npm test` | Enchaîne `test:unit`, `test:lock`, `test:restart`, `test:developer`, `test:orchestrator`, `test:security` |
| `npm run test:unit` | ~15 s — machine à états, persistance, adaptateurs, coûts, outils, boucle, coffres, worktrees (vrais dépôts Git), navigateur (vrai Chromium), client MCP (vrai serveur stdio, processus comptés) |
| `npm run test:vault` | ~1 s — les coffres seuls, sur le coffre réel de la machine |
| `npm run test:worktrees` | ~8 s — worktrees, écriture et `exec` seuls, sortie en direct et lecture d'une image d'une tâche comprises (rejoués en CI sur trois plateformes) |
| `npm run test:lock` | ~30 s — instance unique du daemon sous concurrence |
| `npm run test:restart` | ~1 min — redémarrage, reprise WS, sécurité de l'API, expiration, inactivité, attente longue (`/api/tasks/:id/wait`), `ensureDaemon` |
| `npm run test:developer` | ~45 s — le Developer dans un vrai daemon, face à un faux fournisseur ; crash et concurrence compris, liste blanche et préfixes `exec` |
| `npm run test:orchestrator` | ~10 s — l'orchestrateur dans un vrai daemon : délégation parallèle, approbation d'un enfant, cascade, `SIGKILL`, conversation qui pilote une revue, `SIGKILL` pendant une attente |
| `npm run test:security` | ~1 min — base et journal lus octet pour octet (conversation, questions, propositions et sortie en direct comprises), refus tracés, API sur la seule boucle locale ; le navigateur : saisie sans approbation, adresses privées, aucun Chromium après `SIGKILL`, aucune capture en base ; les serveurs MCP : outil non coché ou changé jamais reçu par le serveur, secret d'un serveur jamais persisté, exécutant créé borné, aucun serveur après `SIGKILL` (`npx playwright install chromium` au préalable) |
| `npm run test:ui` | ~1 min — le dashboard dans un vrai navigateur : direct, approbation, reconnexion, diff d'une tâche Developer, arbre d'un orchestrateur, flux (conversation, sortie des commandes, approbation), lecture « navigateur », rechargement d'une page plus vieille que son daemon, serveurs MCP et limites aux Profils, agents créés, clé d'un fournisseur déposée depuis la carte « Fournisseurs » (`npm run build` et `npx playwright install chromium` au préalable) |
| `npm run test:desktop` | ~2 min la première fois — les tests Rust de la coque (adresse du dashboard) |
| `npm run test:live` | Payant, opt-in — un vrai modèle, coût comparé au solde du fournisseur ; s'abstient sans clé au coffre |
| `npm run test:live-vision` | Payant, opt-in — une image envoyée à un modèle Venice qui la lit, coût relevé |

`test:ui`, `test:vault`, `test:worktrees`, `test:desktop` et les deux `test:live*`
ne font pas partie de `npm test`.

## Invariants à ne pas casser

Chacun a été appris à la dure ; le récit est dans `docs/SLICE0.md` à
`docs/SLICE8.md`.

- **Aucun outil d'approbation exposé à un modèle.** L'approbation est un acte
  humain : dashboard ou CLI (`approve`, `reject`). Un orchestrateur attend
  l'approbation d'une sous-tâche avec l'humain, sans pouvoir la donner.
- **L'attente longue n'annonce une pause d'approbation qu'une fois**
  (`GET /api/tasks/:id/wait`, `approval_seq`, `known_approval`) ; ensuite elle
  bloque jusqu'à la décision humaine.
- **Un changement d'état et l'événement qui le raconte s'écrivent ensemble**,
  dans la même transaction, et tout ce qui est écrit est diffusé. C'est pour cela
  que le dépôt expose `record()` et que le daemon n'écrit que par `EventBus`.
- **`task_events.seq` est global, `AUTOINCREMENT`, jamais réutilisé.** C'est la
  clé de la reprise WebSocket : sans elle, une reconnexion laisse un trou
  invisible dans la timeline.
- **Toute tâche trouvée active au démarrage devient `interrupted`.** Jamais
  reprise, jamais considérée réussie.
- **Incrémenter `PROTOCOL_VERSION`** (`packages/contracts/src/protocol.ts`) à tout
  changement incompatible de l'API HTTP, du modèle de tâche ou du protocole
  WebSocket : le daemon survit aux mises à jour du code, et c'est ce numéro qui
  le fait remplacer (`ensureDaemon`). Le numéro ne redescend pas.
- **Un daemon d'une autre installation n'est remplacé que s'il est oisif**, et
  c'est lui qui le décide (`POST /api/shutdown` avec `if_idle`), sans `await`
  entre la lecture de son compteur et son arrêt. Une installation = dossier du
  paquet `@midgaard/daemon` + version : deux clones sur un même `~/.midgaard`
  sont deux installations.
- **Une commande conseillée à l'utilisateur passe par `harnessCommand`**
  (`contracts`), que la CLI emploie par `cmd()` et le daemon par `keyCommand` :
  le harness se lance depuis un clone, aucun binaire `harness` n'est dans le
  `PATH`. Lue **hors du clone** (erreur affichée au dashboard), elle porte
  `npm --prefix "<clone>"`, jamais `cd … &&`. Elle redit `--home "<runtime>"`,
  **avant** la commande, dès que le dossier runtime est désigné
  (`homeIsExplicit`) : sans lui, elle visait `~/.midgaard`, donc une autre
  installation. Un `harness …` écrit en dur est un conseil que personne ne peut
  lancer.
- **La configuration est injectée**, jamais lue au chargement d'un module. Seuls
  les `main.ts` lisent `process.env`.
- **Une migration publiée ne se modifie plus** : toute évolution ajoute une entrée
  à la fin de `MIGRATIONS`. Les tables et colonnes des briques retirées
  (`agents.playbooks_json`, `tasks.samples_json`, `windows_hosts`,
  `agents.windows_host`, `findings`) restent donc en base, inutilisées, exprès.
- **Tester les invariants directement** (compter les processus vivants, lire la
  base), pas leurs effets visibles depuis un client : c'est ainsi qu'un bug de
  verrou est passé inaperçu.
- **Ne rien décrire à un modèle ni à l'utilisateur qui n'existe pas.** Le daemon
  annonce `dashboard_available`, et D1 (`test:ui`) charge l'URL annoncée pour
  vérifier qu'elle sert une application qui démarre. Un profil sans fournisseur
  est montré **désactivé avec son motif**, et un « Test connection » doit
  prouver la **clé**, pas seulement que l'endpoint répond — `GET /models` de
  Venice est public, et le test l'annonçait « joignable » avec une clé bidon.
- **Un test qui saute doit le dire, jamais ressembler à un test qui réussit.**
  La conformité du coffre ne peut éprouver que le coffre de la machine qui
  l'exécute ; `MIDGAARD_REQUIRE_VAULT` fait donc nommer à chaque poste de CI le
  coffre qu'il prétend prouver, et la suite échoue si ce n'est pas celui-là.
- **Aucun montant sans sa provenance.** `cost_source` accompagne toujours
  `cost_usd` : `provider` (la facture), `pricing_table` (une estimation) ou
  `unknown`. Un modèle sans tarif connu n'affiche **pas** `0 $` : zéro est un
  coût, pas une ignorance. Quand le fournisseur annonce son propre coût, on garde
  l'estimation à côté — l'écart est la seule façon de voir dériver `pricing.json`.
- **Les limites appartiennent au profil, pas à l'appel.** `tightenLimits` ne sait
  qu'abaisser. **L'humain règle celles d'un profil** par une route à part
  (`PUT /api/agents/:id/limits`) : bornées, journalisées avant → après, **un
  relèvement se confirme** (CLI et dashboard), les tâches existantes gardent
  les leurs ; le `PATCH` du modèle ignore toujours des limites glissées.
- **Vérifier les limites AVANT l'appel modèle**, jamais après : une limite
  constatée après coup a déjà été payée. Et `budget_exceeded` n'est pas `failed` —
  rien n'a échoué, un plafond a été atteint.
- **La fin d'une tâche est un acte, pas une interprétation.** Seul `submit_result`
  termine une tâche d'agent. Un modèle qui écrit « j'ai fini » n'a pas fini.
- **Ce que lit un modèle ne nomme pas qui l'a délégué** : la consigne dit
  seulement qu'un orchestrateur l'a fait (test « neutralité envers
  l'orchestrateur », `tests/unit/agent-runtime.test.ts`). À garder ainsi dans
  toute nouvelle consigne.
- **Les chemins se revérifient à l'ouverture du descripteur**, pas seulement
  avant : on compare `dev`/`ino` du `fstat` à ceux du `stat` d'avant. Sans cela,
  la cible peut changer entre la vérification et l'ouverture.
- **Tout ce qui vient du dehors est encadré en `<untrusted_data>`** avec un nonce
  aléatoire, avant d'être réinjecté dans la conversation de l'agent : page web,
  sortie de commande, résultat d'un outil MCP, résultat d'une sous-tâche. Sans
  nonce, il suffit qu'un contenu porte la balise de fin pour sortir du cadre.
  L'étiquette se désamorce comme le contenu : pour `exec`, c'est la commande
  écrite par le modèle. Et **le résultat d'une tâche qui a reçu un contenu
  encadré est `untrusted`**, cité ou non.
- **La sortie en direct se découpe par ligne avant l'expurgation**
  (`agent-runtime/src/output.ts`). Les morceaux d'un tube se coupent n'importe
  où : expurgée morceau par morceau, une clé coupée en deux passerait en clair
  — le test l'a vu échouer ainsi. Le décodage UTF-8 se fait par flux, pour la
  même raison.
- **Aucune clé d'API en base.** La base ne garde qu'une référence vers le coffre.
  Et tout ce qui est journalisé ou persisté passe par `createRedactor` —
  **y compris le message d'un refus**, qui cite ce que le modèle a demandé.
  `tests/security.ts` lit la base et le journal octet pour octet : c'est là
  que deux oublis ont été trouvés, pas dans les tests de l'expurgation.
- **Aucune image en base** : ni image lue par `read_image`, ni capture du
  navigateur. La dernière capture reste en mémoire du daemon ; une image lue
  se relit sur le disque.
- **Aucun programme désigné par l'arbre d'un worktree ne s'exécute.** Cet arbre
  est écrit par l'agent. Tout `git` du paquet `workspace` passe par `git()`, qui
  impose `core.hooksPath` vers le périphérique nul ; les diffs portent
  `--no-ext-diff --no-textconv`. **`--no-verify` ne suffit pas** : constaté,
  `prepare-commit-msg` et `post-commit` tournent malgré lui.
- **Le harness ne merge jamais, et ne supprime rien hors de `worktreesDir`.** Le
  merge est un acte humain. Le retrait d'un worktree vérifie que le chemin est
  strictement sous le dossier des worktrees, même forcé : le chemin vient de la
  base, et une ligne fausse ne doit rien effacer.
- **La coque desktop n'accorde aucune capacité Tauri à la page** et charge
  l'origine que le daemon accepte déjà (`http://127.0.0.1:<port>/`) :
  `security.ts` ne change pas. Elle ne navigue que sur cette origine, et
  refuse une adresse de `daemon.json` hors de la boucle locale.
- **Le navigateur des agents passe tout par le proxy gardé**
  (`packages/browser`), qui se connecte à l'adresse qu'il a jugée, jamais au
  nom. Le drapeau `--proxy-bypass-list=<-loopback>` reste : sans lui, la
  variable `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` héritée par le
  daemon rouvrait `127.0.0.1` à une page — vu. Chromium est confié à la garde
  d'`exec` et tué par groupe à la fermeture.
- **Une saisie au navigateur est lue par l'humain avant de partir** : approuvée
  une à une, ou annoncée à l'ouverture de la session (`planned_inputs`) et
  tapée une fois, identique à la lettre. Un clic n'est jamais approuvé, et la
  demande de session le dit.
- **Le flux du dashboard ne laisse passer aucune séquence d'échappement**
  (`apps/dashboard/src/lib/stream.ts`, `plain`), couleur comprise : la teinte
  d'une ligne vient d'une classe CSS. La sortie vient de commandes lancées
  dans un arbre écrit par l'agent ; une séquence qui efface, déplace le curseur
  ou réinitialise (`ESC c`) ferait voir à l'humain autre chose que ce qui s'est
  passé, au moment où il approuve — sous le flux, justement. La ligne de
  commande d'un `exec` est nettoyée comme sa sortie.
- **L'API ne lit qu'un fichier d'une tâche : une image, sans jamais toucher
  `.git`** (`GET /api/tasks/:id/files/image`, `daemon/src/files.ts`). La règle
  vaut pour le chemin demandé **et** pour le chemin réel — un lien posé dans le
  worktree vers `.git` reste sous la racine, et passait sans cette relecture.
  Aucune route n'écrit un fichier.
- **On n'écrit que dans un worktree, jamais sous `.git`, jamais dans un
  sous-module.** Sans `ToolContext.writable`, les outils d'écriture
  **refusent** — pas d'approbation à la place. Dans un worktree, `.git` est un
  fichier qui désigne le dépôt : le réécrire redirigerait le commit de fin
  ailleurs. Un sous-module y est un dossier vide, et `git add -A` ignore **sans
  un mot** ce qu'on y écrit : l'agent croirait avoir livré.
- **`exec` : l'approbation est la frontière, et aucun processus ne survit.**
  Approbation par défaut ; le binaire est résolu **avant** la demande
  (`Tool.prepare`, entrées relatives du `PATH` ignorées) et **revérifié avant
  de lancer**, pour que l'humain approuve ce qui tourne ; le
  groupe de processus est tué à la sortie, au délai et à l'annulation — vérifié
  en interrogeant les pid au système. **Et si le daemon meurt net** (`SIGKILL`),
  la garde (`packages/tools/src/guard.ts`) tue les groupes qu'il n'a pas pu
  tuer : sans elle, une commande continuait d'écrire dans le worktree. Les
  serveurs MCP et Chromium sont confiés à la même garde.
- **Une approbation porte sur l'opération préparée, et son empreinte sur le
  détail structuré** (`operation_detail`, JSON canonique), jamais sur le texte
  affiché. Le détail est expurgé avant d'être persisté. Ce qui a été approuvé se
  revérifie au moment d'agir : un binaire `exec`, la page et le champ d'une
  saisie au navigateur.
- **Un outil MCP n'est libre que si l'humain l'a coché, et tel qu'il l'a lu** :
  l'empreinte (nom, description, schéma) se compare au catalogue annoncé au
  lancement de la tâche ; un outil changé redevient approuvé à chaque appel.
  Son résultat est toujours non fiable. Le client MCP ne déclare aucune
  capacité (ni `sampling`, ni `roots`, ni `elicitation`).
- **Une phrase de documentation est une affirmation à prouver.** « Binaire
  résolu avant la demande » a été écrit sans être vrai, et le test du même
  sujet vérifiait le défaut (docs/SLICE3.md, leçon n° 10).
- **La branche ne bouge qu'à l'acceptation.** Le harness commite le travail
  d'une tâche **aboutie**, et seulement elle : une tâche qui échoue laisse sa
  branche au commit de départ, son travail lisible dans le worktree, jamais une
  branche qui a l'air d'un résultat. Le worktree est conservé dans tous les cas.
  Pour un Developer lancé directement, accepter et `submit_result` ne font
  qu'un ; délégué par un orchestrateur (`review`), son `submit_result` est une
  **proposition**, commitée seulement quand l'orchestrateur l'accepte
  (`accept_result`). Ce n'est pas une approbation : rien n'est mergé, et le
  merge reste humain.
- **Une liste blanche `exec` se range sous la racine canonique du dépôt**, d'où
  que la CLI soit lancée : rangée ailleurs, elle aurait l'air de marcher et ne
  servirait jamais. Le moteur la lit au départ de la tâche, jamais en route.
  **Un préfixe est jugé trois fois** — CLI, route, et départ de chaque tâche
  (`execRulesForTask`) — par la même règle (`execPrefixRefusal`) : jamais un
  shell, un interpréteur, un lanceur ni un fichier du worktree, Python
  seulement en `-m <module>` ; seuls les outils d'analyse en lecture seule
  (`READ_ONLY_ANALYSIS`) acceptent une option en tête. Un préfixe que la règle
  refuse désormais est **écarté**, jamais réduit à une entrée exacte.
- **Les commits d'agent ne portent ni l'identité ni la signature de
  l'utilisateur** : `Midgaard <agent> <agent@midgaard.invalid>`, `--no-gpg-sign`.
- **Le diff se calcule contre `base_commit`, jamais contre une branche**, et
  inclut les fichiers nouveaux (index temporaire, celui de l'agent intact).
- **`parent_task_id` n'est posé que par le daemon** (`TaskManager.create`,
  appelé par le port de délégation) : aucune route ne l'accepte, sans quoi un
  client rattacherait une tâche à un arbre qui n'est pas le sien.
- **`mode` n'est posé que par le daemon**, comme `parent_task_id` : `chat` pour
  une conversation demandée (`conversation: true`, orchestrateur sans parent),
  `review` pour un Developer délégué par un orchestrateur, `oneshot` sinon.
  **`awaiting_input` est une propriété du statut** `waiting_input` : exigé à
  l'entrée, refusé ailleurs, effacé à la sortie par le dépôt.
- **Un agent créé par un orchestrateur ne dépasse jamais son profil de base
  et n'existe que dans son arbre** : outils et consigne du profil, le rôle
  ajouté après ; limites, serveurs MCP et modèle refusés avec motif au-delà.
  Ailleurs, il répond comme un profil inconnu. **Le budget de l'orchestrateur
  couvre tout son arbre**, contrôlé avant chaque appel de modèle de chaque
  tâche, premier compris.
- **Aucune sous-tâche ne survit à son parent.** Un parent en
  `cancel_requested` ou dans un statut final emporte ses sous-tâches actives ;
  le vérifier en **comptant les tâches actives en base**. Profondeur 1 : un
  orchestrateur ne délègue jamais à un orchestrateur. Et il **ne conclut pas**
  tant qu'une sous-tâche attend sa réponse ou son verdict (`finishBlocked`) :
  la cascade emporterait son travail non commité.

## Pièges d'environnement

- **`security find-generic-password -w` rend l'hexadécimal** dès que le secret
  contient un octet non-ASCII, sans le signaler, et deviner à la relecture est
  impossible (`abcdef` est les deux à la fois). On ne dépose donc que de l'ASCII
  imprimable (`mg1:` + base64).
- **`String.replace` passe le texte entier après les groupes de capture.** Le
  confondre avec un groupe fait chercher tout le document dans le seul motif
  trouvé — l'expurgation ne remplaçait alors rien.
- **`run()` (paquet `secrets`) reconstruit l'environnement du fils à partir
  d'une liste blanche.** Poser une variable dans `process.env` ne la fait donc
  **pas** arriver au processus lancé : il faut la passer en argument (`extraEnv`).
  C'est ce qui faisait ranger toutes les clés DPAPI dans un seul fichier, en
  silence. Même cause pour `secret-tool`, qui a besoin de
  `DBUS_SESSION_BUS_ADDRESS` et `XDG_RUNTIME_DIR` pour joindre le trousseau.
- **Sous Windows, un même dossier a deux noms** : `os.tmpdir()` rend
  `C:\Users\RUNNER~1\…` (nom court 8.3), le harness canonicalise en
  `C:\Users\runneradmin\…`. Seul `realpathSync.native` (ou `fs.promises.realpath`)
  développe le nom court ; `realpathSync` tout court non. Un test qui compare
  à un chemin rendu par le harness emploie donc `.native`.
- **Canonicaliser la racine d'un projet avant toute vérification de chemin** :
  sous un lien symbolique (`/tmp` sur macOS, bien des dossiers personnels), un
  projet voit sinon ses propres fichiers refusés « hors du projet ».
- Node exécute le TypeScript directement, **y compris pour les paquets du
  workspace** : il résout le lien symbolique avant d'appliquer la règle
  `node_modules`. Le développement se passe donc de build ; le dashboard servi
  par le daemon, non (`npm run build`).
- **`erasableSyntaxOnly` est activé** : pas de propriétés de paramètres de
  constructeur (`constructor(readonly x: string)`), pas d'`enum`.
- **Les conditions d'export** (`midgaard-dev`) décident si un paquet se résout vers
  `src/` ou `dist/`. Elles **ne s'héritent pas** par un processus fils : les
  repasser explicitement (voir `nodeArgsFor` dans `tests/helpers.ts`).
- **Le dashboard n'importe de `@midgaard/contracts` que des *types*** : son point
  d'entrée charge `node:os` et `node:fs`.
- `typescript` 7 est le compilateur natif : `tsc` fonctionne, mais l'API JavaScript
  du compilateur n'existe plus (épingler `typescript@5` si un outil en a besoin).
- **Une page plus vieille que son daemon se recharge** quand il sert un autre
  bundle (`apps/dashboard/src/lib/bundle.ts`) : après un `npm run build`, la
  fenêtre desktop restée ouverte ne tourne pas avec l'ancien code.
- L'état runtime vit dans `~/.midgaard`, pas dans le dépôt. `MIDGAARD_HOME` le
  déplace — c'est ce que font toutes les suites de tests.

## Git et CI

- Dépôt : https://github.com/AndyD9/Midgaard-Neo.
- Ne jamais versionner `dist/` ni l'état runtime (`~/.midgaard`, jeton du daemon).
- Quatre workflows : `e2e.yml` (les suites de `npm test` et `test:ui`, sur
  macOS, Linux et Windows),
  `worktrees.yml` (`test:worktrees`), `vault.yml` (`test:vault`, un poste par
  coffre) et `desktop.yml` (la coque compilée et testée).

## Ce qui n'a jamais été constaté

Rien ne doit être écrit comme si ça l'avait été :

1. **L'adaptateur Gemini contre l'API réelle.** Il est écrit d'après la
   documentation REST et vérifié sur réponses enregistrées, jamais exécuté,
   faute de clé Google.
2. **Le grounding `google_search`**, qui partage le tableau `tools` avec les
   `functionDeclarations` : sa cohabitation avec des appels de fonctions n'a
   pas été essayée.
3. **Un outil MCP réel sous approbation, de bout en bout avec un vrai
   modèle** : les essais réels du Midgaard d'origine se sont conclus sans
   qu'un outil du serveur soit appelé (docs/SLICE8.md) ; le chemin est prouvé
   contre le faux serveur seulement (`tests/fake-mcp-server.ts`).
