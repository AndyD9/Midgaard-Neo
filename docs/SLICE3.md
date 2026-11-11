# Slice 3 — Developer, worktrees, approbations

**Date :** 2026-10-29 · **Objectif (PLAN §7) :** un Developer implémente un
changement dans un worktree isolé, une commande sensible suspend la tâche
jusqu'à décision humaine, le diff est consultable, Claude récupère le résultat.

**État : terminée.** Livrable atteint et éprouvé en vraie session ; suites
`workspace`, écriture et `exec` vertes sur macOS, Linux et Windows (passage
`41050506668`). Le 2026-10-30, depuis
une session Claude Code, un Developer sur Venice a ajouté une route `/health`
et son test dans un worktree isolé ; `npm test` a suspendu la tâche jusqu'à
l'approbation, donnée dans le dashboard ; le diff s'y lisait ; Claude a relayé
la branche sans merger ; et **le coût affiché, 0,0022972 $, est exactement ce
que Venice a débité**. Huit étapes livrées, 255 tests unitaires et 47
scénarios d'intégration, de bout en bout et de navigateur, 0 échec.

Ce qui n'est **pas** prouvé est dit au § « Ce qui reste ouvert » : l'essai réel
est un passage unique, sur un dépôt minuscule, et seules les suites unitaires
de la slice — pas le daemon de bout en bout — ont tourné sous Windows et Linux.

---

## Les décisions prises avec l'auteur

Quatre questions posées avant d'écrire une ligne. Les deux premières étaient
renvoyées à cette slice par le plan lui-même (§9.4 et §9.5).

| Question | Réponse retenue |
|---|---|
| Comment se termine une tâche Developer ? | **Merge manuel uniquement.** Le harness laisse une branche `midgaard/<tâche>` commitée et son diff ; il ne merge jamais |
| Que deviennent les worktrees ? | **Conservés jusqu'au nettoyage.** Rien n'est supprimé automatiquement ; la branche survit au worktree |
| Où les créer ? | **`~/.midgaard/worktrees/`**, hors de tout dépôt |
| Quelle politique pour `exec` ? | **Approbation par défaut**, liée à l'argv exact. Liste blanche vide d'office |

La quatrième mérite son raisonnement, parce qu'elle s'écarte du plan. Le plan
(§4) prévoyait « `exec` sur allowlist, tout le reste : approbation ». Mais un
agent Developer **écrit** dans son worktree : il peut réécrire `package.json`.
Mettre `npm test` en liste blanche, c'est donc autoriser sans approbation
l'exécution de ce que l'agent a écrit dans `scripts.test`. Une liste blanche par
nom de binaire n'est pas une frontière dès que la commande exécute le code du
projet. D'où le défaut : tout demande une approbation, et l'on n'ajoute à la
liste qu'en connaissance de cause — ce que l'interface devra dire en ajoutant.

---

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | Paquet `workspace` (worktrees, commit, diff, retrait) et table `workspaces` | ✅ livrée |
| 2 | Outils d'écriture bornés au worktree, refus d'écrire sous `.git`, `git_diff` en lecture | ✅ livrée |
| 3 | `exec` contrôlé : sans shell, binaire résolu d'avance, environnement reconstruit, groupe de processus tué, délai borné par la tâche, sortie bornée | ✅ livrée |
| 4 | Approbations liées à l'opération exacte (outil, argv, dossier, chemin), affichées telles quelles | ✅ livrée |
| 5 | Profil `developer` : worktree préparé en `preparing`, lecture et écriture reroutées sur le worktree, commit de fin à `submit_result`, branche et diff dans le résultat | ✅ livrée |
| 6 | Onglet Files/Diff du dashboard, route de diff | ✅ livrée |
| 7 | `harness workspaces` (liste, nettoyage), `doctor` vérifie Git — et la liste blanche `exec` par dépôt promise à l'étape 3 | ✅ livrée |
| 8 | Bout en bout MCP, puis l'essai d'acceptation du plan : « fais implémenter une route `/health` » | ✅ livrée — coût exact au microdollar |

L'ordre suit une règle : **rien de ce qu'un agent peut faire n'arrive avant ce
qui le borne.** Les worktrees d'abord (sans eux, écrire n'est pas réversible),
les outils ensuite, le profil qui les assemble en dernier.

---

## Étape 1 — les worktrees

### Ce qui existe

- **`@midgaard/workspace`** : `inspectRepository`, `createWorktree`, `commitAll`,
  `diffWorktree`, `worktreeState`, `removeWorktree`. Détail et garanties :
  [packages/workspace/README.md](../packages/workspace/README.md).
- **Migration 4**, table `workspaces` : une ligne par tâche, jamais supprimée.
  Cycle `active → kept → removed`.
- **Trois événements**, `workspace.created`, `workspace.kept`,
  `workspace.removed`, écrits **dans la même transaction** que la ligne qu'ils
  racontent — le dépôt a gagné un `recordUnlocked` pour cela. Le bus les
  diffuse ; la timeline du dashboard sait les afficher.
- **`keepActiveWorkspaces()`** : au redémarrage, un worktree dont la tâche
  devient `interrupted` passe en `kept`, jamais retiré (PLAN §3 : « son
  worktree est conservé pour inspection »). Le daemon ne l'appelle pas encore :
  il n'existe aucun worktree tant qu'aucun profil n'en crée.
- **`PROTOCOL_VERSION` 5** : le vocabulaire du journal a changé.

### Ce qui le prouve

`tests/unit/workspace.test.ts` — 19 tests sur de **vrais** dépôts Git jetables,
jamais sur des sorties de `git` recopiées. Chaque garantie est vérifiée par son
effet sur le disque. Et cinq tests de dépôt dans `tests/unit/store.test.ts`.

Rien d'antérieur n'a bougé : 198 tests unitaires, 10 d'instance unique, 7
d'intégration, 12 de bout en bout MCP et 7 dans un vrai navigateur, 0 échec,
avec le dashboard recompilé pour les nouveaux libellés de la timeline. Ces
suites prouvent que le changement de protocole et la migration 4 ne cassent
rien ; elles **n'exercent pas** les worktrees, qu'aucun chemin du daemon
n'emprunte encore.

