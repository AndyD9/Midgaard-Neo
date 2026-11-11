# Slice 9 — Des agents experts : Python, reverse, règles Windows

**Date :** 2026-11-06 · **Objectif :** que les agents de Midgaard travaillent
en experts sur quatre terrains — **détection** (Sigma, YARA, EVTX, Sysmon),
**durcissement** (GPO, AppLocker, WDAC, pare-feu, ASR), **scripts
PowerShell**, **analyse de binaires PE** — le plus souvent en **Python**, et
vérifient sous Windows ce qui ne se vérifie que là.

**État : en cours.** Ouverte le 2026-11-06 à la demande de l'auteur, le jour
où l'essai réel REA (étape 7 de la Slice 8) a été conclu sur sa cible
JavaScript — sans aucun appel REA réel encore : c'est sur un binaire, au
volet PE de l'étape 7 ci-dessous, qu'il sera éprouvé. Les releases desktop
passent après. Étape 1 verte en CI sur trois plateformes (passages
`42277207691` et `42277207665`).

---

## Les décisions prises avec l'auteur (2026-11-06)

| Question | Réponse retenue |
|---|---|
| Quelles « règles Windows » ? | **Les quatre** : détection (Sigma, YARA), durcissement / GPO, scripts PowerShell, analyse de binaires PE |
| Où vérifier ce qui est propre à Windows ? | **Une VM Windows jointe par SSH**, où `exec` peut lancer des commandes, approuvées |
| Dans quel ordre ? | **Conclure l'essai REA, puis cette slice**, puis les releases desktop |
| Quel modèle ? | **Les modèles *uncensored* de Venice**, à commencer par `deepseek-v4-1-flash-uncensored` |

### Le second tour (2026-11-06, à l'ouverture)

| Question | Réponse retenue |
|---|---|
| Où vivent les playbooks ? | **Dans le dépôt Midgaard** (`playbooks/`), versionnés, relus à chaque commit ; l'humain les **attache à un profil** (CLI, dashboard). Aucun agent ne peut les modifier |
| La liste blanche `exec` ? | **Des préfixes bornés** : un préfixe couvre tout argv qui commence par lui ; refusé s'il se réduit à un interpréteur nu (`python`, `node`, `sh`, `pwsh`…) ; avertissement et confirmation à l'ajout, comme aujourd'hui |
| Quelle VM Windows ? | **Locale** (Parallels, UTM ou VMware sur le Mac), OpenSSH Server activé, si possible avec un instantané propre |
| Exécuter un échantillon ? | **Jamais.** Analyse statique seulement, même sur la VM, même avec approbation |

### Le troisième tour (2026-11-07, à l'ouverture de l'étape 5)

| Question | Réponse retenue |
|---|---|
| Quel client SSH ? | **La bibliothèque `ssh2`** (pure JS, sans ses dépendances natives facultatives) : la clé reste en mémoire, lue au coffre ; l'empreinte d'hôte est comparée dans notre code ; même comportement sur les trois plateformes ; fichiers par SFTP |
| Comment épingler l'empreinte d'hôte ? | **Recopiée depuis la VM** : l'humain la lit sur la console de la VM (commande donnée par la CLI) et la passe à la déclaration. Aucune confiance au premier contact |
| Quelle clé ? | **Générée par Midgaard, dédiée à la VM** (ed25519), rangée au coffre ; la CLI donne la commande PowerShell exacte qui pose la clé publique |
| Quelle forme pour l'agent ? | **Un script PowerShell** (`windows_run`), montré tel quel à l'approbation ; le worktree est recopié dans le dossier jetable de la VM avant chaque commande |

Constaté avant d'écrire (2026-11-07) : `ssh2` 1.17.0 génère une clé
ed25519 au format OpenSSH, et l'empreinte qu'on tire de la clé d'hôte
présentée est **identique** à celle d'`ssh-keygen -lf` (`SHA256:…`, base64
sans remplissage). Il fonctionne installé sans ses dépendances facultatives
(`cpu-features`, `nan`, qui se compilent), et fournit un serveur SSH en
processus : les tests ont un hôte factice sans machine Windows.

## Ce qui a été constaté avant de décider (2026-11-06)

Chaque point a été lu dans le code ou au catalogue, pas supposé.

1. **Les profils ne savent aucun métier.** Les consignes du Researcher, du
   Developer et du Navigator (`packages/daemon/src/agents.ts`) ne disent que
   les règles du harness. Le rôle d'un agent créé (`create_agent`) est écrit
   par l'orchestrateur à chaque tâche, et perdu avec elle : rien ne
   s'accumule.
2. **Seul le Developer exécute.** Le Researcher est en lecture seule ; faire
   tourner un script d'analyse Python demande un Developer dans un worktree,
   chaque commande approuvée.
3. **La liste blanche `exec` compare l'argv à la lettre** (`execAllowed`,
   `packages/tools/src/exec.ts`) : une entrée `python -m pytest` ne couvre
   pas `python -m pytest -k foo`. En Python, c'est une approbation par
   itération.
4. **Un worktree n'a pas de `.venv`** (non versionné) : une tâche Developer
   doit recréer l'environnement avant de pouvoir tester.
