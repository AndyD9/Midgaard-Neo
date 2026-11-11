# `@midgaard/daemon`

Source de vérité du harness. Un seul daemon tourne par dossier runtime, quel que
soit le nombre de clients : commandes de la CLI, pages du dashboard, fenêtre
desktop.

```text
  CLI harness ──┐
                ├─ HTTP 127.0.0.1 + jeton ─► daemon ─► SQLite
  dashboard ────┘                             │
                                              └─ WebSocket ─► dashboard
```

| Module | Rôle |
|---|---|
| `daemon.ts` | Assemblage : verrou, base, bus, moteur, HTTP, WebSocket, bail, inactivité |
| `lock.ts` | Instance unique : création atomique du verrou, puis bail vérifié chaque seconde |
| `bus.ts` | **Seul chemin d'écriture** : ce qui est écrit est diffusé |
| `task-manager.ts` | Machine à états en marche ; port de délégation d'un orchestrateur et annulation en cascade (Slice 5) |
| `agents.ts` | Profils livrés, rattachement à un fournisseur, choix du fournisseur et du modèle (`PATCH /api/agents/:id`) |
| `mcp-servers.ts` | Serveurs MCP déclarés (Slice 8) : coffre d'abord, test qui lit le vrai catalogue, outils cochés avec leur empreinte |
| `mcp-sessions.ts` | Les serveurs MCP des tâches : lancés au départ, fermés à la fin, tous fermés à l'arrêt |
| `browsers.ts` | Les sessions de navigateur des tâches (Slice 7) : une au plus par tâche, dernière capture en mémoire |
| `files.ts` | Une image d'une tâche, en lecture seule, pour le fil du dashboard (Slice 7) |
| `project-dir.ts` | `checkProjectDir` : le dossier de projet d'une tâche, vérifié avant de la créer |
| `pick-directory.ts` | Le sélecteur de dossier du système, ouvert par le daemon à la demande du dashboard |
| `installation.ts` | Dossier et version de ce daemon, pour reconnaître celui d'une autre installation |
| `http.ts` | Routeur de l'API locale |
| `ws.ts` | Diffusion temps réel et **reprise sans trou** après coupure |
| `security.ts` | `Host` exact, `Origin` en liste blanche, `Sec-Fetch-Site`, jeton porteur |
| `static-files.ts` | Sert le dashboard compilé, ou explique comment le compiler |
| `main.ts` | Point d'entrée : **seul endroit** qui lit l'environnement |

## Ce qui change depuis la Slice 0

- **L'état est persisté.** Une tâche survit au redémarrage ; celles qui étaient
  actives deviennent `interrupted`, jamais reprises ni considérées réussies.
- **Le daemon s'arrête tout seul** après 30 minutes sans tâche active, sans
  dashboard connecté et sans requête. Celui de la Slice 0 survivait à toutes les
  sessions et finissait par tourner avec du code périmé.
- **La configuration est injectée** : seul `main.ts` lit `process.env`.
- **L'API est préfixée `/api`**, et le dashboard est servi sur la même origine.

## Modèle de menace de l'API locale

Écouter sur `127.0.0.1` ne suffit pas : **le navigateur de l'utilisateur est
local**, et une page malveillante peut lui faire émettre des requêtes. C'est la
menace réelle. Un autre processus du même utilisateur peut de toute façon lire le
fichier de découverte ; on ne prétend pas s'en protéger.

| Défense | Ce qu'elle arrête |
|---|---|
| `Host` exact (`127.0.0.1:<port>`) | DNS rebinding : la page fait pointer son domaine vers la boucle locale |
| `Origin` absente ou celle du dashboard | Requêtes inter-sites, y compris celles sans préflight |
| `Sec-Fetch-Site` ∈ {`same-origin`, `none`} | Confirmation directe par le navigateur |
| Jeton porteur, comparé à temps constant | Tout client qui n'a pas lu `daemon.json` (`0600`) |

