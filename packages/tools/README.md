# `@midgaard/tools`

Les outils des agents. Ceux de la Slice 2 **lisent** ; ceux de la Slice 3
**écrivent ou exécutent, mais seulement dans le worktree** de la tâche, et
refusent partout ailleurs ; ceux de la Slice 5 **délèguent**, et seulement pour
une tâche `orchestrator`.

| Outil | Rôle |
|---|---|
| `read_file` | Un fichier texte du projet |
| `list_directory` | Le contenu d'un dossier, sans récursion |
| `search_files` | Une expression régulière sur les fichiers d'un **répertoire** du projet |
| `http_fetch` | Une URL publique, HTML converti en texte |
| `write_file` | Crée ou remplace un fichier du **worktree** |
| `edit_file` | Remplace un passage exact d'un fichier du worktree |
| `delete_file` | Supprime un fichier du worktree (jamais un dossier) |
| `git_diff` | Ce que l'agent a changé depuis le début de la tâche, fichiers nouveaux compris |
| `exec` | Une commande dans le worktree, **sous approbation humaine** par défaut |
| `list_agents` | Les profils auxquels déléguer, désactivés compris avec leur motif ; jamais un orchestrateur |
| `delegate_task` | Crée une sous-tâche et rend son identifiant **sans l'attendre** |
| `wait_for_task` | Attend la fin d'une sous-tâche, pauses d'approbation comprises ; résultat **non fiable** |
| `cancel_task` | Annule une sous-tâche de cette tâche, et d'aucune autre |
| `create_agent` | Crée un exécutant **pour cette tâche** à partir d'un profil de base (Slice 8) ; tout dépassement du profil est refusé avec son motif |
| `<serveur>__<outil>` | Un outil d'un serveur MCP déclaré (Slice 8), **construit pour la tâche** ; libre s'il est coché, approuvé sinon ; résultat **non fiable** |
| `submit_result` | **Le seul outil qui termine une tâche** |

## Ce que ce paquet garantit, et ce qu'il ne garantit pas

**Ce n'est pas une sandbox.** Le daemon tourne sous le compte de l'utilisateur ;
un agent qui contournerait ce module lirait tout ce que l'utilisateur peut lire.
C'est une **frontière d'intention** : elle empêche un agent qui dérape — ou
qu'une page web manipule — d'aller fouiller ailleurs que dans le dépôt d'où la
tâche a été déléguée. Le modèle de menace complet est dans
[`packages/daemon/README.md`](../daemon/README.md).

## Chemins : la fenêtre que `openUnderRoot` ferme

La vérification naïve — résoudre, comparer à la racine, ouvrir — laisse une
fenêtre : entre la comparaison et l'ouverture, le chemin peut changer de cible
(*TOCTOU*). Le plan (§5) l'exigeait explicitement : vérifier « **à l'ouverture du
descripteur, pas seulement avant** ».

`openUnderRoot` résout, vérifie, ouvre, puis **compare `dev` et `ino` du `fstat`
du descripteur ouvert** à ceux du `stat` d'avant. Si la cible a été substituée
entre-temps, l'identité ne correspond plus et l'ouverture est refusée.

Le message de refus ne dit jamais **où** menait le lien : un agent manipulé par
un contenu web n'a pas à apprendre l'arborescence de la machine.

## Un refus vaut mieux qu'un faux négatif

`search_files` cherche dans un **répertoire**. Si on lui passe un chemin de
fichier, il **refuse en disant quoi faire** — chercher dans le répertoire parent,
ou lire le fichier avec `read_file`.

Il a longtemps répondu « aucune correspondance » à la place : `readdir` lève
`ENOTDIR` sur un fichier, et le `catch` qui rend la marche tolérante aux
dossiers illisibles avalait l'erreur à la racine de la recherche. Le défaut a
été trouvé en vraie session : un agent a cherché un symbole **qui existait**,
l'a cru absent sur la foi de ce zéro, a reformulé quatre fois et y a laissé son
budget d'étapes.

Le même défaut est revenu par le filtre de nom, au premier essai réel de la
Slice 8 : `glob` est un **suffixe** (`.js`), et l'orchestrateur a passé `*.js`.
Aucun nom ne finissant par `*.js`, sept recherches ont rendu « aucune
correspondance » sur un fichier qui contenait les motifs, et il a conclu que
l'outil était cassé. Désormais (`nameSuffix`) :

