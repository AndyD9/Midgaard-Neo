# Dépannage

**Commence toujours par `npm run doctor`**, à la racine du clone.
Il examine Node, le dossier runtime, la base — sans jamais l'écrire —, le
daemon, la déclaration MCP du dossier courant, le dashboard, le coffre, les
tarifs, les fournisseurs, Git, les worktrees et la liste blanche `exec`, et
donne pour chaque problème la commande qui le corrige. Ses avertissements (`!`)
ne sont pas des échecs ; seuls les `✘` font rendre `1`.

Ensuite, deux fichiers disent presque tout, dans `~/.midgaard` (ou
`MIDGAARD_HOME`) :

| Fichier | Contenu |
|---|---|
| `daemon.log` | Le journal du daemon : démarrage, coffre retenu, port, refus, arrêt |
| `mcp-trace.jsonl` | Ce que le serveur MCP a vu du client : capacités, attentes, coupures |

Les messages cités ci-dessous sont ceux du code, tels qu'ils s'affichent. Les
commandes se lancent à la racine du clone : Midgaard ne s'installe que depuis
le dépôt, et aucun binaire `harness` n'est dans le `PATH`.

---

## Claude Code et le serveur MCP

### Les outils `harness_*` n'apparaissent pas dans Claude Code

Claude Code ne relit `.mcp.json` **qu'à l'ouverture d'une session**. Après
`npm run init`, ouvre une **nouvelle** session sur ce dossier et accepte le
serveur `midgaard` quand il est proposé. La déclaration est propre au dossier :
une session ouverte ailleurs ne la voit pas.

### `doctor` : « pointe vers des chemins qui n'existent plus »

`init` écrit des **chemins absolus** — celui de `node` et celui du serveur MCP —
parce que l'app desktop de Claude Code ne lance pas les serveurs avec le `PATH`
d'un terminal. Un changement de version de Node (nvm, Homebrew) ou un clone
déplacé les rendent faux, et Claude Code échoue alors sans rien dire d'utile.
Relance :

```bash
npm run init
```

« pointe vers une autre installation » dit la même chose en moins grave : la
déclaration désigne un autre Midgaard (un autre clone, une autre version) que
celui où tu lances la commande.

### `npm run init` : « … existe mais n'est pas du JSON valide »

`init` ne réécrit pas un `.mcp.json` qu'il ne sait pas lire, pour ne pas perdre
les autres serveurs qui y sont déclarés. Corrige le fichier ou supprime-le, puis
relance `npm run init`.

### « le daemon n'a pas démarré en 8000 ms (voir …/daemon.log) »

Le serveur MCP (ou la CLI) a lancé le daemon, qui est mort avant de répondre. La
cause est **dans `daemon.log`**, presque toujours l'une de celles-ci :

- **un port imposé déjà pris** — voir « Port 7777 occupé » plus bas ;
- **`MIDGAARD_VAULT` inconnu ou indisponible** — voir « Le coffre » ;
- **une base plus récente que ce code** — voir « La base ».

### L'agent lit le mauvais dossier

Le dossier qu'un agent a le droit de lire est celui que **Claude Code** annonce
au serveur MCP (capacité `roots`). Si le client ne l'annonce pas, le serveur se
rabat sur son dossier de travail, et l'écrit sur sa sortie d'erreur :
« roots/list indisponible, repli sur le dossier de travail ». Ouvre la session
Claude Code **sur le dossier du projet** lui-même.

### « Delegation refused (invalid_project_dir) » ou refus du formulaire « Nouvelle tâche »

Le daemon vérifie le dossier qu'un agent aura le droit de lire, d'où que vienne
la tâche (Slice 5). Les motifs, mot pour mot :

- « le dossier de projet doit être un chemin absolu : « … » » ;
- « le dossier de projet n'existe pas : « … » » ;
- « le dossier de projet n'est pas un dossier : « … » » ;
- « la racine du système ne peut pas être un dossier de projet : choisis le
  dossier du dépôt » ;
- « le dossier personnel ne peut pas être un dossier de projet : un agent y
  lirait tout. Choisis le dossier du dépôt ».

Les deux derniers frappent aussi une session Claude Code ouverte sur `~` ou
sur `/` : ouvre-la **sur le dossier du dépôt**. Au dashboard, saisis le chemin
absolu du dépôt. Le profil `simulated`, qui ne lit rien, n'est pas concerné.

### Une attente est coupée, ou rend la main sans résultat