Les fichiers d'état sont lisibles du seul utilisateur : `daemon.json`, le
journal et **la base**, en `0600` depuis la Slice 4 — elle était créée selon
l'umask, donc en `0644`, et gardait objectifs, contexte, sorties d'outils et
diffs à la portée des autres comptes du poste. Une base plus ancienne est
resserrée à l'ouverture. Prouvé par `tests/security.ts` (X4), qui vérifie aussi
qu'aucune autre interface que la boucle locale ne répond.

`/ui/bootstrap` et les fichiers du dashboard sont servis **sans jeton** — le
navigateur n'en a aucun avant d'avoir chargé la page — mais restent soumis aux
contrôles d'enveloppe, qui sont précisément ce qui arrête une page hostile.

## Délégation entre tâches (Slice 5)

Une tâche `orchestrator` délègue par le port que lui remet
`TaskManager.delegationFor`. Ce que le daemon garantit :

- **`parent_task_id` n'est posé que par lui.** Aucune route HTTP ne l'accepte ;
  `create` applique les règles d'une sous-tâche : parent actif et
  orchestrateur, enfant qui n'en est pas un (profondeur 1), dossier du parent
  imposé.
- **Aucun orphelin.** Le gérant écoute le bus : dès qu'une tâche passe en
  `cancel_requested` ou dans un statut final, ses sous-tâches actives sont
  annulées. Écouter le bus plutôt que chaque chemin de fin, parce qu'il y en a
  une dizaine et que le bus les voit tous. L'annulation est **différée d'une
  micro-tâche** : le bus diffuse de façon synchrone, et annuler pendant la
  diffusion du parent enverrait à la WebSocket des `seq` dans le désordre.
- **Ce que le modèle écrit dans une délégation est expurgé** — objectif,
  contexte, motif d'annulation — avec le `redact` de la tâche parente, avant
  d'être persisté.
- **Attendre ne coûte rien.** `wait` bloque en mémoire jusqu'à la fin de
  l'enfant, l'arrêt du parent ou son échéance ; une pause d'approbation ne
  l'interrompt pas, et un `subtask.waiting` écrit sur le parent dit au
  dashboard qui il attend.

Prouvé par `tests/unit/delegation.test.ts`, qui compte les tâches actives
**en base** après l'arrêt du parent.

## Agents créés et budget de l'arbre (Slice 8)

Un orchestrateur crée ses exécutants par `create_agent`
(`TaskManager.createAgent`). Un agent créé est une ligne de `created_agents`,
rattachée à **sa** tâche : `agentFor` le résout à partir de son profil de base
— mêmes outils, consigne du profil **puis** le rôle —, et `create` le refuse
hors de son arbre, avec la réponse d'un profil inconnu. Tout ce qui dépasserait
le profil de base est **refusé avec le motif** : serveurs MCP que le
profil n'a pas, fournisseur inconnu, modèle non offert.