- `*.js` et `**/*.js` sont ramenés au suffixe `.js` ; tout autre joker
  (`src/*.js`, `*.{ts,js}`) est **refusé** avec la forme attendue ;
- zéro fichier retenu par le filtre se dit comme tel (« no file name ends
  with … : nothing was searched »), jamais « aucune correspondance » ;
- un fichier de plus de 2 Mo, ou binaire, sauté par la recherche est **compté
  dans la réponse**.

Une ligne longue — un bundle minifié tient sur une ligne d'un mégaoctet — est
rendue **autour de chaque occurrence**, avec sa colonne (`lineExcerpts`), au
lieu de ses 300 premiers caractères : au même essai, quatre correspondances
montraient toutes le début du fichier.

La leçon est plus générale que l'outil : **un faux négatif est pire qu'un
refus**, parce qu'il a l'air d'une réponse. Un modèle ne peut pas distinguer
« je n'ai rien trouvé » de « je n'ai rien cherché » — alors l'outil doit le
faire pour lui. La tolérance reste là où elle a un sens : un sous-dossier
illisible n'interrompt toujours pas une recherche en cours.

## Écrire : deux serrures, et aucune approbation à la place

Un outil d'écriture ne fait rien si le contexte ne porte pas `writable: true`,
ce que le daemon ne pose que lorsque la racine **est** le worktree de la tâche.
Sans lui — le Researcher, ou un profil qui aurait reçu `write_file` par
erreur — la politique **refuse**, sans demander d'approbation. Transformer ce
refus en demande apprendrait à cliquer « oui » ; et écrire hors d'un worktree
n'est pas réversible, donc pas négociable (PLAN §5). Le champ est facultatif et
**fermé par défaut** : un contexte construit sans y penser ne peut rien écrire.

Dans le worktree, écrire est autorisé sans approbation : tout y est réversible
jusqu'au merge, qui est humain.

### Ce que `openForWrite` vérifie

La cible d'une écriture n'existe souvent pas encore : `realpath` ne peut pas la
canonicaliser. Six vérifications, dans l'ordre :

1. le chemin lexical reste sous la racine ;
2. **aucun segment `.git`**, casse ignorée. Dans un worktree, `.git` est un
   fichier qui dit à Git où est le dépôt : le réécrire redirigerait chaque
   commande du harness — commit de fin compris — vers un autre dépôt ;
3. le plus proche dossier existant a un chemin réel sous la racine (un
   dossier-lien qui mène dehors est arrêté là) ;
4. la cible n'est **pas un lien symbolique**, même vers un fichier de la racine ;
5. la cible, sur son chemin réel, n'est **pas dans un sous-module**
   (`ToolContext.workspace.submodules`) : le worktree les laisse vides, et ce
   qu'on y écrit est ignoré **sans un mot** par le `git add -A` du commit de fin
   — constaté. L'agent croirait avoir livré un fichier que la branche n'a pas ;
6. après ouverture avec `O_NOFOLLOW`, le descripteur désigne un fichier
   ordinaire et le dossier parent a gardé son identité et son chemin réel.

Le fichier est ouvert **sans** `O_TRUNC` et vidé une fois tout vérifié : un refus
tardif ne doit pas avoir détruit ce qu'il refuse. `delete_file` supprime un lien
**lui-même**, jamais sa cible.

**Sous Windows**, `O_NOFOLLOW` n'existe pas. Le `lstat` de l'étape 4 reste seul,
avec une fenêtre étroite entre lui et l'ouverture. Contre-épreuve faite : chacune
des deux serrures, seule, suffit à faire passer les tests de liens.

`edit_file` recompose le texte à la main au lieu d'appeler `replace` :
`String.replace` interprète `$&` et `$1` dans le texte de remplacement, et du
code contient des `$`. Un test le verrouille.