Un client MCP coupe un appel d'outil resté 60 s sans signe de vie. Midgaard
attend donc par tranches de 15 s, avec une notification de progression entre
chacune, et `harness_wait_for_task` ne dépasse pas 600 s par appel : c'est
normal que Claude l'appelle plusieurs fois. « Wait interrupted by the client.
The task keeps running. » veut dire ce qu'il dit : la tâche continue, il suffit
d'attendre de nouveau.

Une pause d'approbation n'est annoncée **qu'une fois** à chaque client ; les
attentes suivantes bloquent jusqu'à ta décision.

---

## Le daemon

### Port 7777 occupé

Sans réglage, le daemon se rabat sur un port libre et l'écrit dans
`daemon.log` (« port 7777 occupé, repli sur un port libre ») : le dashboard
change alors d'adresse. `npm run harness -- start` et `npm run harness -- status` disent laquelle.

Si `MIDGAARD_PORT` est fixé, il n'y a **pas** de repli : un port occupé
empêche le démarrage. Libère le port, ou retire la variable.

### Le dashboard répond `403` ou `401`

Le daemon refuse tout `Host` autre que `127.0.0.1:port` ou `localhost:port`,
toute `Origin` étrangère, et toute requête intersite — c'est ce qui empêche une
page web quelconque de piloter ton harness. Les réponses `forbidden_host`,
`forbidden_origin` et `forbidden_fetch_site` viennent de là. Ouvre exactement
l'adresse que donne `npm run harness -- start`, sans proxy ni autre nom d'hôte.

`401 unauthorized` : le jeton du daemon a changé (redémarrage). Recharge la page.

### `doctor` : « d'une autre installation » ou « d'une autre version »

Un clone et une installation npm partagent `~/.midgaard`, donc un seul daemon.
Un daemon **d'un autre protocole** est remplacé au prochain appel. Un daemon
**d'une autre installation** (autre dossier ou autre version) est remplacé
**s'il est oisif** ; s'il a une tâche en cours, il la termine et reste servi tel
quel jusque-là. Pour le remplacer tout de suite :

```bash
npm run harness -- stop
```

### Le daemon s'arrête tout seul

Après 30 minutes sans tâche active, sans dashboard ouvert et sans requête
(« arrêt (inactif depuis N min) » au journal). Le prochain appel MCP ou la
prochaine commande le relance. `MIDGAARD_IDLE_SHUTDOWN_S=0` désactive l'arrêt.

### « un autre daemon détient le verrou, sortie »

Normal : un seul daemon par dossier runtime, et le second lancé s'efface. Après
un arrêt brutal, le suivant récupère le verrou (« verrou périmé (pid N),
récupération »). Si `doctor` signale un pid **vivant mais injoignable**, il
donne la commande `kill` exacte.

### Des tâches sont `interrupted`

Toute tâche trouvée en cours au démarrage du daemon devient `interrupted`
(« tâche interrompue par un redémarrage du daemon ») : elle n'est **jamais**
reprise ni considérée réussie, et ses approbations expirent. Son worktree est
conservé. Délègue-la de nouveau.

### La base

- `doctor` : « à migrer (rien n'a été écrit) » — la base vient d'une version
  plus ancienne. Le daemon de cette version la migrera à son démarrage :
  `npm run harness -- start`.
- « base en version de schéma X, ce code en connaît Y » — la base vient d'une
  version **plus récente** de Midgaard. Mets Midgaard à jour, ou désigne une
  autre base avec `MIDGAARD_HOME`.

---

## Le coffre et les fournisseurs

### `doctor` : coffre « fichier », pas de protection système

Aucun coffre système n'a répondu, et les clés iront **en clair** sous
`~/.midgaard/secrets`. Le conseil de `doctor` dépend de la plateforme :

- **Linux** : installe libsecret (`secret-tool`) et ouvre une session de
  bureau. Sans bus de session (`DBUS_SESSION_BUS_ADDRESS` absent : session SSH,
  conteneur), libsecret est écarté. Sur un serveur sans trousseau, il n'y a
  rien à installer : le repli fichier est la bonne réponse.
- **macOS** : le trousseau est livré avec le système ; vérifie que
  `security default-keychain` nomme un trousseau. Un `HOME` qui n'est pas
  celui de ta session (`HOME=… npm run …`) n'en a pas : macOS le cherche sous
  `~/Library/Keychains`, et Midgaard se rabat alors sur le fichier plutôt que
  de rester bloqué derrière une fenêtre « aucun trousseau trouvé ».
- **Windows** : DPAPI passe par `powershell.exe` — Windows PowerShell 5.1,
  livré avec le système —, qui doit être dans le `PATH` ; `pwsh` seul ne
  suffit pas.

Si tu poses toi-même `MIDGAARD_VAULT=file`, `doctor` le dit comme un choix, pas
comme une panne.

### « MIDGAARD_VAULT=… inconnu » ou « … indisponible sur cette machine »

Un coffre imposé n'est jamais remplacé en silence : le daemon refuse de
démarrer. Valeurs possibles : `macos-keychain`, `windows-dpapi`, `libsecret`,
`file`. Retire la variable pour laisser Midgaard choisir.

### « … n'a pas rendu la main en N s et a été tué »

L'outil du coffre (`security`, `secret-tool`, PowerShell) est resté bloqué — le
plus souvent un trousseau verrouillé qui attend un mot de passe. Déverrouille-le
et recommence.

### « Delegation refused (agent_disabled) »

Le profil demandé n'a pas de fournisseur (« aucun fournisseur de modèle n'est
configuré pour ce profil »), ou son fournisseur a été retiré. `npm run harness -- agents`
dit pourquoi chaque profil est désactivé. Déclare un fournisseur :