5. **Le modèle existe et se règle déjà.** Au catalogue public de Venice
   (relu le 2026-11-06) : `deepseek-v4-1-flash-uncensored` et
   `deepseek-v4-1-flash-1017-uncensored` — appel d'outils, vision, contexte
   d'un million de jetons, effort de raisonnement réglable (`high` par
   défaut chez Venice) ; 0,33 $ / 1,32 $ par million de jetons, cache à
   0,00825 $. Les deux sont **déjà tarifés** dans
   `packages/providers/pricing.json` : on peut les poser sur un profil
   aujourd'hui (`PATCH /api/agents/:id`, ou les Profils du dashboard), et
   `create_agent` les accepte. L'adaptateur n'envoie aucun
   `reasoning_effort` : c'est le défaut de Venice qui joue.
6. **Rien ne touche Windows depuis le poste de l'auteur** (un Mac), hors de
   la CI.

## Décisions de conception

### Les playbooks

1. **Un playbook est un fichier Markdown de `playbooks/`**, à la racine du
   dépôt Midgaard ; son identifiant est son nom (`sigma.md` → `sigma`). En
   anglais : c'est le modèle qui le lit. Il ne nomme aucun modèle ni aucun
   client (règle de neutralité de la Slice 5).
2. **L'humain l'attache à un profil**, jamais un agent : `harness playbooks
   attach`, une case par playbook aux Profils, `PUT
   /api/agents/:id/playbooks`. Un identifiant inconnu est refusé avec la
   liste des disponibles.
3. **Il est ajouté à la consigne après les règles du profil**, sous un
   titre qui dit qu'il s'y ajoute et ne les remplace pas — comme le rôle
   d'un agent créé (Slice 8, décision 14), qui vient après lui. Un agent
   créé hérite des playbooks de son profil de base.
4. **Il est lu au départ de la tâche**, et ce qui a été lu est journalisé :
   identifiant et SHA-256 de chacun. Une tâche dit ainsi quel savoir elle a
   reçu, même si le fichier change ensuite. Un playbook attaché mais absent
   au départ arrête la tâche avant tout appel de modèle, avec son motif —
   comme un serveur MCP qui ne démarre pas.
5. **Taille bornée** (32 Kio par playbook, 96 Kio par profil) : il est relu à
   chaque appel de modèle, donc payé à chaque appel.

### La liste blanche à préfixes

6. Une entrée est **exacte** (comme aujourd'hui) ou **préfixe**. Un préfixe
   d'un seul mot est refusé, et un interpréteur (`python`, `python3`, `node`,
   `sh`, `bash`, `zsh`, `pwsh`, `powershell`, `cmd`, `ruby`, `perl`, `deno`,
   `bun`, `uv run`, `npx`) n'est accepté que suivi d'un module ou d'une
   sous-commande nommée (`python -m pytest`). Un préfixe `python -c` ou
   `python script.py` ferait tourner sans regard du code écrit par l'agent.
7. **Un préfixe `pytest` n'élargit pas ce qui tourne** : `pytest` exécute
   déjà `conftest.py`, que l'agent écrit. C'est la raison de l'avertissement
   à l'ajout, qui le redit.

### L'environnement Python d'un worktree

8. **Le harness le prépare, pas l'agent** : quand le worktree porte un
   `uv.lock` (ou un `pyproject.toml`), `uv sync` est proposé à l'humain
   avant le premier appel de modèle, approuvé une fois, lancé sous la garde
   d'`exec`. À ce moment, l'arbre est celui du commit de départ : du code de
   l'utilisateur, pas de l'agent. Le `.venv` de l'utilisateur n'est jamais
   partagé : un agent y installerait ce qu'il veut.

### Les échantillons

9. **Un échantillon ne s'exécute jamais.** Les fichiers désignés comme
   échantillons à la création de la tâche sont copiés **en lecture seule**
   sous un dossier à part ; `exec` refuse tout programme qui s'y trouve, et
   **un échantillon ne part jamais sur la VM**. On le lit, on le désassemble,
   on lui passe YARA ou un script Python ; c'est tout.

### La VM Windows

10. **Déclarée par l'humain** (`harness windows add`) : hôte, utilisateur,
    clé au coffre, **empreinte d'hôte épinglée** à la déclaration et
    revérifiée à chaque connexion.
11. **Chaque commande sur la VM est approuvée**, commande exacte et hôte
    sous les yeux ; la liste blanche ne s'y applique pas au début.
12. **Les fichiers du worktree** (jamais les échantillons, jamais `.git`)
    sont copiés dans un dossier jetable de la VM, propre à la tâche, effacé
    à la fin ; rien ne revient de la VM que la sortie des commandes,
    encadrée et non fiable.
13. **Aucun processus ne survit sur la VM** : chaque commande tourne dans un
    Job Object tué à sa fermeture, et la coupure de la connexion — daemon
    tué net compris — doit tout emporter. À prouver en comptant les
    processus de la VM, pas en le supposant.