**Aucune limite ne borne une tâche** (décision de l'auteur, 2026-11-11) : ni
étapes, ni budget, ni délai, pour une tâche comme pour un arbre. `delegate`
ne refuse une sous-tâche que lorsque `maxActiveSubtasks` sont déjà actives
(`MIDGAARD_MAX_ACTIVE_SUBTASKS`, 4 par défaut). Une tâche d'agent a
`steps_total: 0` : aucun nombre d'étapes n'est prévu, et l'affichage n'invente
pas de dénominateur. Les colonnes `limits_json` restent en base, remplies de
`{}` : une migration publiée ne se modifie plus.

## Conversations (Slice 6)

Une tâche peut attendre un **message** : `waiting_input`, avec ce qu'elle
attend dans `awaiting_input`. Le moteur l'ouvre par
`EngineContext.requestInput`, le gérant écrit la transition et son
`input.requested`. Ce que le daemon garantit :

- **Le mode est posé par lui.** `POST /api/tasks` accepte `conversation: true`
  comme une demande. Le gérant ne pose `chat` que pour un orchestrateur sans
  parent, et refuse (`conversation_unsupported`) autrement. Le champ `mode`
  envoyé par un client est ignoré.
- **Un message n'entre que dans une attente.** `POST /api/tasks/:id/messages`
  refuse `task_not_conversational`, `task_not_awaiting_user` et `empty_message`
  sans rien écrire. Un message glissé pendant que l'agent travaille
  arriverait au milieu de son raisonnement.
- **Le message est expurgé par le moteur**, qui connaît la clé de la tâche,
  puis écrit **avec** la reprise (`waiting_input → running`) en une seule
  écriture. L'agent lit la version expurgée : ce que le journal garde est ce
  qu'il a lu.
- **Une attente oubliée expire.** Le balayage des approbations arrête en
  `timed_out` une conversation sans réponse depuis `MIDGAARD_INPUT_TTL_S`. Une
  annulation passe par `cancel_requested`, et le moteur réveillé conclut.

Prouvé par `tests/unit/conversation.test.ts`, sur le vrai moteur et un faux
fournisseur, en HTTP compris.

La même attente porte **l'échange entre un orchestrateur et ses sous-tâches** :

- **Un Developer délégué par un orchestrateur est en `review`** (`create`). Son
  `submit_result` le met en attente (`proposal`) ; rien n'est commité.
  `accept` (port) l'écrit comme un message du parent (`verdict: accepted`), la
  boucle conclut, et `commitWork` commite. `send` le relance avec un retour.
- **Une question** (`ask_parent`, toute sous-tâche) le met en attente
  (`question`) ; `send` y répond.
- **`waitForEnd` rend la main sur une attente du parent** (`awaiting_you`), et
  `stateFor` y joint la question, ou la proposition et son diff, expurgé par le
  parent.
- **Le parent ne conclut pas** tant qu'un enfant attend : le crochet
  `finishBlocked` du moteur refuse son `submit_result`, que le modèle reçoit.
  S'il s'arrête autrement, la cascade annule l'enfant, sans commit.

Prouvé par `tests/unit/review-loop.test.ts`, sur un vrai dépôt Git : la
branche d'un Developer est relue à **l'instant** où il attend son verdict.
`Daemon.subscribe` existe pour cela : s'abonner au bus du même processus, sans
pouvoir y écrire.

## Sortie des commandes en direct (Slice 6)

Le moteur écrit chaque lot de sortie d'un `exec` en `exec.output`, sans
changer de statut, avec l'identifiant de l'appel (`tool_call_id`). Les lots
arrivent déjà découpés, expurgés et plafonnés (`OutputBatcher`, dans
`agent-runtime`). Persistés comme tout événement, ils sont rejoués à la
reconnexion : un terminal rechargé retrouve ce qu'il avait. Prouvé par
`tests/unit/exec-output.test.ts`, avec une vraie commande qui écrit une clé en
deux fois.

## Choisir le dossier d'une tâche dans l'explorateur

`POST /api/dialogs/directory` ouvre le sélecteur de dossier **du système**, sur
le poste du daemon, et rend le chemin choisi (`pick-directory.ts`). C'est le
daemon qui l'ouvre, pas la page : un navigateur ne donne jamais le chemin
absolu d'un dossier, et la coque desktop n'accorde aucune capacité Tauri à la
page.

| Plateforme | Dialogue |
|---|---|
| macOS | `osascript` (`choose folder`) |
| Windows | PowerShell (`FolderBrowserDialog`) |
| Linux | `zenity`, sinon `kdialog`, trouvés dans les entrées absolues du `PATH` ; rien sans `DISPLAY` ni `WAYLAND_DISPLAY` |

- **Rien n'est lu ni listé** : le daemon n'apprend que le chemin que l'humain
  a désigné. Aucune route ne parcourt le disque.
- **Le chemin choisi est jugé comme un chemin tapé** (`checkProjectDir`) : le
  dossier personnel ou la racine, choisis dans l'explorateur, sont refusés
  (400, avec le motif).
- **Le dossier de départ (`start_dir`) n'entre jamais dans un script** : il
  voyage en argument (`argv` d'AppleScript, option de zenity) ou en variable
  d'environnement (PowerShell).
- **Un dialogue à la fois** (409 sinon), sans délai : l'humain décide quand il
  a fini. Le dialogue est tué si le client part et à l'arrêt du daemon ; lancé
  dans son propre groupe, il est confié à la garde des processus pour le cas
  du daemon tué net.
- **Annoncé seulement s'il existe** : `health.directory_picker` est vrai quand
  un dialogue peut s'ouvrir ; sinon le journal du daemon dit pourquoi, la route
  répond 501 avec le motif, et le dashboard ne montre pas « Parcourir… ».

Prouvé par `tests/unit/pick-directory.test.ts` (commande des trois plateformes,
faux programme de dialogue dont le pid est compté après l'abandon, route avec
un sélecteur injecté). **Constaté sous macOS seulement, et en partie** : le
vrai dialogue s'ouvre et se ferme à l'abandon ; un choix fait à la souris et
la place de la fenêtre au premier plan n'ont pas été regardés. Les dialogues
Windows et Linux n'ont jamais été lancés.

## Une image d'une tâche, en lecture seule (Slice 7)

`GET /api/tasks/:id/files/image?path=` rend, en octets, une image de la tâche
— celle qu'un agent a lue par `read_image`, pour le fil du dashboard
(`files.ts`). Elle est cherchée dans le worktree d'un Developer, ou dans le
dossier de projet d'une tâche qui ne fait que lire. C'est **la seule lecture
de fichier de l'API** : ni arbre, ni contenu, ni méthode d'écriture. Ce que le
daemon garantit :

- **Le chemin est traité comme celui d'un modèle** : relatif, sans `..`,
  résolu et ouvert par `openUnderRoot` (racine canonique, identité du
  descripteur revérifiée).
- **Rien sous `.git`**, à aucun niveau, en toute casse, **et sur le chemin
  réel** : un lien posé dans le worktree (`x → .git`) reste sous la racine, et
  n'est arrêté que par cette relecture.
- **Le type se lit dans les octets** (PNG, JPEG, WebP, GIF — jamais un SVG),
  4 Mo au plus, comme pour l'outil `read_image`.
- **L'image est lue sur le disque, maintenant** : aucune n'est gardée en base,
  et son SHA-256 (en-tête `x-midgaard-sha256`) dit si c'est encore celle que
  l'agent a vue.

Prouvé par `tests/unit/task-files.test.ts`, en HTTP. Le lien vers `.git` y a été
vu passer sans la relecture du chemin réel.

## Un modèle qui lit les images (Slice 7)

Au départ d'une tâche dont le profil a `read_image`, le moteur décide si le
modèle lit les images (`visionOf`) : le catalogue du fournisseur d'abord
(`ProviderAdapter.capabilities`, Venice), la déclaration du profil sinon
(`agents.vision`, réglée par `PATCH /api/agents/:id` avec `vision`), non à
défaut. Sans vision, `read_image` n'est pas proposé au modèle, et une note le
dit dans la timeline. Une déclaration tombe quand le modèle du profil change.
Aucune image n'est écrite en base (`tests/unit/vision.test.ts` lit la base et
son WAL).

## Le Navigator : refusé avec son motif quand il est aveugle (Slice 7)

Le profil `navigator` (type `navigator`, `agents.ts`) se sert du navigateur et
lit le projet ; ni écriture, ni `exec`, ni `http_fetch`. Il voit par des
captures : son modèle doit lire les images. Le gérant retient ce que le moteur
a **constaté** (`noteVision`), pour le fournisseur et le modèle effectifs —
un constat tombe de lui-même quand le profil change de modèle. Le constat se
fait :

- **au démarrage** du daemon, sans le retarder ;
- **après un réglage** (`PATCH /api/agents/:id`) ou l'ajout d'un fournisseur,
  attendu au plus 5 s avant de répondre ;
- **au départ de chaque tâche**, qui reste l'autorité : un Navigator aveugle
  s'arrête en `failed` avant tout appel de modèle, avec le motif.

Constaté aveugle, il est **refusé à la création** (`agent_disabled`, rien n'est
créé) et **montré désactivé avec son motif** par `GET /api/agents`, qui rend
la vue du profil (`enabled` : utilisable maintenant ; `disabled_reason`) et non
la ligne en base. Prouvé par `tests/unit/navigator.test.ts`, dans un vrai
daemon, avec la coupure humaine et la fermeture avant conclusion.

## Les sessions de navigateur (Slice 7)

`browsers.ts` tient le navigateur isolé de chaque tâche : une session au plus,
ouverte par `browser_open` une fois approuvée, remise aux outils par un
`BrowserPort` (`portFor`). Le moteur ne pose ce port que pour un profil qui a
des outils `browser_*`, et retire ces outils, comme `read_image`, d'un modèle
qui ne lit pas les images. Une session se ferme :

- à son **échéance**, par un minuteur, que l'agent agisse ou non ;
- quand **l'humain la coupe** (`POST /api/tasks/:id/browser/close`) — un acte
  humain, qu'aucun outil n'expose ; l'agent l'apprend à son action suivante ;
- quand l'agent appelle `browser_close` ;
- avec **la tâche**, avant sa conclusion (`endTask`) : une ouverture encore en
  cours est refermée dès que Chromium répond, et aucune autre ne s'ouvre ;
- avec **le daemon** (`closeAll`) ; tué net, c'est la garde des processus.

Le journal reçoit `browser.opened` et `browser.closed`, expurgés ; les actions
y sont comme appels d'outil. La dernière capture reste **en mémoire**
(`frame`) : le dashboard la lit par `GET /api/tasks/:id/browser/frame`, qui rend
404 dès la session fermée. Aucune n'est écrite.

Les octets d'image (cette capture, et une image du projet par
`GET /api/tasks/:id/files/image`, type lu dans les octets, jamais un SVG) sont
servis avec `nosniff` et une politique de contenu vide : ils viennent d'une page
web ou d'un worktree écrit par l'agent, et ne doivent pas pouvoir devenir une
page. La garde réseau est celle
d'`http_fetch`, plus la liste blanche quand la politique HTTP est `allowlist`
(`defaultBrowserGuard`). Playwright n'est chargé qu'à la première session.