**Contre-épreuve faite** : on a retiré `core.hooksPath`, `--no-verify`,
`--no-gpg-sign` et l'environnement reconstruit, relancé la suite, et constaté
que les quatre tests de sécurité échouaient — puis tout restauré. Un test de sécurité qui passe
aussi sans la protection ne prouve rien ; ceux-ci ne passent pas.

### Ce que l'écriture a appris

**1. `--no-verify` ne ferme pas la porte des hooks.** C'est le réflexe, et il
est faux : il saute `pre-commit` et `commit-msg`, mais `prepare-commit-msg` et
`post-commit` tournent toujours — **constaté** avec Git 2.54, quatre hooks posés,
deux exécutés malgré `--no-verify` — et `git worktree add` lance `post-checkout`. Le
danger est concret : Husky range ses hooks **dans l'arbre de travail**
(`core.hooksPath=.husky`), et dans un worktree cet arbre est écrit par l'agent.
Sans protection, l'agent réécrit `.husky/post-commit`, et le commit de fin de
tâche du harness l'exécute — sans approbation. Seul `-c core.hooksPath=<nul>`,
sur **chaque** commande, ferme tout.

**2. La signature de l'utilisateur est une attestation.** Un utilisateur qui
signe tous ses commits (`commit.gpgsign=true`) aurait vu sa clé apposée sur le
code de l'agent — ou une invite de phrase secrète que personne ne verrait,
bloquant la tâche. Les commits d'agent sont non signés et à l'identité
`Midgaard <agent> <agent@midgaard.invalid>`.

**3. Un diff ordinaire oublie l'essentiel.** `git diff <base>` ignore les
fichiers non suivis — c'est-à-dire, pour un agent qui crée `src/health.ts`, le
fichier même qu'on lui a demandé. `git add -N` réglerait la question en
modifiant l'index de l'agent. Le diff travaille donc sur une copie de l'index.

**4. Le travail en cours de l'utilisateur est hors du worktree, et doit le
rester — mais pas en silence.** Le worktree part du dernier commit. Un agent à
qui Claude décrit une fonction non commitée ne la trouvera pas, et sans le
chiffre `base_dirty` personne ne comprendrait pourquoi. C'est la règle « ne
rien décrire qui n'existe pas », appliquée dans l'autre sens : ne rien taire de
ce qui manque.

**5. Un monorepo ouvert sur un sous-dossier.** Claude Code peut être ouvert sur
`packages/api`. Le worktree, lui, est celui du dépôt entier ; l'agent doit
travailler dans `packages/api` **du worktree**. D'où la colonne `subdir`.

---

## Étape 2 — écrire, seulement dans le worktree

### Ce qui existe

- **`write_file`, `edit_file`, `delete_file`** (`packages/tools/src/write.ts`),
  et **`git_diff`** (`packages/tools/src/git.ts`), dans la boîte à outils.
- **`ToolContext.writable`** et **`ToolContext.workspace`**, facultatifs et
  **fermés par défaut**. Le moteur des agents les pose explicitement à `false`
  et `null` : aucun profil n'a encore de worktree, donc rien ne s'écrit nulle
  part. Le déplacement de la racine sur le worktree est l'affaire du profil
  `developer` (étape 5) — c'est pourquoi la ligne « lecture reroutée » a changé
  d'étape dans le découpage.

Détail des vérifications de chemin : [packages/tools/README.md](../packages/tools/README.md).

### Ce qui le prouve

`tests/unit/write-tools.test.ts` — 19 tests, chaque refus vérifié **par son
effet** : le fichier visé hors de la racine garde son contenu, rien n'apparaît
dehors, `.git` reste intact, le lien n'est pas remplacé. Plus un test de boucle
(`agent-runtime.test.ts`) : un profil qui aurait reçu `write_file` par erreur
voit l'appel refusé, **sans** demande d'approbation. 218 tests unitaires en
tout.

**Contre-épreuve faite**, protection par protection : politique toujours
ouverte, segment `.git` ignoré, dossier-lien non vérifié, lien non refusé,
`replace` au lieu de `split` — chacune fait échouer deux à quatre tests. Et
les deux serrures contre les liens (`lstat` avant, `O_NOFOLLOW` à l'ouverture)
tiennent **chacune seule** : c'est ce qui rend acceptable leur absence partielle
sous Windows, où `O_NOFOLLOW` n'existe pas.

### Une question tranchée : le `git` de l'agent

L'étape 1 laissait ouvert ce que l'agent recevrait de Git. Réponse : **`git_diff`,
sans argument, et rien d'autre.**

- **Le commit est un acte du harness**, à `submit_result` (étape 5). La branche
  ne bouge qu'à ce moment-là, comme la fin d'une tâche n'arrive que par lui.
- **`status` et `log` n'apprennent rien** que ce diff — commits, modifications
  et fichiers nouveaux — ne dise déjà.
- **Chaque argument de `git` est une surface** : `-c` réécrit la configuration,
  `--upload-pack` lance un programme, `--output` écrit où l'on veut, et les
  alias de l'utilisateur sont des commandes. Un outil `git` à arguments libres
  demanderait de tous les filtrer ; un outil qui n'en prend aucun n'a rien à
  filtrer.

### Ce que l'écriture a appris

**6. `.git` est un fichier dans un worktree, et c'est une cible.** Il contient
`gitdir: …`, l'adresse du dépôt. Un agent qui le réécrit redirige chaque
commande Git du harness — le commit de fin compris — vers le dépôt de son choix,
celui de l'utilisateur par exemple. Tout segment `.git`, casse ignorée (les
systèmes de fichiers par défaut de macOS et Windows ne la distinguent pas), est
refusé en écriture et en suppression.

**7. Un refus tardif ne doit rien avoir détruit.** Ouvrir avec `O_TRUNC` puis
constater que le parent a changé aurait vidé le fichier qu'on refusait d'écrire.
Le fichier est ouvert sans troncature et vidé une fois tout vérifié.