```bash
npm run harness -- providers add venice --model deepseek-v4-flash-0731
```

Ou, sans terminal : au dashboard, « Profils », carte « Fournisseurs ».

### « Delegation refused (agent_disabled) » pour le `navigator`

Le Navigator voit le navigateur par des captures : son modèle doit lire les
images (Slice 7). Le motif dit d'où vient le constat :

- « le modèle « … » ne lit pas les images, d'après le catalogue de son
  fournisseur » : choisir un modèle qui les lit dans « Profils » (chez Venice,
  `mistral-small-3-2-24b-instruct` par exemple) ;
- « rien ne dit que le modèle « … » lit les images : son fournisseur ne le
  publie pas » : si le modèle les lit, le déclarer sur le profil,
  `PATCH /api/agents/navigator` avec le corps `{"vision": true}` ;
- « le modèle « … » est déclaré ne pas lire les images » : la déclaration le
  dit ; changer de modèle, ou corriger la déclaration.

Le daemon constate la capacité au démarrage et à chaque réglage d'un profil ;
une tâche lancée avant le constat s'arrête en `failed` avec le même motif,
avant tout appel de modèle, sans rien coûter.

### « aucune clé d'API pour « … » »

Le fournisseur est déclaré, mais sa clé n'est plus dans le coffre (trousseau
réinitialisé, autre machine). Le message donne la commande complète qui la
redépose. En dépannage seulement, le daemon lit aussi la clé dans une variable
d'environnement (`VENICE_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`MIDGAARD_PROVIDER_API_KEY` pour `custom`), à condition qu'elle soit dans
l'environnement **du daemon** : arrête-le, puis relance-le depuis ce terminal.

### Le test de connexion échoue

- « clé refusée par le fournisseur (401) » : la clé est fausse ou révoquée.
- Joignable, mais « … n'en fait pas partie » : l'endpoint ne propose pas le
  modèle choisi ; vérifie l'identifiant passé à `--model`.
- En pleine tâche, « appel modèle refusé : HTTP 401 » : même cause. Les erreurs
  400, 401 et 403 ne sont pas retentées ; 408, 409, 429 et 5xx le sont.

---

## Les tâches et les coûts

### `budget_exceeded`

« budget de X $ atteint » : un plafond a été atteint, **rien n'a échoué**. Le
budget d'un profil est un plafond : une délégation peut l'abaisser, jamais le
relever.

### `failed` : « limite de N étapes atteinte sans résultat soumis »

L'agent n'a pas conclu à temps. Une tâche ne se termine que par
`submit_result` : un modèle qui écrit « j'ai fini » n'a pas fini. Relève
`max_steps` jusqu'au plafond du profil, ou — le plus souvent — **simplifie
l'objectif** : un objectif qui appelle une réponse longue fait couper la sortie
du modèle avant qu'il ait pu conclure. Une tâche qui échoue a déjà dépensé.

### `budget_exceeded` : « budget de l'arbre de tâches, … $, atteint »

Le budget de l'orchestrateur couvre **tout son arbre** : ses appels et ceux de
chaque sous-tâche (Slice 8). Une sous-tâche s'arrête dès que sa dépense plus
celle des autres l'atteint, et l'orchestrateur ne peut plus déléguer. Pour un
arbre plus large, relève le budget du profil `orchestrator` (confirmation
demandée) : `npm run harness -- agents limits orchestrator --max-cost 1`, ou aux
Profils du dashboard.

### `timed_out` : un premier appel Ghidra dépasse le délai du profil