## La liste blanche `exec` à préfixes (Slice 9)

`POST /api/exec-allow` accepte `prefix` : l'entrée couvre alors tout argv qui
commence par ses mots (`exec_allow.prefix`, migration 15). La route **juge**
le préfixe par `execPrefixRefusal` (`@midgaard/contracts`) même si la CLI l'a
déjà fait, et rend `400 prefix_refused` avec son motif ; un ajout rend
`outcome` (`added`, `widened` quand une entrée exacte devient préfixe,
`unchanged`), journalisé. Au départ d'une tâche, `execRulesForTask` **rejuge
chaque préfixe enregistré** : celui que la règle refuse désormais est écarté
— il ne devient pas une entrée exacte — et la timeline le dit. Un appel
`exec` passé sans humain porte `allow_reason` dans son `tool.requested`, qui
nomme la règle, et le préfixe le cas échéant.

## Les serveurs MCP déclarés (Slice 8)

`mcp-servers.ts` suit le chemin des fournisseurs : **le coffre d'abord, la
base ensuite** pour les variables secrètes, dont la base ne garde que le nom ;
et un « Tester la connexion » qui **prouve** : le serveur est lancé
(`@midgaard/mcp-client`, sous la garde des processus, dans le dossier
runtime), `initialize` puis `tools/list`, et le test n'est réussi que si le
catalogue est revenu. Un échec cite le début et la fin de la sortie d'erreur
du serveur, **expurgés** des valeurs secrètes — un serveur peut répéter son
jeton en échouant, `tests/unit/mcp-servers.test.ts` le fait exprès et lit la
base octet par octet.