---

## Étape 3 — `exec`, sous approbation

### Ce qui existe

- **L'outil `exec`** (`packages/tools/src/exec.ts`) : un programme, ses
  arguments, un dossier du worktree, un délai. Politique : refus hors worktree,
  **approbation** par défaut, autorisation d'office pour un argv exactement en
  liste blanche. Détail : [packages/tools/README.md](../packages/tools/README.md).
- **`MIDGAARD_EXEC_ALLOW`** → `HarnessConfig.execAllow`, vide par défaut. Le
  daemon rappelle la conséquence au démarrage quand elle n'est pas vide. La
  liste est **globale**, pas par projet comme le voulait le plan (§5) : une liste
  par projet demande un endroit où la ranger et une interface pour l'éditer
  avec l'avertissement — c'est l'étape 7.
- **La boucle transmet l'annulation et l'échéance aux outils**
  (`ToolContext.signal`, `ToolContext.deadline`). Jusqu'ici, annuler une tâche
  ne coupait pas un `http_fetch` en cours ; une commande de dix minutes, elle,
  aurait fait durer la tâche au-delà de son délai.

L'approbation montre la commande exacte **dans le texte de l'opération** ; son
empreinte, elle, ne lie pas encore la décision à cet argv : c'est l'étape 4.

> ⚠️ **Rectifié à l'étape 4.** Le paragraphe ci-dessus, la leçon n° 8 plus bas,
> le README des outils, `CLAUDE.md` et le message du commit `d2a646d`
> affirmaient que le binaire était résolu **avant** la demande. C'était faux :
> il l'était dans `run()`, donc **après** l'approbation, et l'humain lisait
> `npm`, pas `/opt/homebrew/bin/npm`. Le texte est conservé tel quel ; le récit
> de l'erreur est au § « Étape 4 ».

### Ce qui le prouve

`tests/unit/exec.test.ts` — 15 tests, plus un de boucle : une commande refusée
par l'humain ne tourne pas (un marqueur hors du worktree reste absent), et
l'opération soumise montre l'argv exact. 234 tests unitaires en tout.

L'invariant central est vérifié **directement** : la commande lance un
petit-enfant qui dort une minute, imprime son pid, et le test demande au
système si ce pid vit encore — après une sortie normale, après le délai, après
l'annulation.

**Contre-épreuve faite**, garantie par garantie : sans nettoyage à la sortie,
sans groupe propre, avec un shell, avec l'environnement hérité, sans plafond par
l'échéance, avec une politique toujours ouverte — chacune fait échouer un à
huit tests. Une mutation n'a **rien** fait échouer au premier essai, et c'est
instructif : « accepter les entrées relatives du `PATH` » résolvait `.` par
rapport au dossier du **daemon**, où l'agent n'écrit pas — ce n'était pas la
régression dangereuse. La dangereuse, c'est de laisser le **système** résoudre
la commande : il prend alors `.` dans le dossier du fils, le worktree. Rejouée
ainsi, la mutation est prise par le test du piège.

### Ce que l'écriture a appris

**8. Ce qu'on approuve doit être ce qui tourne.** Approuver `npm test` ne dit
pas quel `npm` : celui du système, ou un `npm` exécutable que l'agent a écrit
dans le worktree et qu'un `.` du `PATH` ferait trouver d'abord. Le harness
résout donc le binaire **avant** de demander, ignore les entrées relatives du
`PATH`, et lance le chemin absolu qu'il a montré.

**9. Une commande finie n'est pas une commande sans suite.** `node` qui lance un
fils détaché, puis sort, rend la main — et laisse un processus vivant, qui tient
les tubes de sortie ouverts. Sans le nettoyage du groupe à la sortie, la tâche
aurait attendu une minute de plus ; avec un serveur de développement, pour
toujours.

---

## Étape 4 — l'opération exacte

### Ce qui existe

- **`Tool.prepare`**, facultatif : un outil fige son opération **avant** toute
  demande d'approbation, et `run` reçoit ce qui a été figé. Pour `exec` :
  dossier absolu, programme résolu, identité du binaire (périphérique, inœud,
  taille, date). Avant de lancer, `run` revérifie cette identité et ce dossier ;
  si l'un a changé pendant l'attente — jusqu'à dix minutes —, rien ne tourne.
- **La boucle prépare, puis demande.** Un échec de préparation — programme
  introuvable — revient au modèle sans solliciter personne. La durée journalisée
  d'un appel exclut désormais l'attente humaine.
- **`operation_detail`** sur chaque approbation (migration 5, `operation_json`),
  et **une empreinte tirée de lui**, en JSON canonique (`operationHash`), au
  lieu du texte affiché. Le détail est expurgé, à toute profondeur, avant d'être
  persisté : un agent peut glisser une clé dans un argument.
- **Le dashboard montre l'opération telle quelle** : pour une commande, le
  programme, puis **chaque argument sur sa ligne**, encadré — `a;b` et `a ; b`
  ne se lisent plus pareil. Tout autre outil est montré en JSON, tel qu'haché.
- **`PROTOCOL_VERSION` 6.**

Ce que l'humain lit désormais, pour une commande :

```text
exec — exécuter /opt/homebrew/bin/npm test -- --grep 'a b' dans /Users/…/worktrees/app-1a2b3c4d/0b9f3c2e/packages/api (délai 120 s)
```

### Ce qui le prouve

Neuf tests de plus, 243 en tout. Les décisifs : un script préparé puis réécrit
pendant l'« attente » n'est **pas** lancé (un marqueur reste absent) ; la
demande soumise par la boucle porte un programme **absolu** ; un programme
introuvable ne déclenche **aucune** demande ; une clé passée en argument
n'apparaît pas dans le détail persisté ; l'empreinte distingue `["a;b"]` de
`["a", ";", "b"]` et ignore l'ordre des clés.

**Contre-épreuve faite** : `run` qui re-prépare au lieu d'exécuter le préparé,
identité du binaire non revérifiée, boucle qui ne prépare pas, détail non
expurgé — chacune fait échouer un à trois tests.