REA laisse jusqu'à 330 s à Ghidra pour importer et analyser un binaire ; le
Researcher a 300 s par défaut pour **toute** sa tâche. Relève son délai avant
de lui confier un binaire natif : `npm run harness -- agents limits researcher --timeout 900`.

### `agents limits` : « pas de terminal pour confirmer »

Relever une limite se confirme : le budget est ce qui arrête une dépense qui
s'emballe. Sans terminal, la CLI refuse ; `--yes` passe outre, en connaissance
de cause. Abaisser ne demande rien.

### « … subtask(s) are already running, the maximum at the same time »

L'orchestrateur a déjà autant de sous-tâches actives que le plafond le
permet ; il doit en attendre ou en annuler une. Le plafond se règle par
`MIDGAARD_MAX_ACTIVE_SUBTASKS` (4 par défaut), dans l'environnement du daemon,
puis `npm run harness -- stop`.

### « tarif inconnu pour « … » : le budget en dollars ne peut pas être appliqué »

Sans tarif, seul le nombre d'étapes borne la tâche, et le coût s'affiche
« inconnu » — jamais `0 $`. Les tarifs livrés ne couvrent que Venice ; pour
Venice, relève-les :

```bash
npm run harness -- pricing refresh venice
```

### Le dashboard ne montre pas la demande d'approbation

Deux installations ont chacune leur daemon, et le premier lancé tient le port
7777. L'en-tête du dashboard affiche le dossier runtime du daemon qu'il sert :
s'il n'est pas celui de la tâche, ouvre l'URL donnée par la consigne
d'approbation. `npm run harness -- status` le dit aussi : « port 7777 occupé —
sans doute le daemon d'une autre installation, dont le dashboard n'est pas
celui-ci : ce daemon écoute sur … ».

### `timed_out` : « aucune décision humaine en 10 minutes »

Une demande d'approbation expire au bout de 10 minutes
(`MIDGAARD_APPROVAL_TTL_S`), et la tâche s'arrête plutôt que d'attendre
indéfiniment. Une approbation arrivée après : `approval_already_resolved`.

### `timed_out` : « aucune réponse de l'utilisateur en 120 minutes »

Une conversation avec l'orchestrateur attend votre réponse au plus deux heures
(`MIDGAARD_INPUT_TTL_S`), puis s'arrête : oubliée, elle garderait le daemon en
vie, et l'orchestrateur ses sous-tâches. Ce qu'elle avait produit reste dans
sa timeline ; ouvrez une nouvelle conversation pour reprendre.

### `task_not_awaiting_user` en écrivant à une conversation

Le message n'est accepté que lorsque la conversation **attend** votre
réponse (`waiting_input`). Pendant que l'orchestrateur travaille, ou une fois
la tâche finie, il est refusé sans rien écrire. Attendez sa réplique, puis
écrivez.

### `npm run harness -- approve` ne fait rien

- « Aucune demande d'approbation en attente. » — elle a été décidée, ou a expiré.
  Ou bien la commande vise un autre dossier runtime : celle de la consigne
  porte `--home "…"` quand le daemon n'est pas sur `~/.midgaard`, et se lance
  telle quelle, d'où qu'on soit.
- « Plusieurs demandes attendent, précise laquelle : » — chaque ligne qui suit
  est une commande complète, prête à copier. L'identifiant attendu est celui
  de la **demande**, pas celui de la tâche.

---

### « read_image retiré : … » dans la timeline

Le modèle du profil ne lit pas les images, ou rien ne dit qu'il les lit. Le
motif cité dit lequel :