Le programme est vérifié à la déclaration **et** à chaque lancement (absolu,
présent, exécutable ; ni `.cmd` ni `.bat` sous Windows). Il est gardé tel que
déclaré, pas canonicalisé : `node` de Homebrew est un lien vers un dossier
versionné, qu'une mise à jour fait disparaître.

On ne coche que le **catalogue constaté** : rien sans test réussi, rien qui n'y
figure pas. Chaque outil coché garde l'empreinte de ce que l'humain a lu ;
redéclarer un serveur efface son catalogue, et le test suivant dit quels
outils cochés le serveur annonce désormais autrement (`changed`). Chaque
autorisation est journalisée avec son auteur.

### Les serveurs d'une tâche (étape 3)

Un profil porte `mcp_servers` (`PUT /api/agents/:id/mcp`, liste complète) ;
seuls `researcher`, `developer` et `navigator` en reçoivent — l'orchestrateur
**délègue** à un profil qui les a (décision 11). Au départ d'une tâche, en
`preparing`, `McpSessions` lance **chaque** serveur du profil dans la racine de
la tâche (le worktree d'un Developer), lit son catalogue **maintenant**, et le
compare aux outils cochés lus **maintenant** : c'est là que l'empreinte fait
son travail. Tout ou rien : un serveur qui ne démarre pas ferme les autres et
fait échouer la tâche **avant** tout appel de modèle, avec sa raison. Les
valeurs secrètes des serveurs rejoignent l'expurgation de la tâche. La
timeline dit, par serveur, combien d'outils sont libres, combien ont changé,
et lesquels ont été écartés.

Les serveurs se ferment **avant** la conclusion (et avant le commit d'un
Developer), dans le `finally` du moteur, et tous à l'arrêt du daemon ; un
daemon tué net les laisse à la garde. Le catalogue est **figé** au départ : un
`tools/list_changed` en cours de route n'ajoute rien à la tâche.

Retirer un serveur le retire des profils qui l'avaient, et le dit.

## Installation

`/api/health` annonce `install` : le dossier canonique du paquet
`@midgaard/daemon` et sa version (`installation.ts`, exporté seul par
`@midgaard/daemon/installation` pour que la CLI ne charge pas tout le
daemon). `POST /api/shutdown` accepte `{ "if_idle": true }`, qui rend `409`
tant qu'une tâche est active : c'est ainsi que la CLI d'une autre
installation remplace ce daemon sans jamais interrompre de travail.

Le dashboard est servi depuis `apps/dashboard/dist` du dépôt (`npm run build`).

## Instance unique

Verrou créé **avec son contenu** (`link` sur un fichier temporaire portant déjà le
pid), puis bail vérifié chaque seconde : un daemon qui ne lit plus son pid dans le
verrou s'arrête. Deux daemons peuvent coexister au plus une seconde, au démarrage,
sans tâche en cours. Le détail de la course et de sa correction est dans
[`docs/SLICE0.md`](../../docs/SLICE0.md).

## Variables d'environnement

Lues **uniquement** par `main.ts`, via `loadConfig`.

| Variable | Défaut | Effet |
|---|---|---|
| `MIDGAARD_HOME` | `~/.midgaard` | Dossier d'état runtime (base, verrou, journal) |
| `MIDGAARD_PORT` | `7777`, repli sur un port libre | Port d'écoute. Fixé explicitement, un port occupé devient une erreur |
| `MIDGAARD_IDLE_SHUTDOWN_S` | `1800` | Inactivité avant arrêt ; `0` désactive |
| `MIDGAARD_APPROVAL_TTL_S` | `600` | Délai de décision humaine ; au-delà la tâche passe en `timed_out` |
| `MIDGAARD_INPUT_TTL_S` | `7200` | Attente maximale d'une réponse de l'utilisateur dans une conversation ; au-delà, `timed_out` |
| `MIDGAARD_MAX_ACTIVE_SUBTASKS` | `4` | Sous-tâches actives d'un orchestrateur en même temps (Slice 8) |
| `MIDGAARD_DASHBOARD_DIR` | `apps/dashboard/dist` | Fichiers compilés du dashboard |