14. **Éprouvée en CI** sur un poste Windows GitHub qui active OpenSSH Server
    et se joint lui-même ; l'essai réel se fait sur la VM de l'auteur.

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | Les playbooks : dossier `playbooks/`, lecture et bornes, `agents.playbooks` (migration 14), `GET /api/playbooks`, `PUT /api/agents/:id/playbooks`, consigne composée et journalisée au départ, héritage par les agents créés, `harness playbooks` (`attach`, `detach`) ; un premier playbook (`python`) | **fait** — 15 tests, trois défauts introduits vus échouer, deux trouvés par la vraie CLI ; verte en CI sur trois plateformes |
| 2 | Le savoir : `sigma`, `yara`, `pe-static`, `powershell`, `windows-hardening`, relus par l'auteur | fait (exemples validés, relus par l'auteur) |
| 3 | La liste blanche à préfixes : migration, règle des interpréteurs, CLI, avertissement (le dashboard, qui ne montre pas encore la liste blanche, à l'étape 6) | **fait** — 70 tests unitaires et V14 ; trois défauts introduits vus échouer ; verte en CI sur trois plateformes (passages `42398543114`, `42398543220`, `42398543196`) |
| 4 | L'environnement Python du worktree (`uv sync` proposé au départ) et les échantillons en lecture seule, jamais exécutés | **fait** — 17 tests unitaires, V15 et V16 ; quatre défauts introduits vus échouer ; verte en CI sur trois plateformes (passages `42402763315`, `42402763377`), après une relance Windows : une manche de `test:lock` a échoué une fois, sans journal (voir le récit) |
| 5 | La VM Windows : déclaration, empreinte d'hôte, copie jetable, commande approuvée, Job Object ; CI Windows avec sshd | **en cours** — 5.1 à 5.3 faites (déclaration, attache, `windows_run`) ; restent 5.4 (survie des processus) et 5.5 (CI Windows avec sshd), qui demandent un vrai Windows |
| 6 | Le dashboard : playbooks aux Profils, liste blanche `exec` du dépôt (préfixes compris), VM, échantillons d'une tâche | à faire |
| 7 | Preuves (`test:security`, CI trois plateformes) et essai réel : une règle Sigma, une règle YARA et un script PowerShell vérifiés sur la VM par un modèle *uncensored* ; le PE via REA après l'essai de la Slice 8 | à faire |

### L'étape 5 en détail

| # | Sous-étape | État |
|---|---|---|
| 5.1 | Le paquet `remote` : connexion `ssh2`, empreinte comparée **avant** toute authentification, exécution avec sortie en flux, SFTP, fermeture ; tests contre un hôte factice en processus | **fait** — 10 tests, deux défauts introduits vus échouer |
| 5.2 | La déclaration : table des hôtes (migration), routes `/api/windows`, `harness windows add` (clé générée au coffre, empreinte recopiée, commande PowerShell donnée), `test`, `key`, `remove` | **fait** — 9 tests, quatre défauts introduits vus échouer ; 5.1 et 5.2 vertes en CI sur trois plateformes (passage `42791814211`), après deux corrections trouvées par la CI Windows |
| 5.3 | L'attache d'une VM à un profil (`attach`/`detach`, venue de 5.2) et l'outil `windows_run` : script PowerShell approuvé à chaque fois (hôte et texte exacts), dossier jetable de la tâche sur la VM, worktree recopié avant chaque commande (jamais `.git`, jamais un échantillon), sortie en direct expurgée et non fiable, délai et annulation, dossier effacé en fin de tâche | **fait** — découpée en cinq (a : l'attache, migration 18, `PROTOCOL_VERSION` 21 ; b : le dossier de tâche dans `remote` ; c : l'outil ; d : le branchement ; e : la doc), chacune verte en CI sur trois plateformes, après relance d'un poste coupé par un aléa d'infra (runner macOS absent, redémarrage du daemon sous Windows) |
| 5.4 | Aucun processus ne survit : **constater d'abord** ce que Win32-OpenSSH fait d'une session coupée, en comptant les processus de l'hôte ; puis, s'il le faut, un lanceur qui pose un Job Object tué à sa fermeture | à faire |
| 5.5 | La CI : un poste Windows GitHub active OpenSSH Server, pose la clé **par la commande que donne la CLI** (ce qui prouve la consigne), se joint lui-même ; `test:windows` — exécution, empreinte fausse refusée, daemon tué net, processus comptés sur l'hôte | à faire |

Chaque sous-étape se commite à part, avec l'accord de l'auteur.

## Reste à trancher

- **Ce que fait Win32-OpenSSH d'une session coupée** : tue-t-il les
  processus de la session, ou faut-il un Job Object posé par un lanceur ?
  À constater à l'étape 5, sur un poste Windows, en comptant.
- **Un modèle *uncensored* obéit plus volontiers.** Les chaînes d'un binaire,
  un journal EVTX ou un commentaire de script sont des données qu'un
  attaquant a pu écrire. Les protections de Midgaard sont dans le code
  (encadrement à nonce, approbations, liste blanche), pas dans le refus du
  modèle : la slice ne doit en relâcher aucune, et l'approbation reste la
  frontière.
- **Régler l'effort de raisonnement** par profil, ou laisser le défaut du
  fournisseur.

## Récit

### Étape 1 — les playbooks (2026-11-06)

Ce qui existe désormais :

- **`playbooks/`** à la racine du clone, avec un `README.md` pour les humains
  et un premier playbook, `python.md` (écrire, tester, scripts d'analyse
  statique ; « jamais exécuter un échantillon » y est redit) ;
- **`agents.playbooks_json`** (migration 14) et le champ `playbooks` d'un
  profil, `PROTOCOL_VERSION` 17 ; `MIDGAARD_PLAYBOOKS_DIR` déplace le
  dossier (`config.playbooksDir`, injecté) ;
- **`GET /api/playbooks`** (le dossier lu, chaque playbook avec titre,
  taille, SHA-256, et le motif d'un refus) et **`PUT
  /api/agents/:id/playbooks`** (liste complète et ordonnée ; inconnu → 404
  avec les disponibles, inutilisable ou trop gros → 409, simulé → 409, un
  chemin refusé au schéma) ;
- **le moteur** les relit en `preparing`, tout ou rien, les place après les
  règles et avant le rôle d'un agent créé, et note à la timeline
  « playbooks lus : id (octets, sha256 …) » avec l'empreinte entière ;
- **`list_agents`** montre les playbooks d'un profil à l'orchestrateur, et
  sa consigne dit qu'un agent créé en hérite ;
- **`harness playbooks`**, `playbooks attach`, `playbooks detach`, et les
  playbooks d'un profil dans `harness agents`.

**Une attache sans confirmation**, contrairement à `exec allow` et `mcp
allow` : un playbook n'ouvre aucune porte, il ajoute du texte d'humain sous
des règles qu'il ne peut pas remplacer. La CLI dit en revanche ce qu'il
coûte : il est relu à chaque appel de modèle.

**Le rôle d'un agent créé se repère par son titre**, que seul le daemon
écrit ; la première occurrence est la sienne, et un rôle qui recopierait ce
titre reste après le playbook — un test le fait exprès.

Preuves (`tests/unit/playbooks.test.ts`, 15 tests) : la lecture du dossier
(`README.md`, majuscules, lien symbolique et `../` écartés ; trop gros et
non-UTF-8 listés avec leur motif ; somme rebornée au départ) ; la place dans
la consigne ; les playbooks livrés valides et neutres ; et dans un vrai
daemon face au faux fournisseur, ce que le modèle reçoit, le SHA-256 à la
timeline, l'arrêt sans aucun appel de modèle quand un playbook a disparu, et
l'héritage par un agent créé par l'orchestrateur. **Trois défauts introduits
exprès ont été vus échouer** : moteur qui ne compose plus la consigne (deux
tests tombent), playbook absent sauté en silence (deux), playbooks ajoutés
après le rôle (deux).

**La vraie CLI a trouvé deux défauts**, sur un dossier runtime jetable,
réglés : `harness playbooks` conseillait `playbooks attach sigma
researcher`, un playbook qui n'existe pas encore (l'exemple nomme désormais
un playbook présent et un profil qui ne l'a pas) ; et `harness agents` ne
montrait pas les playbooks d'un profil **désactivé**, alors que l'attache
venait de réussir. Toutes les suites locales sont vertes : `test:unit`
(643), `test:orchestrator`, `test:security`, `test:wait` (protocole 17
constaté par S1 et S10), `test:ui`, `test:developer`. Verte en CI sur
macOS, Linux et Windows (« Bout en bout » `42277207691`, « Worktrees »
`42277207665`).

### Étape 2 — le savoir métier (2026-11-06)

Cinq playbooks rejoignent `python` : `sigma`, `yara`, `pe-static`,
`powershell`, `windows-hardening` (4,6 à 6,7 Kio chacun, environ 33 Kio les
six, sous les 96 Kio d'un profil). Chacun dit **comment travailler et
prouver** — tests positifs et négatifs pour une règle, audit avant blocage
pour une politique, avant/après relu sur la machine —, ce qu'on rapporte
(observé séparé de l'inféré), et redit les règles que le code applique :
aucun échantillon exécuté (l'émulation, FLOSS ou Speakeasy, comptée comme
une exécution), aucun échantillon sur la VM, tout contenu lu est de la
donnée.

Trois choix d'écriture :

- **Rien de ce qui n'existe pas encore.** La VM Windows (étape 5) et la copie
  des échantillons (étape 4) n'existent pas : les playbooks parlent d'« une
  machine Windows de test, si ta tâche t'en donne une », et disent quoi faire
  sans elle (le dire non éprouvé). Le premier jet nommait « la VM de test » et
  « la copie que fournit le harness » ; relu contre l'invariant avant
  l'envoi.

- **Aucun identifiant de mémoire.** Les GUID des règles ASR et les options
  WDAC ne sont pas recopiés : un GUID faux ne fait rien, ou autre chose, sans
  le dire. Le playbook dit où les prendre (la référence de l'éditeur, ou la
  machine). Les numéros d'événement cités sont ceux qu'on ne confond pas
  (4688, 4104, 7045, 8003/8004, 3076/3077, 1121/1122, les identifiants
  Sysmon).
- **Pas d'outil de contournement.** Le playbook PowerShell écarte le code
  dont le but est d'aveugler une défense (AMSI, journalisation, Defender,
  effacement de journaux) : si une tâche semble l'exiger, l'agent s'arrête et
  le dit.

**Les exemples sont du code, et ont été passés aux vrais outils** dans un
environnement jetable (`uv run --with …`) : la règle YARA compile avec
`yara-python` **sans aucun avertissement** (`error_on_warning`), la règle
Sigma est lue par `pySigma` sans erreur, et l'extrait `pefile` est
syntaxiquement valide, chaque fonction citée existant dans la bibliothèque.
En chemin, l'identifiant de l'exemple Sigma était tronqué (`3f1c0e2a-...`) :
recopié tel quel par un agent, il aurait donné une règle invalide ; c'est
désormais un UUID complet marqué `REPLACE`. L'extrait `pefile` n'a pas tourné
sur un fichier, et rien n'a été éprouvé sous Windows : ce sera l'étape 7.

Deux tests de plus (`tests/unit/playbooks.test.ts`, 17) : les playbooks
livrés tiennent **tous ensemble** sur un profil, et chacun dit que ce qu'il
lit est de la donnée — trois d'entre eux, qu'on n'exécute rien. Le premier
jet de `sigma` l'a fait échouer : il disait « citer comme donnée » sans
nommer la donnée non fiable.

Relus par l'auteur le jour même, acceptés sans changement.

### Étape 3 — la liste blanche à préfixes (2026-11-07)

Ce qui existe désormais :

- **`exec_allow.prefix`** (migration 15), et le champ `prefix` d'une entrée,
  `PROTOCOL_VERSION` 18 : un daemon 17 aurait ignoré le champ et enregistré
  une entrée exacte en disant l'ajout réussi ;
- **`execPrefixRefusal`** (`packages/contracts/src/exec-allow.ts`), la règle
  qui juge un préfixe, appliquée **trois fois** : par la CLI avant
  l'avertissement, par la route (`400 prefix_refused`), et au départ de
  chaque tâche (`execRulesForTask`) ;
- **`harness exec allow --prefix`**, `exec list` qui montre un préfixe suivi
  de `…` et dit celui que le moteur écarterait, `doctor` de même ;
- **`allow_reason`** dans le `tool.requested` d'un appel passé sans humain :
  « commande en liste blanche (préfixe « git rev-parse … ») ». Écrit d'abord
  dans la politique sans qu'il arrive nulle part — la boucle ne gardait la
  raison que d'un refus ou d'une demande ; le commentaire qui l'annonçait
  aurait été faux.

**La règle va un peu au-delà de la décision 6**, pour la même raison : un
préfixe accepte n'importe quels arguments, que l'agent choisit. Refusés
aussi : une **option juste après le programme** (`git -c alias.x=!sh`,
`node --test`), un **chemin relatif** (un fichier du worktree, que l'agent
écrit), les **lanceurs** (`env`, `xargs`, `find`, `ssh`, `sudo`…), les
sous-commandes qui exécutent un fichier (`deno run`, `bun run`) ; et un
**exécuteur** (`uv run`, `npx`, `npm exec`) n'est accepté que s'il nomme un
programme acceptable à son tour (`uv run pytest` oui, `uv run python` non).
Les familles se reconnaissent malgré la casse, la version et l'extension
(`/usr/bin/python3.12`, `PWSH.EXE`). Ce que la règle ne prétend pas : connaître
chaque programme dont un argument en lance un autre (`tar --to-command`,
`rsync -e`) ; l'avertissement de la CLI le dit, l'humain décide.

**Un préfixe ne rétrécit jamais en entrée exacte**, ni à l'ajout (`exact` sur
un préfixe : `unchanged`) ni au départ (un préfixe refusé est écarté, pas
réduit) : une règle qui changerait de sens en silence ne se relirait pas.
Élargir une entrée exacte en préfixe change son auteur et sa date : c'est une
autorisation de plus.

**La variable `MIDGAARD_EXEC_ALLOW` reste exacte** : une forme préfixe y
aurait demandé une syntaxe de plus à analyser, à l'endroit même où une
commande approuvée d'office pourrait ne pas être celle qu'on croit.

**Le dashboard attend l'étape 6** : il n'a jamais montré la liste blanche,
exacte ou non. La décision « CLI et dashboard » du découpage y est reportée.

Preuves : `tests/unit/exec-prefix.test.ts` (70 tests — 17 préfixes acceptés,
39 refusés chacun avec son motif, la comparaison mot à mot, la politique qui
nomme le préfixe, la migration d'une base 14, l'élargissement, le
rejugement) et **V14** dans `test:developer`, un vrai daemon face au faux
fournisseur : deux `git rev-parse` différents passent sans humain avec leur
`allow_reason`, `python -c` est refusé par la route et `bash` par la CLI
**avant** tout avertissement, et un préfixe `node -e` glissé en base est
écarté au départ — la timeline le dit, l'appel attend l'humain. **Trois
défauts introduits exprès ont été vus échouer** : moteur qui ne rejuge plus
(V14 : `node -e` terminé sans aucune demande, et un test unitaire), route
qui ne juge plus (V14 : `python -c` accepté et inscrit), comparaison de texte
au lieu de mots (un test unitaire).

### Étape 4 — les échantillons et l'environnement Python (2026-11-07)

Ce qui existe désormais :

- **`samples`** à `POST /api/tasks` et à `harness_delegate_task` : des
  chemins de fichiers, absolus ou relatifs au projet. Le daemon les copie
  **avant** la tâche (`packages/daemon/src/samples.ts`), en lecture seule,
  sous `samplesDir/<tâche>` du dossier runtime — hors de tout dépôt : un
  échantillon dans un worktree serait commité par `git add -A`. Une tâche
  porte `samples` (nom, SHA-256, taille ; migration 16, `PROTOCOL_VERSION`
  19), jamais le chemin d'origine, que seul le journal du daemon cite ;
- **les refus avant création** (`400 invalid_samples`) : introuvable, pas un
  fichier ordinaire, sous le dossier runtime (jeton, coffre), plus de 16, plus
  de 256 Mio, plus de 1 Gio ensemble ; `409 samples_unsupported` pour un
  profil qui n'analyse pas. Un refus efface le dossier préparé ;
- **au départ**, chaque empreinte revérifiée, tout ou rien, avant tout appel
  de modèle : les copies appartiennent à l'utilisateur, une commande
  approuvée pourrait les réécrire. L'agent reçoit leurs chemins et la règle,
  la timeline leurs noms et empreintes ;
- **à la fin**, les copies effacées **avant** la conclusion — une tâche vue
  finie n'en a plus ; le démarrage du daemon balaie ce qu'une mort nette a
  laissé. Rien n'est effacé hors de `samplesDir` ;
- **`delegate_task` transmet par nom** les échantillons de l'orchestrateur, et
  eux seuls, par lien dur : un orchestrateur ne désigne jamais un fichier du
  disque, qu'un texte lu lui aurait soufflé ;
- **la garde d'`exec`** (`packages/tools/src/samples-guard.ts`), dans
  `prepare` : refus sans demande, liste blanche comprise, de tout ce qui
  lancerait un échantillon — lui, **une copie de même contenu** (taille puis
  SHA-256 : `cp sample x ; ./x` est la même exécution), un chargeur, émulateur,
  débogueur ou traceur qui le reçoit, un shell ou un interpréteur autre que
  Python qui le reçoit, Python quand il est le script ou passé à `runpy`,
  `pdb`, `floss`, `qiling`… ;
- **`uv sync --locked`** (`packages/daemon/src/python-env.ts`), proposé par
  le harness au départ d'un Developer dont le worktree porte un `uv.lock`,
  par l'outil `exec` lui-même, à l'étape 0, avant le premier appel de modèle.
  L'agent apprend s'il a réussi ou échoué.

**Trois écarts aux décisions 8 et 9**, tranchés en chemin :

- **Pas de `uv sync` sans `uv.lock`** (la décision disait « ou un
  `pyproject.toml` ») : `uv sync` écrirait alors un `uv.lock` dans le
  worktree, et le diff l'attribuerait à l'agent. `--locked` pour la même
  raison : un lock périmé fait échouer la commande au lieu d'être réécrit —
  V16 le prouve, et la mutation sans `--locked` y laisse un `uv.lock` au diff ;
- **refuser `uv sync` arrête la tâche**, comme tout refus d'approbation
  (`cancelled`) : l'opération le dit à l'humain avant qu'il décide ;
- **l'émulation est refusée sans exception**, même approuvée — décision
  « jamais » prise avec l'auteur. Le playbook `pe-static` la permettait « si
  la tâche dit que l'humain l'a autorisée » ; la phrase est corrigée, et
  c'est la seule retouche d'un playbook relu à l'étape 2.

**Ce que la garde ne prétend pas** : lire ce que fait un script du fichier
qu'il reçoit (`exec(open(sample).read())`), ni reconnaître une copie
modifiée d'un octet. Là, l'approbation de la commande reste la frontière.
Un Researcher, sans `exec`, ne lit un binaire que par un serveur MCP qui le
sait (REA) ; les outils de lecture ne voient pas `samplesDir`.

**Constaté avant d'écrire** : `uv sync --locked` dans un dépôt Git laisse
`git status` vide — `uv` pose un `.gitignore` (`*`) dans `.venv` (uv 0.12.16).
V16 le revérifie par le diff de la tâche.

Preuves : `tests/unit/samples.test.ts` (17 tests : la garde sur une table de
commandes, la copie, les droits, les refus sans reste, la vérification, la
transmission par nom, l'effacement borné et le balayage ; dans un vrai
daemon, ce que l'agent lit, la note, l'effacement en fin de tâche, les refus
de la route, la transmission d'un orchestrateur) et, dans `test:developer`,
**V15** (dans un vrai worktree : une copie identique écrite par l'agent et
`node <échantillon>` refusés sans demande, `git hash-object` approuvé, rien
n'a tourné, copies effacées) et **V16** (`uv sync --locked` demandé avant le
modèle, approuvé, `.venv` hors du diff ; refusé, la tâche s'arrête sans aucun
appel ; un lock périmé échoue et l'agent le sait ; sans lock, c'est dit). La
CI installe uv (`astral-sh/setup-uv`) et l'exige par `MIDGAARD_REQUIRE_UV` :
sans uv, V16 serait un constat, pas un succès. **Quatre défauts introduits
exprès ont été vus échouer** : garde coupée (5 tests unitaires et V15),
comparaison de contenu retirée (3 et V15), `uv sync` sans `--locked` (V16),
vérification au départ sautée (2). La première mutation a aussi montré que
la suite plantait au ménage sur une copie en lecture seule laissée par une
tâche bloquée : le ménage des tests rouvre désormais les droits, et V15
annule sa tâche si elle n'a pas fini.

**En CI** (passage `42402763315`), Windows a d'abord échoué sur une manche
de `test:lock` — « verrou périmé #4 », 0 survivant sur 8 —, code du verrou
inchangé, puis est passé à la relance, toutes suites vertes (V15 et V16
compris, uv 0.13.7). **Non expliqué** : le test n'affiche les journaux que
des candidats encore vivants, et il n'y en avait aucun. Ce n'est pas une
preuve que le verrou tient ; c'est une manche qu'on n'a pas pu lire. Le
test affiche désormais, pour une manche ratée, le journal de **chaque**
candidat avec son code de sortie (`tests/single-instance.ts`), vérifié en
forçant une manche à échouer : la prochaine occurrence se lira.

### Étape 5.1 — le paquet `remote` (2026-11-07)

`packages/remote` : `generateKeyPair` (ed25519 au format OpenSSH, commentée
`midgaard-<vm>`), `fingerprintOf` et `normalizeFingerprint` (la ligne de
`ssh-keygen -lf` ou la forme nue ; MD5 refusé), et `RemoteSession` :
`open` compare l'empreinte **pendant l'échange de clés** — un hôte qui
présente une autre clé ne reçoit ni signature ni nom d'utilisateur, et le
refus dit l'empreinte vue ; `run` (sortie bornée début et fin, chaque
morceau en direct, délai et annulation qui ferment le canal) ; `uploadTree`
par SFTP, qui **ne suit jamais un lien** et refuse au-delà de 20 000
fichiers ou 256 Mio avant de rien copier. Ni agent SSH, ni mot de passe, ni
clavier : la seule clé est celle que l'appelant lit au coffre.

`ssh2` 1.17 est installé **sans exécuter ses scripts d'installation**
(politique `allow-scripts` de npm 11) : ses deux modules natifs facultatifs
(`cpu-features`, liaison crypto) ne sont pas compilés, et il s'en passe —
constaté par les tests.

Preuves : `tests/unit/remote.test.ts` (10 tests) face à
`tests/fake-ssh-server.ts`, un hôte `ssh2` dans le processus qui **compte
les tentatives d'authentification** : zéro quand l'empreinte ne correspond
pas. L'empreinte d'une clé fixe est comparée à celle relevée avec
`ssh-keygen -lf` (OpenSSH 10.3). **Deux défauts introduits ont été vus
échouer** : empreinte non comparée, liens suivis à la copie. La première
mutation a montré un test qui restait **suspendu** au lieu d'échouer (la
session ouverte à tort n'était jamais fermée) : il la ferme désormais.
Trouvé en chemin : côté serveur, `ssh2` ne signale pas la fermeture d'un
canal par le client sur le canal (`close`) mais par `finish`, ou `close` de
la session ; l'hôte factice écoute les deux. Ce que Windows fait des
processus d'une session coupée reste à constater (5.4).

### Étape 5.2 — la déclaration d'une VM (2026-11-07)

Ce qui existe désormais : la table `windows_hosts` (migration 17,
`PROTOCOL_VERSION` 20), les routes `/api/windows` (lister, déclarer, lire,
tester, retirer), `harness windows` (`add`, `test`, `key`, `remove`), et
`powershellCommand` dans `remote`, qui fait voyager un script en
`-EncodedCommand` : `cmd.exe`, shell par défaut de Win32-OpenSSH, ne le relit
pas, et ce qui tourne est exactement ce qui a été montré.

- **La clé est générée par le daemon**, déposée au coffre **avant** que la VM
  soit écrite en base, et n'en sort jamais : la base, les réponses et la CLI
  n'ont que la clé publique. `--new-key` l'écrase au coffre.
- **L'empreinte est exigée à la première déclaration** (la ligne de
  `ssh-keygen -lf` est lue telle quelle) ; la CLI, sans elle, refuse **et**
  donne la commande qui la lit sur la VM.
- **Les commandes données à l'humain** sont dans `contracts/src/windows.ts`,
  une seule copie : la pose de la clé pour un administrateur
  (`administrators_authorized_keys`, `icacls` qui désigne les groupes par
  leur **SID** — leur nom change avec la langue de Windows), la lecture de
  l'empreinte, l'installation de `sshd`. **Aucune n'a encore tourné sur un
  vrai Windows** : la CI les exécutera telles quelles en 5.5.
- **Changer ce qu'on joint efface le dernier test** : adresse, port, compte,
  empreinte ou clé.

**Un écart au découpage** : l'attache d'une VM à un profil passe en 5.3, avec
l'outil `windows_run`. Attachée sans outil pour s'en servir, elle aurait
décrit à l'humain une capacité qui n'existe pas encore.

Preuves : `tests/unit/windows-hosts.test.ts` (9 tests, vrai daemon, hôte
factice qui répond désormais à PowerShell et note le script reçu) : refus
sans empreinte ou illisible ; clé au coffre, **ni en base ni au journal** —
le journal du daemon capturé, la base lue octet pour octet ; test réussi,
script arrivé intact ; empreinte fausse refusée **sans tentative
d'authentification** ; nouvelle clé qui ne sert plus à l'ancienne ; retrait
qui efface la clé du coffre ; CLI qui refuse sans empreinte et dit comment
la lire. **Quatre défauts introduits ont été vus échouer** : empreinte non
exigée, clé privée écrite au journal, nouvelle clé ignorée, dernier test
jamais effacé. Le deuxième est d'abord **passé** : la clé PEM a un retour à
la ligne tous les 70 caractères, qui coupait le morceau cherché ; la
recherche se fait désormais sans blancs.

`test:wait` (protocole 20) a échoué **une fois** sur un scénario que la
sortie gardée ne nommait pas — seule sa dernière ligne avait été conservée —,
puis a passé ses 13 scénarios à la relance. Non expliqué, et noté comme tel ;
une suite se relance désormais avec son journal entier.

**La CI a trouvé un défaut de `ssh2`** au premier passage de 5.2 (passage
`42786775241`, Windows) : le `before` de `remote.test.ts` levait « Malformed
OpenSSH public key » sur une clé qu'il venait de générer. Mesuré ensuite :
**une paire ed25519 sur 256** sort de `ssh2.utils.generateKeyPairSync` mal
formée — premier octet nul retiré, 31 octets annoncés au lieu de 32 —, et ni
la publique ni la privée ne se relisent (67 sur 20 000). Le daemon aurait pu
donner à une VM, une fois sur 256, une clé que rien ne lirait.
`generateKeyPair` relit désormais chaque paire, compare la publique dérivée
de la privée, vérifie une signature, et tire de nouveau sinon ; un test
provoque une paire mal formée pour éprouver le contrôle, puis en tire 2 000
— vu échouer sans le contrôle.

Le passage suivant (`42788888060`) a montré une seconde erreur, **de l'hôte
factice seul** : il créait la cible SFTP `/C:/midgaard/…` comme un dossier
nommé `C:`, que Windows refuse. Il traduit désormais une lettre de lecteur en
dossier (`C/…`) ; le code de copie, lui, envoie la forme qu'attend le SFTP de
Windows.


### Étape 5.3 — l'attache, le dossier de tâche, `windows_run` (2026-11-10)

Quatre décisions prises avec l'auteur avant d'écrire : **un profil Developer
seul** reçoit une VM (c'est son worktree qui part dessus), **une au plus** par
profil, **un script en ligne** d'au plus 3 000 caractères (`-EncodedCommand` ;
plus long, un `.ps1` du worktree), **une connexion par commande** (rien
d'ouvert pendant qu'une approbation attend). L'étape a été découpée en cinq,
chacune commitée et verte en CI à part.

**5.3a — l'attache.** Un profil porte `windows_host` (migration 18,
`PROTOCOL_VERSION` 21), posé par l'humain seul : `PUT
/api/agents/:id/windows`, `harness windows attach` / `detach`, et `windows
list` qui montre les profils de chaque VM. `setAgentWindowsHost` refuse tout
autre type que `developer` (`409`) et une VM non déclarée (`404`, avec la
liste) ; détacher est toujours permis. Le **retrait d'une VM la détache
d'abord des profils** et les nomme : une VM redéclarée sous le même nom ne se
retrouve pas attachée sans l'humain. Un agent créé hérite de la VM de son
profil de base. 4 tests ; deux défauts introduits vus échouer (contrôle du
type, retrait qui ne détache pas).

**5.3b — le dossier de tâche, dans `remote`.** `remoteTaskDir(home, taskId)`
donne `<home>/midgaard/tasks/<tâche>/work`, `<home>` lu par SFTP (aucune
supposition sur `C:\`), l'identifiant exigé en UUID. `replaceTree` efface
`work` puis recopie : un fichier retiré du worktree disparaît de la VM.
`removeTree` vérifie, **avant tout effacement**, que la cible est strictement
sous la racine permise, que la racine et les dossiers intermédiaires ne sont
pas des liens, et lit chaque entrée par `lstat` — un lien est retiré lui-même,
jamais parcouru. 7 tests ; deux défauts vus échouer (`stat` au lieu de
`lstat`, contrôle de la racine retiré).

**5.3c — l'outil `windows_run`.** Dans `tools`, derrière un `WindowsPort`
(comme le navigateur et les serveurs MCP) : fermé par défaut, une approbation
à chaque appel (aucune liste blanche ne s'y applique), l'humain lit la VM et
le script exact dont l'empreinte de l'approbation est tirée, et `run`
revérifie la VM — redéclarée autrement, rien ne tourne. Délai borné par
l'échéance, résultat non fiable. 7 tests avec un faux port ; deux défauts vus
échouer (politique sans approbation, contrôle de la VM changée retiré).

**5.3d — le branchement.** `WindowsSessions` (daemon) relie les trois : pour
une tâche d'un Developer à VM et worktree, le moteur pose le port et **ajoute
`windows_run` à la liste d'outils de la tâche**, pas au profil (comme
`ask_parent`). Chaque appel ouvre une connexion, recopie le worktree (jamais
`.git` ; les échantillons ne sont pas dans le worktree), lance le script dans
`work`, ferme. `endTask` efface le dossier de la tâche en fin de tâche, au
mieux. 6 tests avec un vrai store, un vrai coffre et l'hôte factice ; un
défaut vu échouer (`endTask` qui n'efface rien). `test:developer` (16
scénarios) reste vert : le branchement est inerte pour une tâche sans VM.

**5.3e — la documentation** : ce récit, `CLAUDE.md`, les README des paquets
`remote`, `tools` et `daemon`, et `docs/DEPANNAGE.md`.

**Un aléa de CI, pas de la slice.** Deux passages de suite ont eu un poste
coupé : le runner macOS jamais alloué sur la 5.3c (15 min en file, zéro
étape), et Windows sur la 5.3d — `test:developer` a échoué à V6 (le daemon ne
redémarre pas), puis le processus est resté suspendu jusqu'au timeout de 30
min du job. Les deux sont passés à la relance du seul poste coupé. La
fragilité du redémarrage du daemon sous Windows est connue (voir les manches
ratées de `test:lock` et `test:wait` plus haut) ; rien de la 5.3 ne la cause.

**Reste à constater, sur un vrai Windows.** La survie des processus d'une
connexion coupée (5.4) et ce que le SFTP de Win32-OpenSSH dit d'une **jonction
NTFS** (le refus de traverser un lien n'est prouvé que contre des liens POSIX)
se mesurent sur une vraie machine, avec la CI de la 5.5.