**Fins de ligne.** `edit_file` tient `\n` et `\r\n` pour équivalents en
cherchant `old_string`, et écrit `new_string` avec la fin de ligne du passage
remplacé (CRLF dès qu'il en contient ; à défaut, celle qui domine le fichier).
Sous Windows, Git convertit le worktree en CRLF au checkout, et un modèle écrit
`\n` : la recherche octet pour octet ne trouvait rien (docs/SLICE3.md, leçon
n° 20). Rien d'autre n'est relâché — l'unicité se compte sur la recherche
tolérante, si bien qu'un passage présent une fois en LF et une fois en CRLF est
ambigu, pas tranché au hasard. Le résultat dit au modèle quand des fins de ligne
ont été adaptées. `write_file`, lui, écrit ce qu'on lui donne.

## `git_diff` : le seul accès à Git, en lecture

L'agent ne commite pas : c'est le harness qui le fait à `submit_result`, et la
branche ne bouge qu'à ce moment-là. `status` et `log` n'apprendraient rien que
ce diff ne dise. Et un outil `git` à arguments libres exposerait `-c`,
`--upload-pack`, `--output` et les alias de la configuration ; un outil qui ne
prend aucun argument n'a rien à filtrer. Le diff vient de `@midgaard/workspace`,
qui ne lance ni hook ni pilote désigné par l'arbre de travail.

## `exec` : l'approbation est la frontière

`exec` n'est **pas une sandbox**. La commande tourne sous le compte de
l'utilisateur, avec son dossier personnel : elle lit ce qu'il lit et joint le
réseau. La frontière est humaine — chaque commande attend une approbation, et
l'humain lit **exactement** ce qui va tourner :

```text
exec — exécuter /opt/homebrew/bin/npm test -- --grep 'a b' dans /Users/…/worktrees/app-1a2b3c4d/0b9f3c2e/packages/api (délai 120 s)
```

Ce texte vient de `prepare`, qui fige l'opération **avant** la demande. `run`
exécute ce qui a été figé, après avoir revérifié que le binaire est toujours le
même fichier (périphérique, inœud, taille, date) : la demande peut attendre dix
minutes, et le monde change pendant ce temps. L'empreinte de l'approbation est
tirée du détail structuré (`operation_detail`), pas de ce texte.

Les guillemets ne servent qu'à l'affichage : `["a;b"]` et `["a", ";", "b"]` ne
doivent pas s'afficher pareil, sinon l'on approuve l'un en lisant l'autre.

**Pourquoi pas une liste blanche d'office** : l'agent écrit dans son worktree,
donc dans `package.json`. Autoriser `npm test` sans regard, c'est autoriser ce
qu'il a mis dans `scripts.test`. `MIDGAARD_EXEC_ALLOW` existe — des argv
**exacts**, séparés par `;` (`npm test;npx tsc --noEmit`) — vide par défaut, et
le daemon rappelle la conséquence dans son journal à chaque démarrage. Pas de
guillemets dans cette variable : un argument contenant une espace ne peut pas
être mis en liste blanche, et c'est voulu.

**Une entrée de dépôt peut être un préfixe** (Slice 9) : elle couvre tout argv
qui commence par ses mots, comparés un à un (`pytest tests` ne couvre pas
`pytest tests_evil`). `execAllowed` rend la règle qui couvre l'argv — l'entrée
exacte d'abord — et la politique la nomme : « commande en liste blanche
(préfixe « python -m pytest … ») », raison inscrite à la timeline
(`allow_reason`). L'outil ne juge pas les préfixes : `ToolContext.execAllow`
n'en reçoit que de jugés (`execPrefixRefusal`, à l'ajout et au départ de la
tâche). La variable globale reste exacte.

**La sortie se suit en direct** (Slice 6). `runCommand` passe chaque morceau
lu à `onOutput`, que l'outil branche sur `ToolContext.output`, posé par la
boucle pour un appel. Les octets sont bruts : la découpe par ligne,
l'expurgation et le plafond sont dans `agent-runtime` (`OutputBatcher`). Un
observateur qui lève ne coupe ni la commande ni sa capture. Ce que reçoit le
modèle reste la capture tête et queue.