**Le gérant de tâches est couvert de bout en bout** : le scénario R5 de
`test:restart` relit, sur un vrai daemon, la demande en attente et exige que
son empreinte se recalcule depuis son détail. Contre-épreuve faite — un gérant
qui hache le texte affiché fait échouer R5. Toutes les suites gratuites passent,
navigateur compris (le panneau d'approbation a changé).

### Ce que l'écriture a appris

**10. Le test verrouillait le défaut.** À l'étape 3, la résolution du binaire
« avant la demande » a été écrite dans la documentation, l'en-tête du module et
le message de commit — sans être constatée. Le code résolvait dans `run()`. Et
le test de boucle de l'étape 3, censé prouver que l'humain voyait la commande
exacte, vérifiait `exec — exécuter node -e …` : **le nom nu**, c'est-à-dire
précisément le défaut. Il passait parce qu'il décrivait ce que le code faisait,
pas ce que la documentation promettait. L'erreur a été trouvée en relisant le
chemin d'approbation de bout en bout pour l'étape 4, pas par un test.

La leçon rejoint celle des dettes de la Slice 2, avec une nuance de plus :
*une phrase de documentation est une affirmation, et une affirmation sans test
qui la contredirait si elle était fausse n'est pas vérifiée — même quand un test
porte sur le même sujet.* Le test réécrit exige un chemin **absolu**.

**11. L'attente humaine est une fenêtre.** Entre la demande et la décision, il
peut s'écouler dix minutes. Ce qui a été montré à l'humain doit être ce qui
tourne, et le monde peut changer entre les deux : `brew upgrade`, un script du
worktree réécrit. D'où la séparation `prepare` / `run`, et la revérification
de l'identité du binaire juste avant `spawn` — la même discipline que
l'ouverture d'un fichier (« revérifier à l'ouverture, pas seulement avant »),
appliquée au temps humain.

---

## Étape 5 — le profil `developer`

### Ce qui existe

- **Le profil `developer`** (`packages/daemon/src/agents.ts`), troisième des
  profils livrés : lecture, écriture, `git_diff` et `exec` — **pas de web**
  (PLAN §4). Désactivé sans fournisseur, comme le Researcher. Limites par
  défaut plus larges, et justifiées : 30 étapes, 1 $, 30 minutes (les
  approbations comptent), 8 192 jetons de sortie (le contenu d'un `write_file`
  se paie en sortie).
- **Le même moteur, deux instances.** `AgentEngine` reçoit son type de profil ;
  la boucle n'a pas changé, comme la Slice 2 l'avait prévu.
- **En `preparing`**, le worktree est créé (`inspectRepository`,
  `createWorktree`) et enregistré avec son `workspace.created`. La racine des
  outils devient le worktree plus le sous-dossier délégué ; l'écriture et
  `exec` y sont ouverts. Un dossier qui n'est pas un dépôt Git fait échouer la
  tâche avec une phrase qui dit quoi faire.
- **La consigne parle du worktree** : sa branche, son commit de départ, le fait
  que les chemins absolus cités par Claude se lisent en relatif, que rien
  n'atteint le dépôt sans merge humain — et, s'il y a lieu, que le travail non
  commité de l'utilisateur **manque**.
- **À la fin**, le harness commite — **seulement si la tâche a abouti** — puis
  décrit le worktree dans le résultat (`result.workspace` : branche, commit,
  fichiers, lignes, `base_dirty`). Un commit qui échoue fait échouer la tâche,
  en disant où est resté le travail. Le worktree passe en `kept` **dans tous les
  cas** ; au redémarrage, ceux des tâches interrompues aussi.
- **Ce que Claude reçoit** : le résultat porte `workspace` et un `merge_note` —
  le harness ne merge jamais, voici la branche, voici `git diff` pour la lire,
  ne merge que si l'utilisateur le demande. La note renvoie à Git, **pas au
  dashboard**, dont l'onglet Diff n'existe pas encore.
- **`PROTOCOL_VERSION` 7.**

### Ce qui le prouve

**`npm run test:developer`**, une suite nouvelle, inscrite dans `npm test` : un
vrai daemon, de vrais dépôts Git, et un **faux fournisseur compatible OpenAI**
qui joue, tour après tour, les appels d'outils d'un scénario. Six scénarios,
chacun vérifié par son effet sur le disque :

| # | Ce qui est vérifié |
|---|---|
| V1 | Le fichier est sur la branche, à l'identité de l'agent ; **le dépôt de l'utilisateur est intact** (`status`, `HEAD`, aucun fichier) ; le worktree est conservé sous `MIDGAARD_HOME` |
| V2 | La commande attend l'humain, montrée avec le programme **absolu** et l'argv exact ; approuvée, elle tourne **dans le worktree**, et son effet est commité |
| V3 | Une tâche qui échoue laisse sa branche **au commit de départ**, et son travail partiel lisible dans le worktree |
| V4 | Le travail non commité de l'utilisateur est compté, absent du worktree, et une tâche sans changement ne fait pas de commit vide |
| V5 | Un dossier hors dépôt Git échoue en disant pourquoi |
| V6 | Un `SIGKILL` pendant une approbation : la tâche devient `interrupted`, le worktree `kept` (« daemon redémarré »), le fichier en vol est là |

Plus trois tests unitaires de la consigne (246 en tout). **Contre-épreuve
faite** : racine non déplacée sur le worktree (quatre scénarios échouent —
l'agent écrivait alors dans le dépôt de l'« utilisateur »), commit même sur
échec, worktrees non conservés au redémarrage — chacune est prise.

Le premier passage de la suite a échoué six fois sur six, et c'était le test :
il exigeait le code `200` d'une création qui répond `201`.

### Ce que l'écriture a appris

**12. La branche est un résultat ; elle ne doit pas en avoir l'air quand elle
n'en est pas un.** Commiter à la fin de toute tâche, aboutie ou non, aurait
laissé sur `midgaard/…` le travail à moitié fait d'un agent coupé par son
budget — et Claude, ou l'utilisateur, l'aurait mergé en croyant merger une
réponse. Le commit est donc lié à `submit_result`, comme la fin de la tâche.

**13. Claude parle en chemins absolus du dépôt d'origine.** Son contexte cite
`/Users/…/projet/src/app.ts` ; l'agent travaille dans `~/.midgaard/worktrees/…`.
Sans la phrase de la consigne qui le dit, chaque lecture serait refusée « hors
du workspace », et chaque refus coûterait une étape. On a préféré la consigne à
une traduction automatique des chemins dans les outils : la traduction aurait
ajouté une surface à la vérification de chemin, qui est la frontière.

**14. Le daemon importait quatre paquets sans les déclarer.** `agent-runtime`,
`providers`, `secrets` et `tools` étaient résolus grâce aux liens du monorepo,
absents de son `package.json` comme de ses références de compilation. Rien ne
le voyait en développement ; la distribution npm de la Slice 4 aurait cassé.
Déclarés, avec `workspace`.

---

## Étape 6 — le diff, dans le dashboard

### Ce qui existe

- **`GET /api/tasks/:id/workspace`** : le worktree et son diff, **calculé à la
  demande** contre le commit de départ, jamais mis en cache — on le regarde
  surtout pendant que l'agent travaille, et un diff figé serait faux sans le
  dire. Quand il ne peut pas l'être (tâche sans worktree, worktree retiré ou
  supprimé à la main), `unavailable` dit pourquoi et rappelle la commande Git
  qui retrouve le travail sur la branche. Le service vit dans
  `packages/daemon/src/workspaces.ts`, pour que la CLI le reprenne à l'étape 7.
- **La carte « Fichiers et diff »** de l'inspecteur de tâche : branche, commit
  de départ, worktree et son état ; l'avertissement quand le travail non
  commité de l'utilisateur manque ; la liste des fichiers avec leur nature et
  leurs lignes ; le patch **de chaque fichier, déplié au clic**, coloré ligne à
  ligne et rendu comme du texte — il vient de fichiers écrits par un agent, rien
  n'en est interprété ; la mention d'un patch tronqué ; la commande
  `git merge`, pour l'humain qui décide. La carte se recharge sur les seuls
  événements d'outil et de worktree, pas à chaque mise à jour de consommation.
  Le plan parlait d'un « onglet » ; l'inspecteur est une colonne de cartes, et
  c'en est une de plus.
- **La note de merge renvoie au dashboard** — lien profond `#/tasks/<id>` —
  **seulement si le daemon l'annonce servi**. La commande Git reste donnée dans
  les deux cas.

Pas de changement de protocole : la route est un ajout, que rien d'ancien
n'appelle.

### Ce qui le prouve

- **D8** (`test:ui`) : une tâche Developer jouée par le faux fournisseur, puis
  dans un vrai navigateur la carte, la branche, le fichier listé, le patch
  déplié au clic, la commande de merge. Contre-épreuve faite : un découpage du
  patch qui ne rattache plus rien à son fichier fait échouer D8.
- **V7** (`test:developer`) : la route rend le diff, une tâche sans worktree le
  dit, et le résultat lu **par le vrai client MCP** porte la branche, la note de
  merge, et le lien du dashboard **exactement quand** celui-ci est servi.
- **`dashboard-patch.test.ts`** : le découpage du patch, sur un **vrai** patch
  produit par `diffWorktree`.

### Ce que l'écriture a appris

**15. Git termine par une tabulation l'en-tête d'un chemin qui contient une
espace.** Les lignes `--- a/dossier avec espace/a b.ts` et `+++ b/…` portent une
tabulation finale, pour lever l'ambiguïté du chemin. Le découpage du patch la
gardait dans la clé : le fichier `a b.ts` devenait `a b.ts\t`, et le dashboard
aurait affiché « patch absent » pour un fichier bel et bien modifié. Rien dans
la documentation lue ne le laissait prévoir ; c'est le test sur un patch réel
qui l'a montré au premier passage. D8 prend la même régression dans le
navigateur.

---

## Étape 7 — `harness workspaces`, `harness exec`, `doctor`

### Ce qui existe

- **`harness workspaces`** liste les worktrees avec leur état **relu sur le
  disque** — propre, travail non commité, dossier absent — et les **dossiers
  orphelins** sous `~/.midgaard/worktrees`, ceux qu'aucune ligne ne référence
  (reste d'un crash entre la création et l'enregistrement). Les orphelins sont
  montrés, **jamais retirés d'office** : rien ne dit à qui ils sont.
- **`harness workspaces remove <branche|id> [--force]`** et **`clean [--force]`**.
  Le retrait passe par le daemon, qui l'écrit avec son `workspace.removed`.
  Trois refus : une tâche encore active (on ne retire pas un worktree sous un
  agent), un worktree sale sans `--force` (ce travail, la branche ne le
  contient pas), et tout chemin hors de `worktreesDir` (étape 1). La branche
  reste **toujours**.
- **La liste blanche `exec` par dépôt**, promise à l'étape 3 : migration 6,
  table `exec_allow`, rangée sous la racine **canonique** du dépôt — celle que
  le moteur consultera, sans quoi une entrée enregistrée depuis un sous-dossier
  ne serait jamais retrouvée. Le moteur la lit **au départ** de la tâche et
  l'ajoute à `MIDGAARD_EXEC_ALLOW` : un ajout en cours de tâche vaut pour la
  suivante, une autorisation ne s'élargit pas en route.
- **`harness exec [list|allow|revoke]`**. `allow` **dit** ce que la liste
  laisse passer — « si cette commande exécute le code du projet, elle exécute
  ce que l'agent a écrit » — puis demande confirmation ; **sans terminal, il
  refuse** sauf `--yes`. Les options viennent avant la commande, pour que
  `npx tsc --noEmit` garde son `--noEmit`. Le daemon journalise chaque ajout.
- **`doctor`** vérifie Git (2.17 au moins, pour `git worktree remove` ; un
  avertissement, pas un échec — le Researcher s'en passe), compte les worktrees
  et rappelle comment les nettoyer, et **avertit** dès qu'une commande passe
  sans approbation.
- Routes `GET /api/workspaces`, `POST /api/workspaces/:id/remove`,
  `GET|POST /api/exec-allow`, `POST /api/exec-allow/remove`. Des ajouts : pas de
  changement de protocole.

### Ce qui le prouve

Trois scénarios de plus dans `test:developer`, dix en tout :

| # | Ce qui est vérifié |
|---|---|
| V8 | Un worktree de tâche active n'est pas retiré, même forcé ; un sale est refusé sans `--force`, retiré avec, **sa branche restant** et `workspace.removed` au journal ; un propre part sans force ; un orphelin est listé et **laissé** |
| V9 | L'argv en liste blanche tourne sans demande ; **le même avec un argument de plus** attend l'humain ; un dossier hors dépôt est refusé |
| V10 | La **vraie CLI**, entrée standard fermée : `exec allow` sans `--yes` refuse et n'ajoute rien ; `--yes`, `list`, `revoke`, `remove` ; `clean` retire les propres et **laisse le seul worktree sale** en disant pourquoi |

Et neuf tests unitaires (255 en tout) : lecture des arguments de `exec`,
contrôles de `doctor`, liste blanche en base.

**Contre-épreuve faite.** Retrait d'un worktree de tâche active, moteur qui
ignore la liste du dépôt, ajout sans confirmation hors terminal : chacune est
prise. Une quatrième ne l'est **pas**, et c'est la bonne nouvelle de l'étape :
retirer de `clean` le filtre des worktrees sales n'en retire aucun — la CLI
demande alors le retrait sans `--force`, et c'est le daemon, par
`git worktree remove`, qui refuse. Le filtre de la CLI n'est qu'une politesse
qui épargne un appel voué à l'échec ; la garde est côté daemon, et V8 l'éprouve
directement.

### Ce que l'écriture a appris

**16. Une liste blanche rangée sous le mauvais chemin a l'air de marcher.**
L'utilisateur lance `harness exec allow` depuis `packages/api` ; le moteur
consulte la liste du dépôt sous sa racine. Ranger l'entrée sous le dossier
courant l'aurait rendue introuvable, sans rien dire — la commande aurait
continué à demander une approbation, et l'on aurait cru la liste en panne. Elle
est donc toujours rangée sous la racine canonique, et V9 l'ajoute exprès depuis
un sous-dossier.

**17. `doctor` écrit dans la base qu'il diagnostique.** Il l'ouvre par
`HarnessStore.open`, qui applique les migrations. En le lançant pendant cette
étape sur l'installation réelle, la base de l'auteur est passée du schéma 3 au
schéma 6 sous un daemon de la Slice 2 encore en marche. Sans dommage — les
migrations n'ajoutent que des tables et des colonnes facultatives, et le
prochain appel MCP remplace ce daemon —, mais un diagnostic ne devrait rien
écrire. Le comportement date de la Slice 1 ; il est noté au § « Ce qui reste
ouvert ».

---

## Étape 8 — l'essai réel

*Le protocole ci-dessous a été écrit avant l'essai, relevé du solde compris,
mais commité seulement avec ses résultats : l'historique Git ne peut donc pas
attester l'ordre, ce document seul le dit. Le protocole n'a pas été retouché
après coup ; seul le titre de la section l'a été.*

Le livrable du plan ne se prouve qu'en vraie session : « un Developer implémente
un changement dans un worktree isolé, une commande sensible suspend la tâche
jusqu'à décision humaine, le diff est consultable, Claude récupère le
résultat ». Tout ce qui précède a été éprouvé contre un **faux** fournisseur.
Ce protocole est écrit **avant** l'essai, pour que ses résultats ne puissent
pas être relus après coup à l'avantage du code.

### Le terrain

`~/Documents/midgaard-demo` : un serveur HTTP sans dépendance (`src/app.js`,
`handle(req, res)` ; `GET /` et 404), deux tests `node --test` qui démarrent un
vrai serveur sur un port libre, un commit, un `.mcp.json` déclaré par
`harness init` et **ignoré par Git** — sans quoi il compterait comme travail
non commité, et l'agent recevrait un avertissement faux. Pas Midgaard lui-même :
un essai qui modifierait le code qu'il éprouve ne prouverait rien de net.

### Le déroulé

1. **Fermer ou laisser au repos** les sessions Claude Code ouvertes sur
   Midgaard : leur serveur MCP date d'avant la Slice 3 (protocole 4), et deux
   serveurs de protocoles différents remplacent le daemon l'un de l'autre à
   chaque appel.
2. Ouvrir une **nouvelle** session Claude Code sur `~/Documents/midgaard-demo`,
   accepter le serveur `midgaard`.
3. Lui demander, mot pour mot :

   > Utilise le harness midgaard. Liste les agents, puis délègue au `developer` :
   > « Ajoute une route GET /health qui répond 200 avec {"status":"ok"}, et un
   > test pour elle dans test/app.test.js, dans le style des tests existants.
   > Vérifie avec npm test. » Passe-lui en `context` ce que tu sais du dépôt,
   > limite le budget à 0,10 $, et attends le résultat en suivant `next_action`.
   > Quand une approbation est demandée, transmets-moi la consigne telle quelle.

4. Quand la commande `npm test` demande l'approbation : la lire dans le
   dashboard (`http://127.0.0.1:7777`), puis approuver — dashboard ou
   `npm run harness -- approve`.
5. À la fin : lire la carte « Fichiers et diff », puis **décider** du merge,
   soi-même, depuis `midgaard-demo`.

### Ce qui sera relevé

| # | Attendu | Ce qui le constate |
|---|---|---|
| A1 | Le profil `developer` est annoncé **disponible** | `harness_list_agents` dans la session |
| A2 | Un worktree sous `~/.midgaard/worktrees`, branche `midgaard/…`, **sans** avertissement de travail non commité | timeline, carte du dashboard |
| A3 | `npm test` **suspend** la tâche ; la demande montre le programme **résolu** (`/opt/homebrew/bin/npm`), l'argv et le dossier du worktree | panneau d'approbation, message relayé par Claude |
| A4 | Approuvée, la commande tourne **dans le worktree** et passe | appel d'outil `exec`, code 0 |
| A5 | Tâche `completed`, commit sur la branche à l'identité de l'agent ; `src/app.js` et `test/app.test.js` modifiés | `result.workspace`, `git log` sur la branche |
| A6 | Le dépôt `midgaard-demo` **intact** tant qu'on n'a pas mergé | `git status`, `HEAD` |
| A7 | Claude relaie branche et note de merge, et **ne merge pas** de lui-même | le fil de la session |
| A8 | Coût affiché **avec sa provenance**, et égal à ce que Venice facture | dashboard, solde Venice avant et après |
| A9 | Après merge humain, `npm test` passe sur `main` | terminal |

Ce qui compterait comme un **échec du produit**, et non de l'essai : une
écriture hors du worktree, une commande lancée sans approbation, une demande
qui montre autre chose que ce qui tourne, une branche commitée sur une tâche
qui n'a pas abouti, un merge fait par Claude sans demande, un coût sans
provenance. Ce qui compterait comme un **échec de l'essai** et se rejouerait :
un modèle qui ne conclut pas (`submit_result` jamais appelé), un budget trop
bas pour la tâche.

### Relevé avant l'essai

- Solde Venice : **4,52969547 $**, relevé le 2026-10-30 à 11:02:46 UTC par
  `GET /api_keys/rate_limits`, la clé lue dans le trousseau sans être affichée.
- `midgaard-demo` : commit `dea8375`, arbre propre, `npm test` 2/2.
- Fournisseur `venice`, modèle `deepseek-v4-flash-0731`, joignable au dernier test.

### Résultats — 2026-10-30, session « Health check endpoint et tests »

**Livrable atteint.** Le Developer a implémenté le changement dans un worktree
isolé, la commande a suspendu la tâche jusqu'à la décision humaine, le diff
était consultable, et Claude a récupéré le résultat. Huit critères sur neuf
sont constatés ; le neuvième attend une décision qui appartient à l'auteur, et
c'est voulu.

| # | Verdict | Constat |
|---|---|---|
| A1 | ✅ | `developer` listé disponible ; la tâche a démarré sur `venice` / `deepseek-v4-flash-0731` |
| A2 | ✅ | `midgaard/ceeac478` depuis `dea8375` (`main`), `base_dirty` 0, sous `~/.midgaard/worktrees/midgaard-demo-56375bb0/` |
| A3 | ✅ | Pause sur `exec — exécuter /opt/homebrew/bin/npm test dans /Users/…/worktrees/midgaard-demo-56375bb0/ceeac478 (délai 120 s)` ; le détail porte le programme résolu, son empreinte, l'argv et le dossier |
| A4 | ✅ | Approuvée depuis le dashboard 4,1 s après la demande ; `npm test → code 0 en 0,5 s`, dans le worktree |
| A5 | ✅ | `completed` ; commit `0e0fced` à `Midgaard developer <developer@midgaard.invalid>`, non signé ; `src/app.js` +3, `test/app.test.js` +6. Relancé à la main dans le worktree : **3/3** |
| A6 | ✅ | `midgaard-demo` : `main` toujours à `dea8375`, arbre propre |
| A7 | ✅ | Claude a relayé branche et commit, en précisant que le dépôt et `main` n'avaient pas changé ; il n'a pas mergé |
| A8 | ✅ | Coût affiché **0,0022972 $, « facturé par le fournisseur »**. Solde Venice : 4,52969547 $ avant, 4,52739827 $ après — **écart de 0,0022972 $, exact au microdollar** ; une seule tâche entre les deux relevés |
| A9 | ⏳ | Merge non fait au moment du relevé : c'est la décision de l'auteur, et le harness ne la prend pas |

**Le déroulé, de la base.** Vingt secondes de bout en bout, dont quatre
d'attente humaine. Quatre appels modèle, 19 804 jetons d'entrée, 942 de sortie :

```text
11:36:44.753  task.created
11:36:44.892  workspace.created     midgaard/ceeac478 depuis dea8375 (main)
11:36:53.130  edit_file             src/app.js        (+3)
11:36:53.134  edit_file             test/app.test.js  (+6)
11:36:54.906  approval.requested    /opt/homebrew/bin/npm test
11:36:59.022  approval.resolved     approuvée, dashboard
11:36:59.485  exec                  code 0 en 0,5 s
11:37:00.722  git_diff              2 fichiers, +9 −0
11:37:04.413  submit_result         confiance « high »
11:37:04.579  task.completed        commit 0e0fced
11:37:04.580  workspace.kept
```

### Ce que l'essai apprend

**Le contexte a fait le travail qu'on attendait de lui.** L'agent a modifié les
deux fichiers **dès son premier appel**, sans les lire : ce que Claude lui avait
passé en `context` suffisait à écrire des `old_string` exacts. C'est la promesse
économique du plan (§4) — l'agent ne refait pas l'exploration — tenue dans le
cas le plus favorable. Deux réserves honnêtes : le dépôt tient en trois
fichiers, et un `old_string` faux aurait coûté un refus et une étape, pas une
erreur silencieuse.

**L'estimation locale reste haute de 23 % quand le modèle sert du cache.**
0,00281944 $ estimés contre 0,0022972 $ facturés, pour 5 120 jetons servis du
cache au dernier appel : c'est la limite connue de la Slice 2, constatée de
nouveau, sans conséquence tant que le fournisseur annonce son propre coût.

**Le piège de version ne s'est pas produit.** Une session ouverte à 11:04 sur
Midgaard même a listé les agents sans rien déléguer ; son serveur MCP, chargé
depuis les sources, était déjà du protocole 7 et a remplacé le daemon de la
Slice 2. La base ne contient qu'une tâche Developer.

**Ce que l'essai ne pouvait pas dire.** Un seul passage, un dépôt minuscule, un
modèle, une plateforme. Ni un refus d'approbation, ni un budget atteint, ni un
redémarrage pendant une tâche réelle n'ont été joués ici ; ils le sont contre
le faux fournisseur (`test:developer`, V3 et V6), pas contre un vrai modèle.

---

## La CI multi-plateforme — l'engagement de l'étape 1, tenu

L'étape 1 s'était engagée à ne pas dire la slice terminée tant que `workspace`,
l'écriture et `exec` n'auraient tourné que sur le Mac qui les a écrits. Nouveau
workflow `.github/workflows/worktrees.yml` : `npm run test:worktrees` (les
suites `workspace`, `write-tools`, `exec` et `dashboard-patch`) sur macOS, Linux
et Windows, sans `fail-fast`.

| Passage | Commit | macOS | Linux | Windows |
|---|---|---|---|---|
| `41050259725` | `0d01ddb` | 60/60 | 60/60 | **56/60**, 2 sauts annoncés |
| `41050506668` | `47b902c` | 60/60 | 60/60 | **58/60**, 2 sauts annoncés, 0 échec |

Git 2.56 sur les trois postes. Deux passages, là où le coffre en avait demandé
cinq — en partie parce qu'un défaut Windows avait été corrigé **avant** de
pousser, à la relecture.

Les deux sauts sont les cas qui lancent un script `sh` comme programme :
Windows n'exécute pas un fichier par son shebang. Ils le disent dans la sortie
(`# Windows n'exécute pas un script sh comme programme`) ; le refus d'un
programme modifié depuis l'approbation, qui a lieu avant tout lancement, reste
vérifié partout.

### Ce que la CI a appris

**18. Sous Windows, le nom nu d'une commande est un piège.** `resolveCommand`
essayait d'abord `npm`, puis `npm.EXE`, `npm.CMD`… Or le dossier de Node
contient justement un `npm` sans extension — un script `sh` pour les shells
POSIX — à côté de `npm.cmd`. Il aurait été « trouvé », puis aurait échoué au
lancement. Windows n'exécute jamais un fichier sans extension : seules les
extensions de `PATHEXT` comptent désormais (`candidateNames`, testé pour les
trois plateformes depuis n'importe laquelle). Trouvé à la relecture avant de
pousser, pas par la CI — ce qui ne dispense pas de l'avoir fait tourner.

**19. Les deux échecs Windows étaient des hypothèses POSIX des tests.**
`/bin/echo` n'existe pas sous Windows : le refus avait lieu, mais pour « chemin
introuvable » au lieu de « hors du worktree ». Et Git pour Windows convertit en
CRLF au checkout (`core.autocrlf`) : le worktree contient les mêmes octets que
le dépôt de l'utilisateur, ce qui est juste. Aucune faille dans les deux cas ;
les tests visent désormais ce qu'ils prétendent vérifier.

**20. La conversion CRLF a une conséquence réelle, que les tests ne couvrent
pas.** Dans un dépôt Windows en CRLF, `edit_file` cherche un `old_string`
**octet pour octet** ; un modèle qui écrit `\n` ne le trouvera pas, et le
dira par un refus (« old_string not found »), pas par une erreur silencieuse.
Noté au § « Ce qui reste ouvert ».

**21. Une limite annoncée s'est révélée plus étroite qu'écrit.** Le README des
outils annonçait que, sous Windows, `taskkill /T` ne retrouve plus les enfants
d'un parent déjà sorti. Le test « aucun petit-enfant ne survit à une sortie
normale » **passe pourtant sous Windows**. L'explication la plus probable :
libuv place les processus qu'il lance dans un *Job Object* qui les tue avec
leur parent, et le petit-enfant du test est lancé par Node. Ce n'est **pas
constaté** pour un programme qui ne passe pas par libuv ; la limite reste donc
annoncée, avec cette nuance.

---

## Écarts au plan

1. **Pas de table `projects`, pas de table `artifacts`** (PLAN §6). Un projet est
   le dépôt d'où la tâche est déléguée, déjà porté par `tasks.project_dir` et
   `workspaces.repo_dir`. Le diff d'un worktree se calcule à la demande contre
   son commit de départ : le figer en artefact ferait une seconde vérité, juste
   au moment de l'écrire. L'événement `artifact.created` n'est donc pas créé.
2. **`exec` en approbation par défaut**, et non en liste blanche — voir les
   décisions plus haut.
3. ~~**Liste blanche `exec` globale**, pas encore par projet.~~ Réglé à
   l'étape 7 : liste par dépôt, à laquelle la globale s'ajoute.
4. **Pas d'outil `git` généraliste** (PLAN §4 : « `git` dans le worktree »),
   seulement `git_diff` — voir l'étape 2.

---

## Ce qui reste ouvert

- ~~**`doctor` migre la base qu'il diagnostique** (leçon n° 17).~~ **Réglé**
  en Slice 4, étape 1 : `doctor` et `status` ouvrent la base en lecture seule
  ([SLICE4.md](SLICE4.md)).
- ~~**Windows et Linux** : jamais tourné.~~ **Réglé** : `worktrees.yml`, trois
  postes au vert (§ « La CI multi-plateforme »). Restent hors CI, sous Windows
  et Linux : le daemon de bout en bout (`test:developer`), le dashboard, et la
  CLI.
- ~~**`edit_file` dans un dépôt CRLF** (leçon n° 20).~~ **Réglé** en Slice 4,
  étape 2 : la recherche tolère les fins de ligne ([SLICE4.md](SLICE4.md)).
- **Des sous-processus lancés hors de libuv, sous Windows** (leçon n° 21) : leur
  nettoyage après la sortie du parent n'est pas constaté.
- ~~**Les sous-modules** ne sont pas initialisés dans un worktree, sans que rien
  le dise.~~ **Réglé** en Slice 4, étape 2 : nommés partout, et l'écriture y
  est refusée — ce qui s'y écrivait était perdu en silence.
- **Les deux dettes Gemini** de la Slice 2 restent ouvertes, faute de clé.