- « cannot read images (catalogue of provider … » : le fournisseur publie que
  ce modèle ne lit pas les images. Choisir un modèle qui les lit dans
  « Profils » (chez Venice, `mistral-small-3-2-24b-instruct` par exemple) ;
- « does not say whether model … reads images, and this profile does not
  declare it » : le fournisseur ne publie pas la capacité (OpenAI, endpoint
  `custom`). Si le modèle lit les images, le déclarer sur le profil, par
  l'API du daemon — pour le Researcher, `PATCH /api/agents/researcher` avec le
  corps `{"vision": true}`. Le dashboard n'a pas encore de case pour cela
  (Slice 7, étape 6). La déclaration tombe quand le modèle change.

## Le `developer` et les worktrees

### `failed` : « worktree impossible : … »

- « … n'est pas dans un dépôt Git » : le `developer` ne travaille que dans un
  dépôt Git. `git init`, puis un premier commit.
- « le dépôt n'a encore aucun commit » : un premier commit suffit.
- « git est introuvable dans le PATH du daemon » : installe Git (2.17 ou plus),
  puis `npm run harness -- stop` pour que le daemon relancé le trouve.

### Mes modifications en cours ne sont pas dans le worktree

Le worktree part du **dernier commit**. Le résultat le signale (« … uncommitted
change(s) that were NOT in the agent's worktree ») : commite avant de déléguer
si l'agent doit les voir.

### Écriture refusée dans un sous-module

Un sous-module est un dossier **vide** dans le worktree, et ce qu'on y
écrirait serait ignoré au commit : l'écriture y est refusée, et le résultat le
dit. Une commande `exec` peut encore y écrire, et ce travail sera perdu.

### La branche `midgaard/…` ne contient rien

Le harness ne commite que le travail d'une tâche **aboutie**. Une tâche qui
échoue laisse sa branche au commit de départ — son travail reste lisible dans le
worktree, que `npm run harness -- workspaces` désigne. Et le harness **ne merge jamais** :
`git merge` est ta décision.

### `npm run harness -- exec allow` : « pas de terminal pour confirmer »

Une commande ajoutée à la liste blanche ne sera plus jamais montrée à un
humain dans ce dépôt ; la CLI demande donc une confirmation, et refuse sans
terminal. `--yes` passe outre, en connaissance de cause.

### `npm run harness -- exec allow --prefix` : « préfixe refusé : … »

Un préfixe accepte n'importe quels arguments à la suite, que l'agent choisit.
Il est refusé quand il laisserait tourner du code qu'aucun humain n'a lu ; le
motif dit lequel de ces cas :

- **« un préfixe d'un seul mot couvrirait tout »** : ajoute une
  sous-commande (`npm test`, `git status`) ;
- **« est une option placée juste après le programme »** : commence par une
  sous-commande ou un argument nommé (`pytest tests` plutôt que `pytest -q`) ;
- **« n'est accepté en préfixe que suivi d'un module nommé »** : Python,
  seulement en `python -m pytest` ;
- **« est un shell », « est un interpréteur », « lance d'autres
  programmes »**, **« exécute le fichier ou le code qui suit »** : aucun
  préfixe possible ; une entrée exacte (sans `--prefix`) reste possible ;
- **« s'arrête sur un exécuteur »** ou **« est une option, pas un
  programme »** : nomme le programme juste après (`uv run pytest`) ;
- **« est un chemin relatif »** : c'est un fichier du worktree, que l'agent
  écrit ; vise un programme du `PATH` ou un chemin absolu.

Le daemon applique la même règle (`400 prefix_refused`), et la rejuge au
départ de chaque tâche : un préfixe ancien qu'elle refuse est **écarté**, la
timeline le dit (« préfixe exec écarté ») et `exec list` le marque « écarté
au départ de chaque tâche ». Retire-le par `npm run harness -- exec revoke`
suivi de ses mots.

---

## Les échantillons et l'environnement Python (Slice 9)

### La tâche est refusée : `invalid_samples`

Les échantillons sont copiés **avant** que la tâche existe ; un seul refus
refuse la tâche, et rien n'est créé. Le motif dit lequel :

- **« sample not found »** : le chemin n'existe pas ; un chemin relatif se lit
  depuis le dossier du projet ;
- **« sample path must be absolute »** : la tâche n'a pas de dossier de
  projet, et le chemin est relatif ;
- **« is inside the Midgaard runtime folder »** : le dossier runtime
  (`~/.midgaard`, ou `MIDGAARD_HOME`) garde le jeton du daemon et, parfois,
  le coffre ; rien n'en sort comme échantillon ;
- **« sample is not a regular file »** : un dossier, un périphérique ; un
  lien est suivi, puis jugé ;
- **« sample too large »**, **« samples too large together »**, **« at most
  16 per task »** : 256 Mio par fichier, 1 Gio et 16 fichiers par tâche.

`samples_unsupported` : seuls les profils Researcher, Developer et
orchestrateur reçoivent des échantillons.

### La tâche échoue au départ : « échantillon modifié depuis sa copie » ou « échantillon introuvable »

Les copies sont en lecture seule sous `samples/<tâche>` du dossier runtime, et
leur empreinte est revérifiée au départ. Quelque chose les a changées ou
effacées entre la création et le départ : relance la tâche, qui refera les
copies.

### Une commande de l'agent est refusée : « refused: … sample … »

Voulu : un échantillon ne s'exécute jamais, même approuvé. La commande le
lançait, en lançait une copie identique, ou le passait à un chargeur, un
émulateur, un débogueur, un shell ou un interpréteur qui pouvait le faire
tourner. Pour l'analyser par du code, un script Python qui le reçoit en
argument passe (`python analyze.py sample.exe`).

### « environnement Python non préparé : … »

Le harness ne propose `uv sync --locked` qu'à un Developer dont le dossier
porte un `uv.lock` :

- **« pyproject.toml sans uv.lock »** : `uv sync` écrirait un `uv.lock`, que
  le diff attribuerait à l'agent. Commite un `uv.lock` (`uv lock`) dans ton
  dépôt ;
- **« uv introuvable ou inutilisable »** : `uv` n'est pas dans le `PATH` du
  daemon. Installe-le, puis relance le daemon (`npm run harness -- stop`).

Si `uv sync --locked` échoue (code de sortie non nul), la tâche continue et
l'agent le sait ; la sortie est au terminal de la tâche. Un `uv.lock` périmé
par rapport à `pyproject.toml` en est la cause la plus courante : `uv lock`
dans ton dépôt, puis commit.

---

## La VM Windows de test (Slice 9)

Préparer la VM, une fois, dans un **PowerShell administrateur** de la VM :

1. le serveur OpenSSH, s'il n'est pas installé :
   `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`, puis
   `Set-Service -Name sshd -StartupType Automatic` et `Start-Service sshd` ;
2. son empreinte, à recopier dans `--fingerprint` :
   `ssh-keygen.exe -lf "$env:ProgramData\ssh\ssh_host_ed25519_key.pub"` ;
3. après `npm run harness -- windows add`, les deux lignes qu'elle affiche, qui
   posent la clé de Midgaard (`npm run harness -- windows key` les redonne).

Ces commandes seront exécutées telles quelles par la CI sur un vrai Windows
à la sous-étape 5.5 ; d'ici là, elles n'y ont pas tourné.

### `windows add` : « l'empreinte d'hôte est exigée »

Midgaard ne fait pas confiance au premier contact : l'empreinte se lit sur la
console de la VM (point 2 ci-dessus). « empreinte illisible » : il faut
`SHA256:` suivi de 43 caractères, ou la ligne entière de `ssh-keygen -lf` ;
une empreinte MD5 est refusée.

### `windows test` : ce que dit l'échec

- **« l'hôte présente l'empreinte …, pas celle épinglée »** : rien n'a été
  envoyé. Compare avec la console de la VM. Si elle a été réinstallée (ses
  clés d'hôte ont changé), redéclare son empreinte avec `windows add <id>
  --fingerprint "…"` ; sinon, ce n'est pas ta VM qui a répondu ;
- **« l'hôte refuse la clé de Midgaard »** : la clé publique n'est pas posée,
  ou pas au bon endroit. Pour un compte administrateur, Windows ne lit que
  `administrators_authorized_keys`, et l'ignore si d'autres que les
  administrateurs et SYSTEM peuvent y écrire — d'où la ligne `icacls` ;
- **« injoignable »** : VM éteinte, `sshd` arrêté, mauvaise adresse, ou le
  pare-feu de la VM ferme le port 22 ;
- **« PowerShell n'a pas répondu »** : la connexion est établie ; la sortie
  d'erreur citée dit pourquoi ;
- **« clé absente du coffre »** : le coffre a été vidé ou changé ;
  `windows add <id> --new-key`, puis pose la nouvelle clé.

### Attacher une VM à un profil, et `windows_run`

`npm run harness -- windows attach <vm> <profil>` donne la VM à un profil, à
partir de la tâche suivante. Seul un profil **Developer** l'accepte (c'est son
worktree qui part sur la VM) ; un autre type est refusé avec son motif, et une
VM non déclarée aussi, avec la liste des VM connues. Une au plus par profil :
en attacher une autre la remplace, et la CLI le dit. `windows detach <profil>`
la retire. `windows list` montre les profils de chaque VM. Retirer une VM
(`windows remove`) la détache d'abord des profils qui la portaient.

L'outil `windows_run` n'apparaît qu'aux tâches d'un Developer **qui a une VM**,
et chaque script y est approuvé (VM et texte exacts). Ce que dit un échec à
l'agent, et à la timeline :

- **« the Windows VM changed since the script was approved »** : la VM a été
  redéclarée (adresse, compte ou empreinte) entre l'approbation et l'exécution.
  Rien n'a tourné : réapprouve le script sur la VM telle qu'elle est ;
- **« the Windows VM … is no longer declared »** : la VM a été retirée pendant
  la tâche. Rattache-la (`windows attach`) pour les tâches suivantes ;
- **« no key for the Windows VM … in the vault »** : le coffre a été vidé ou
  changé. `windows add <id> --new-key`, puis pose la nouvelle clé ;
- **injoignable, clé refusée, autre empreinte** : mêmes causes que pour
  `windows test` ci-dessus — la copie du worktree et le script ne partent pas.

Le dossier de la tâche sur la VM (`~/midgaard/tasks/<tâche>`) est effacé à la
fin de la tâche. Une VM éteinte à ce moment-là l'empêche : le daemon le
journalise sans bloquer la tâche, et le dossier restera jusqu'au prochain
nettoyage ou à la main.

---

## Les serveurs MCP des agents

### `npm run harness -- mcp add` : « programme introuvable ou non exécutable »

Le programme est cherché dans le `PATH` **du terminal**, puis déclaré par son
chemin absolu. Les entrées relatives du `PATH` (`.`) sont ignorées. Donner le
chemin complet, par exemple `-- /opt/homebrew/bin/node /chemin/vers/rea/scripts/rea.mjs mcp`.

### « invalid_command » : « le programme doit être un chemin absolu »

Le daemon ne lance qu'un programme déclaré par son chemin absolu, et revérifie
à chaque lancement qu'il existe et s'exécute. Sous Windows, un `.cmd` ou un
`.bat` est refusé (« ne se lance pas sans shell ») : déclarer `node.exe` et le
script `.js` ou `.mjs`, comme REA le recommande pour une déclaration manuelle.

### Le test dit « ne répond pas » : « did not complete the MCP handshake »

Le programme s'est lancé mais n'a pas terminé `initialize` dans les 30 s. La
fin du message cite le début et la fin de sa sortie d'erreur, expurgés :
module introuvable (un chemin relatif dans les arguments, que `mcp add` rend
pourtant absolu s'il existe), Java absent pour Ghidra, ou un programme qui
n'est pas un serveur MCP. Le serveur tourne dans le dossier runtime au moment
du test, pas dans ton terminal.

### Un outil coché est « changé »

Le serveur l'annonce autrement qu'au moment où tu l'as coché : description,
schéma ou annotations — le plus souvent une mise à jour du serveur. Il est
**approuvé à chaque appel** jusqu'à ce que tu le relises
(`npm run harness -- mcp tools rea`) et le recoches (`npm run harness -- mcp allow rea nom_de_l_outil`).

### « no_catalog » en cochant un outil

Aucun catalogue n'a encore été lu, ou la déclaration a changé depuis : on ne
coche que ce que le serveur a annoncé. `npm run harness -- mcp test rea` le lit.

### `failed` : « le serveur MCP « … » n'a pas démarré »

Les serveurs MCP d'un profil se lancent au départ de chaque tâche, dans le
dossier du projet. Un seul qui ne démarre pas, et la tâche s'arrête **avant**
tout appel de modèle — rien n'a été dépensé. La suite du message est celle du
test de connexion : `npm run harness -- mcp test rea` la reproduit, hors tâche.

### « agent_cannot_use_mcp » en donnant un serveur à un profil

L'orchestrateur n'appelle aucun outil MCP : il délègue à un profil qui en a.
Donne le serveur au `researcher` ou au `developer`
(`npm run harness -- mcp attach rea researcher`) ; l'orchestrateur le voit dans
`list_agents`.

### Un outil MCP coché demande quand même une approbation

Le serveur l'annonce, **au départ de la tâche**, autrement qu'au moment où tu
l'as coché — une mise à jour sur place suffit, sans que rien d'autre change. La
timeline le dit (« coché(s) mais annoncé(s) autrement »). Relire le catalogue,
puis recocher : `npm run harness -- mcp test rea`, `npm run harness -- mcp tools rea`.

### `npm run harness -- mcp allow` : « pas de terminal pour confirmer »

Comme `exec allow` : un outil coché ne sera plus montré à un humain. La CLI
demande confirmation, et refuse sans terminal. `--yes` passe outre, en
connaissance de cause.

### Une tâche échoue sur « playbook « … » introuvable dans … »

Un playbook attaché au profil n'existe plus dans le dossier que lit le daemon
(`playbooks/` du clone, ou `MIDGAARD_PLAYBOOKS_DIR`) : fichier renommé,
supprimé, ou daemon lancé depuis un autre clone. La tâche s'est arrêtée avant
tout appel de modèle — rien n'a été dépensé. `npm run harness -- playbooks`
liste ce que voit le daemon ; retire le playbook du profil
(`npm run harness -- playbooks detach sigma researcher`) ou remets le fichier.

### Une tâche échoue sur « playbook « … » inutilisable » ou « playbooks trop gros ensemble »

Le fichier a dépassé 32 Kio, n'est plus de l'UTF-8 valide, ou les playbooks
du profil dépassent ensemble 96 Kio. Les bornes sont revérifiées au départ de
chaque tâche : un fichier qui a grossi depuis l'attache est refusé. `npm run
harness -- playbooks` dit lequel et pourquoi.

### `npm run harness -- playbooks attach` : « playbook_not_found »

Le daemon ne connaît pas ce playbook. La réponse liste ceux qu'il voit, et le
dossier où il les cherche : c'est celui de **son** installation. Un daemon
lancé depuis un autre clone lit les playbooks de cet autre clone.

---

## La fenêtre desktop

### « La coque desktop n'est pas construite »

`npm run desktop` ouvre une fenêtre construite depuis le clone. Une fois, et
après chaque mise à jour du clone :

```bash
npm run desktop:build
```

Il faut Rust (`cargo`) ; `npm run doctor` dit s'il est là. Sans lui, le même
dashboard s'ouvre dans un navigateur, à l'adresse que donne
`npm run harness -- start`.

### « midgaard : impossible de lancer … » ou la fenêtre ne s'ouvre pas d'un double-clic

Le build a gravé dans la coque le chemin du `node` de npm. Une mise à jour de
Node (Homebrew en change le dossier) le rend caduc. Reconstruire :
`npm run desktop:build`. Lancée par `npm run desktop`, la coque reçoit le
`node` courant et n'est pas concernée.

### « adresse du dashboard refusée, hors de la boucle locale »

La coque n'ouvre que `http://127.0.0.1:<port>/` ou `http://localhost:<port>/`.
Le fichier `daemon.json` du dossier runtime en annonce une autre : il a été
modifié à la main, ou n'est pas celui d'un daemon Midgaard. Arrêter le daemon
(`npm run harness -- stop`), qui le réécrit au prochain démarrage.

## Les plateformes

- **Windows** : `write_file` écrit le fichier tel que le modèle le donne ; sur
  un fichier en fins de ligne CRLF, un modèle qui le réécrit en `\n` change
  toutes ses lignes dans le diff. `edit_file`, lui, respecte les fins de ligne
  du fichier.
- **Windows et Linux** : éprouvés en CI seulement, face à un faux fournisseur.
  Une panne qui ne se voit que là mérite un ticket sur
  [GitHub](https://github.com/AndyD9/Midgaard/issues), avec la sortie de
  `npm run doctor` et la fin de `daemon.log`.

---

## Les variables d'environnement

Elles sont lues **au démarrage** de chaque processus. Le daemon hérite de
l'environnement de celui qui le lance — le serveur MCP ou la CLI : une variable
changée sous un daemon déjà lancé n'a d'effet qu'après `npm run harness -- stop`.

| Variable | Effet | Défaut |
|---|---|---|
| `MIDGAARD_HOME` | Dossier runtime : base, journal, jeton, worktrees ; pour la CLI, `--home <dossier>` avant la commande fait de même | `~/.midgaard` |
| `MIDGAARD_PORT` | Port d'écoute sur `127.0.0.1` ; fixé, il interdit le repli | `7777`, repli sur un port libre |
| `MIDGAARD_IDLE_SHUTDOWN_S` | Arrêt après inactivité ; `0` le désactive | `1800` |
| `MIDGAARD_APPROVAL_TTL_S` | Validité d'une demande d'approbation | `600` |
| `MIDGAARD_INPUT_TTL_S` | Attente maximale de votre réponse dans une conversation | `7200` |
| `MIDGAARD_VAULT` | Impose un coffre : `macos-keychain`, `windows-dpapi`, `libsecret`, `file` | détection, puis repli fichier |
| `MIDGAARD_HTTP_POLICY` | `http_fetch` : `open`, `approval` ou `allowlist` — les adresses privées restent refusées dans tous les cas | `open` |
| `MIDGAARD_HTTP_ALLOW` | Hôtes toujours admis, séparés par des virgules (`exemple.org`, `*.exemple.org`) | aucun |
| `MIDGAARD_EXEC_ALLOW` | Commandes exactes lancées sans approbation, séparées par `;` | aucune |
| `MIDGAARD_MAX_ACTIVE_SUBTASKS` | Sous-tâches actives d'un orchestrateur en même temps | `4` |
| `MIDGAARD_DASHBOARD_DIR` | Dossier du dashboard compilé | celui du paquet |
| `MIDGAARD_PLAYBOOKS_DIR` | Dossier des playbooks | `playbooks/` du clone |