| Garantie | Comment |
|---|---|
| Aucun shell | `spawn` sans `shell` : `;`, `\|`, `$()` restent des caractères |
| Ce qu'on approuve est ce qui tourne | le binaire est **résolu par le harness** avant la demande (`prepare`) et **revérifié** avant de lancer ; les entrées **relatives** du `PATH` sont ignorées |
| Uniquement dans un worktree | sans `ToolContext.writable`, refus sans demande |
| Pas de secrets du daemon | environnement reconstruit (`execEnv`) ; `CI=1`, `NO_COLOR=1` imposés |
| **Aucun processus ne survit** | groupe de processus propre, tué à la sortie, au délai (`SIGTERM`, puis `SIGKILL` après 2 s) et à l'annulation — et par la **garde** si le daemon meurt net |
| Pas au-delà de la tâche | délai plafonné par l'échéance de la tâche (`ToolContext.deadline`) |
| Sortie bornée | 8 Ko + 32 Ko de fin pour stdout, 4 Ko + 12 Ko pour stderr ; le retrait du milieu est écrit |
| Sortie encadrée | `untrusted: true` : une sortie de commande peut contenir n'importe quoi |

Un code de sortie non nul **n'est pas une erreur** : un test qui échoue est une
réponse, que l'agent doit lire pour corriger son code.

Pourquoi tuer le groupe **même quand la commande sort normalement** : sans
cela, un `npm run dev` ou un `sleep 999 &` survivrait à la tâche, et le harness
attendrait indéfiniment que ces survivants ferment les tubes de sortie. Le test
le vérifie en interrogeant le pid du petit-enfant au système.

**Sous Windows**, trois limites, annoncées plutôt que contournées :

- `npm`, `npx` et tout script `.cmd`/`.bat` sont **refusés** : Node ne les lance
  plus sans shell (CVE-2024-27980), et `cmd.exe` a des règles d'échappement qui
  ne se maîtrisent pas. Lancer `node` avec le chemin du script fonctionne ;
- l'arbre de processus est tué par `taskkill /T`, qui ne retrouve plus les
  enfants d'un parent déjà sorti. **Nuance constatée en CI** : le test du
  petit-enfant laissé par une commande sortie passe pourtant sous Windows,
  vraisemblablement parce que libuv place ses enfants dans un *Job Object* qui
  les tue avec leur parent. Non constaté pour un programme qui ne passe pas par
  libuv ;
Le reste — chemins, liens, `.git`, `exec`, résolution par `PATHEXT`, fins de
ligne d'`edit_file` dans un vrai dépôt en CRLF — tourne en
CI sur macOS, Linux et Windows (`.github/workflows/worktrees.yml`, et toutes
les suites dans `e2e.yml`).

**Les chemins montrés au modèle s'écrivent en `/`**, sur toutes les
plateformes et pour tous les outils (`toolPath`). Sous Windows, les outils de
lecture rendaient des `\` quand ceux d'écriture rendaient des `/` — constaté
en CI.

Un processus qui quitte volontairement son groupe (`setsid`) échappe aussi au
nettoyage, sur toutes les plateformes : c'est la limite d'un contrôle sans
sandbox.

### La garde : quand le daemon meurt net

Les trois moments où `exec` tue un groupe supposent que le daemon vit encore.
Tué par `SIGKILL`, il ne tue plus rien, et le groupe — détaché de lui pour
pouvoir être tué entier — continue : constaté, une commande a écrit dans le
worktree trois secondes après la mort du daemon. `guard.ts` lance donc, à la
première commande — **avant** elle —, **un** processus de garde dans son propre
groupe. Le daemon lui inscrit chaque groupe lancé (`+pid`) et le retire une fois
tué (`-pid`) sur un tube. Quand le daemon meurt, le système ferme le tube,
quelle que soit la manière ; la garde lit la fin du flux et tue les groupes
encore inscrits.

**Limite constatée (Slice 4, étape 7).** Entre la fin de `spawn` et
l'inscription, il reste un intervalle : un daemon tué net exactement là laisse
une commande que la garde ne connaît pas. Il ne tient qu'en une écriture sur un
tube ouvert, mais l'ordonnanceur peut y suspendre le daemon : sous forte charge
(vingt processus de charge sur dix cœurs), une à deux commandes sur 300 ont
survécu, et la garde instrumentée d'un de ces cas n'avait rien reçu. Aucune
sur 48 sans charge. Le fermer exigerait que la commande attende son
inscription avant de s'exécuter.

Pas de `prctl(PR_SET_PDEATHSIG)` (Linux seulement, et Node ne l'expose pas), pas
de pid persistés pour les tuer au redémarrage (un redémarrage de la machine les
rend à d'autres processus). Si la garde ne démarre pas, le journal du daemon le
dit une fois et `exec` fonctionne comme avant. Éprouvé par `exec.test.ts` (un
lanceur tué par `SIGKILL` une fois sa commande inscrite, sa commande doit
mourir ; la contre-épreuve sans inscription échoue) et par V12 dans
`test:developer` (un vrai daemon). Sous Windows, elle passe par `taskkill /T` :
le test et V12 y passent en CI depuis la Slice 4 (étape 5), sans dire **qui** a
tué la commande — la garde ou le *Job Object* de libuv (docs/SLICE4.md).

## `http_fetch`

Quatre contrôles, chacun contre une menace précise :

1. **Schéma** — `http` et `https` seulement. `file://` ferait de `http_fetch` un
   lecteur de disque sans racine.
2. **Destination publique, à chaque saut.** Les redirections sont suivies à la
   main (`redirect: 'manual'`) : laisser `fetch` suivre ne contrôlerait que la
   première URL, et une redirection vers `169.254.169.254` passerait sans que
   rien ne la voie. Boucle locale, plages privées, lien-local (donc l'IMDS), NAT
   d'opérateur, multicast — refusés, en v4 comme en v6, `::ffff:127.0.0.1`
   compris.
3. **Taille**, coupée *pendant* la lecture : `content-length` est facultatif, et
   un serveur hostile ment.
4. **Type textuel** — un binaire réinjecté coûte une fortune en jetons.

**Limite connue** : on résout le nom, on vérifie toutes les adresses, puis
`fetch` résout une seconde fois. Un DNS à très faible TTL peut théoriquement
rendre une adresse publique à la vérification et privée à la connexion (*DNS
rebinding*). Fermer cette fenêtre demanderait de réimplémenter la couche de
transport ; c'est dit plutôt que sous-entendu.

### Politique des hôtes

| `MIDGAARD_HTTP_POLICY` | Hôte hors liste blanche |
|---|---|
| `open` (défaut) | autorisé s'il est public |
| `approval` | suspend la tâche, demande un humain |
| `allowlist` | refusé |

Le plan (§5) prévoyait la liste blanche seule. En pratique, un Researcher qui ne
peut lire que des domaines prévus d'avance ne sert à rien : personne ne connaît
à l'avance l'URL de la documentation qu'il faudra consulter. Le mécanisme existe,
le réglage aussi (`MIDGAARD_HTTP_ALLOW`), et le défaut est **annoncé** plutôt
que présenté comme une liste blanche qui n'en serait pas une. Les adresses
privées restent refusées dans les trois cas.

## `web_search` n'est pas un outil appelable

Chez Venice, la recherche web est un **drapeau de requête**
(`venice_parameters.enable_web_search`), pas une fonction que le modèle appelle.
En faire un outil exigerait un appel de modèle **supplémentaire** par recherche,
donc de payer deux fois ce que le fournisseur fait en une.

Il reste dans la liste d'outils d'un profil, où il agit comme l'interrupteur qui
active la recherche native, sans jamais être proposé au modèle. La boucle
journalise un appel `web_search` **a posteriori** dès que des citations
reviennent : observable, compté, attribué.

## Déléguer : un port, et rien d'autre (Slice 5)

Les quatre outils de délégation ne font rien eux-mêmes. Ils appellent le
`DelegationPort` que le daemon pose dans `ToolContext.delegation` pour une tâche
`orchestrator`, et pour elle seule. **Sans port, ils refusent**, sans demander
d'approbation — fermé par défaut, comme `writable` : déléguer est une capacité
de profil, pas une opération qu'un humain accorderait au coup par coup.

Les règles qui protègent ne sont **pas** ici : profondeur 1, parent actif et
orchestrateur, dossier hérité du parent, rattachement par `parent_task_id`. Elles vivent dans
`TaskManager.create`, seul endroit où une tâche naît ; une seconde copie dans
l'outil finirait par diverger. Le port est lié à sa tâche : il ne voit, n'attend
et n'annule que ses propres sous-tâches.

Trois choses que les outils garantissent seuls :

- **`wait_for_task` marque son résultat `untrusted`, toujours.** Le résumé, les
  détails et même le message d'erreur d'un enfant sont écrits par un modèle qui
  a pu lire le web ou une sortie de commande. La boucle l'encadre donc avec un
  nonce avant de le réinjecter — prouvé dans la boucle réelle avec un résultat
  qui contient la balise de fin (`tests/unit/delegation-tools.test.ts`).
- **Aucun outil n'approuve.** Une sous-tâche en pause d'approbation est attendue
  avec l'humain ; l'orchestrateur n'a aucun moyen de décider à sa place.
- **Aucun montant sans sa provenance** : ce que rend `wait_for_task` porte
  `cost_usd` **et** `cost_source`, et la branche d'un Developer, que
  l'orchestrateur relaie à l'humain qui seul merge.

## Échanger : questions et propositions (Slice 6)

La délégation devient un échange, toujours par le port :

- **`wait_for_task` rend la main quand un enfant attend son parent**, avec une
  consigne (`next_action`) : `answer_question`, `review_proposal`,
  `result_ready`, `task_ended_without_result` ou `wait_again`. Une proposition
  arrive avec son diff, **non commité**. Tout reste `untrusted`.
- **`send_message`** répond à une question ou renvoie une proposition ;
  l'enfant reprend dans la même conversation et le même worktree.
- **`accept_result`** accepte une proposition et rend la main une fois
  l'enfant fini, branche et commit compris. C'est le harness qui commite, pas
  l'outil, et rien n'est mergé : ce n'est pas une approbation.
- **`ask_parent`** est la question d'un enfant. Comme `submit_result`, la boucle
  l'intercepte ; son `run` refuse, pour qu'un oubli d'interception se voie. Le
  daemon ne le donne qu'aux tâches qui ont un parent.

## `read_image` : voir sans rien garder (Slice 7)

Une image du projet, montrée au modèle. Le type se lit dans les premiers
octets (PNG, JPEG, WebP, GIF ; un SVG est du texte, refusé), la taille est
plafonnée à 4 Mo, le chemin passe par `openUnderRoot`. Le résultat porte
l'image dans `images`, que la boucle joint après les résultats de l'étape ; le
résumé journalisé n'en garde que le chemin, le type, la taille et le début du
SHA-256. **Sans `ToolContext.vision.enabled`, l'outil refuse**, avec le motif
que le moteur a posé — fermé par défaut, comme `writable`.

## Le navigateur : une session approuvée, des saisies approuvées (Slice 7)

Huit outils (`browser.ts`), sur le navigateur isolé de la tâche, que le daemon
remet par `ToolContext.browser` — un `BrowserPort`, posé pour un profil qui a
ces outils et pour lui seul. Absent, ou sans `ToolContext.vision.enabled`, tous
**refusent avec leur motif**, sans approbation à la place.

| Outil | Décision |
|---|---|
| `browser_open` | **Approbation** : l'opération préparée porte l'objectif, l'adresse normalisée (`http:`/`https:` seulement), la durée, bornée par l'échéance de la tâche, et les **textes prévus** (`planned_inputs`, 20 au plus, chacun avec ou sans Entrée) ; le texte approuvé les cite et dit que les clics seront libres, envoi de formulaire compris. Refusé si une session est déjà ouverte |
| `browser_screenshot`, `browser_goto`, `browser_click`, `browser_scroll`, `browser_close` | Libres dans la session |
| `browser_key` | Libre, **sauf Entrée** seule : approbation, puisqu'elle envoie le champ où l'on vient de taper |
| `browser_type` | **Libre pour un texte prévu**, une fois, identique à la lettre et avec la même Entrée ; sinon **approbation**, avec le texte exact, l'adresse et le champ actif. `press_enter` tape puis presse Entrée sous la même décision |

**Ce que l'humain a approuvé est revérifié au moment d'agir.** Une saisie ou
une Entrée approuvées une par une ne partent pas si l'adresse ou le champ actif ont changé
pendant la décision : une page peut se rediriger seule. Le test le prouve, et
vérifie que rien n'a été tapé.

**Les textes prévus regroupent les approbations sans rien relâcher** (décision
du 2026-11-05, après l'essai réel). L'agent annonce à l'ouverture les textes
qu'il compte taper ; l'humain les lit dans la demande de session, entre
guillemets et échappés comme du JSON. Chacun part ensuite **une fois** sans
nouvelle demande : la session le retire de sa liste **avant** de taper, et une
préparation périmée qui le croyait encore prévu ne tape rien. À une lettre
près, ou sans la même Entrée, c'est un autre texte, et l'humain est
sollicité. Un texte prévu n'est lié **ni à une page ni à un champ** : il
peut partir dans n'importe quel champ de la session, après un `browser_goto`
compris. C'est le texte que l'humain a approuvé, avec l'objectif et l'adresse
de départ ; il n'y a pas d'attente pendant laquelle la page aurait pu changer
sous ses yeux, donc rien à revérifier. L'essai réel avait demandé sept approbations
pour trois tâches ; il en aurait demandé une.

**Un clic n'est jamais soumis à l'humain, même sur « Envoyer »** (décision du
2026-11-05). Il peut envoyer ce que l'agent n'a pas tapé : un champ prérempli
par la page, une case, une liste. Le reconnaître dans la page aurait été une
promesse qu'une page hostile déjoue (un bouton déguisé, un script au clic).
On le dit donc plutôt que de le cacher : dans la demande de session, que
l'humain approuve, et aux descriptions de `browser_open` et `browser_click`
et dans la consigne du Navigator, qui ne doit envoyer que ce que son objectif
demande. Ce qui est garanti, c'est qu'**aucun texte choisi par l'agent n'entre
dans un champ** sans que l'humain l'ait lu.

Chaque action rend une **capture** JPEG et l'adresse, le titre et le champ
actif de la page. Le résultat est **non fiable** : encadré, et la tâche marquée.
L'image porte `transient` : la boucle retire la précédente de la conversation
(`dropTransientImages`). Le résumé journalisé ne garde que l'action et
l'adresse ; le titre, écrit par la page, ne va qu'au modèle.

`BROWSER_KEYS` est la liste fermée des touches, que le paquet `browser`
réexporte ; `VISION_TOOLS` (`read_image` et les huit) sont les outils retirés
d'un modèle qui ne lit pas les images.

## Les outils MCP : construits pour la tâche (Slice 8)

`mcp.ts` ne contient aucun outil : il les **construit**, au départ d'une
tâche, à partir du catalogue que ses serveurs annoncent à ce moment-là
(`mcpTools`). Leur nom, leur description et leur schéma viennent du serveur.

| Règle | Pourquoi |
|---|---|
| Nom `<serveur>__<outil>` ; un nom qu'un fournisseur refuserait est **écarté et dit** | Aucun conflit avec un outil intégré ; et deux noms retouchés pourraient se confondre |
| Description **signée** (« écrite par ce serveur, pas par ton opérateur »), bornée à 1 500 caractères, et qui annonce l'approbation | Le modèle la lit comme une consigne de plus, à chaque appel |
| Schéma envoyé tel quel (`Tool.parameters`), arguments réduits à « un objet » ici | Le serveur fait autorité sur ses arguments, et les valide |
| Libre **seulement** si l'empreinte cochée est celle annoncée au lancement ; sinon approuvé sur l'appel exact (serveur, outil, empreinte, arguments) | L'humain a coché ce qu'il a lu ; un serveur mis à jour sur place ne change pas ce qu'il a autorisé |
| `run` envoie les arguments du **détail figé**, pas ceux relus du modèle | Ce qui part est ce qui a été approuvé |
| Résultat **toujours** `untrusted`, borné, une image ou un son **nommés** sans leurs octets, `isError` dit en tête | Il vient d'un binaire, d'une page ou d'un fichier que personne n'a relu |
| Sans `ToolContext.mcp`, refus — même coché | Fermé par défaut, comme le navigateur |

Ce que ces outils **ne bornent pas** : la racine du projet. Un serveur comme
REA lit un binaire n'importe où ; Midgaard ne peut pas vérifier un chemin dans
des arguments dont il ignore le sens (docs/SLICE8.md, décision 8). C'est dit à
l'humain quand il coche un outil.

## `submit_result` : la fin est un acte

Une boucle qui s'arrêterait sur « le modèle n'a demandé aucun outil » s'arrêterait
aussi quand il réfléchit à voix haute, quand il pose une question, ou quand il
s'excuse. On récupérerait du texte libre là où l'on attend un résultat
exploitable, sans savoir distinguer « fini » de « coincé ».
