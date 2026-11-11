# `@midgaard/workspace`

Les worktrees Git des agents écrivants. Un agent Developer n'écrit **jamais**
dans le dépôt de l'utilisateur : il reçoit un worktree à lui, sur une branche à
lui (`midgaard/<tâche>`), partant du commit où se trouvait le dépôt au moment de
la délégation. Supprimer le worktree et la branche efface tout ; rien n'arrive
dans le dépôt de l'utilisateur sans un **merge humain** — le harness ne merge
jamais.

Le paquet ne connaît ni le daemon, ni la base, ni les agents : il reçoit des
chemins et rend des faits sur le disque. C'est le daemon qui les enregistre
dans la table `workspaces`, avec l'événement qui les raconte.

| Fonction | Rôle |
|---|---|
| `inspectRepository(dir)` | Racine canonique, sous-dossier délégué, HEAD, branche, nombre de chemins non commités |
| `createWorktree({ repo, worktreesDir, taskId })` | `git worktree add -b midgaard/<id> …` hors du dépôt ; nomme les sous-modules laissés vides |
| `listSubmodules(repoDir, commit)` | Sous-modules d'un commit : chemins de `.gitmodules` qui sont bien des liens `160000` dans l'arbre |
| `commitAll(path, message, identity)` | Commite tout le worktree, fichiers nouveaux compris, au nom de l'agent |
| `diffWorktree(path, baseCommit)` | Ce que l'agent a changé : commits, modifications **et fichiers nouveaux** |
| `worktreeState(path)` | Existe-t-il, est-il propre, sur quel commit |
| `removeWorktree({ repoDir, worktreePath, worktreesDir, force })` | Retire le dossier ; la branche reste |

## Ce que le paquet garantit

**Le dépôt de l'utilisateur n'est jamais modifié**, hors des métadonnées que
`git worktree` y range lui-même (`.git/worktrees/…`) et de la branche de la
tâche. Pas de checkout, pas de stash, pas de reset — vérifié par les tests, qui
comparent `git status` et `HEAD` avant et après.

**Le travail non commité de l'utilisateur n'est pas recopié.** Le worktree part
du dernier commit. Recopier le travail en cours le mêlerait à celui de l'agent,
dans un diff où plus personne ne distingue les deux. En échange, l'écart est
**annoncé** : `inspectRepository` compte les chemins non commités, la table les
garde (`base_dirty`), et la timeline dit « 3 fichier(s) non commité(s) absent(s)
du worktree ». Un agent à qui l'on décrit du code non commité ne le trouvera
pas, et il faut que quelqu'un le sache.

**Les sous-modules absents sont nommés.** `git worktree add` les laisse vides,
et c'est voulu : les initialiser irait chercher sur le réseau des dépôts que
`.gitmodules` désigne — un fichier du projet. Mais ce qu'un agent écrit dans un
sous-module vide est **ignoré sans un mot** par `git add -A` (code `0`, rien dans
`git status` : constaté, et verrouillé par un test qui échouera si Git change).
`createWorktree` rend donc `submodules` ; la table le garde (`submodules_json`,
migration 7), la consigne de l'agent, le résultat de la tâche et le dashboard
le disent, et les outils d'écriture refusent d'y écrire. Les chemins sont lus
dans `.gitmodules` (`git config --blob`, qui ne suit aucun `include`), puis
confirmés dans l'arbre du commit par un `ls-tree` limité à ces chemins : un
`.gitmodules` qui ment ou qui date ne fait rien annoncer de faux, et la sortie
reste bornée sur un gros dépôt.

**Rien n'est supprimé hors de `worktreesDir`.** Le chemin d'un worktree vient de
la base ; `removeWorktree` vérifie qu'il est *strictement* sous le dossier des
worktrees avant toute opération. Une ligne corrompue qui désignerait le dépôt
de l'utilisateur est refusée, même avec `force`.

**Le travail non commité d'un worktree n'est pas perdu sans le demander.** Sans
`force`, le retrait refuse un worktree sale : ce travail-là, la branche ne le
contient pas.

## Aucun programme désigné par l'arbre de travail ne s'exécute

C'est la propriété la plus importante du paquet, et la moins évidente. Dans un
worktree, **l'arbre de travail est écrit par l'agent**. Tout ce que `git` irait
y chercher pour l'exécuter devient une exécution arbitraire, sans approbation.

| Porte | Fermée par |
|---|---|
| Hooks rangés dans l'arbre (Husky : `core.hooksPath=.husky`) | `-c core.hooksPath=<périphérique nul>` sur **chaque** commande |
| Pilote de diff externe désigné par un `.gitattributes` | `--no-ext-diff --no-textconv` sur chaque diff |
| Signature par la clé de l'utilisateur (`commit.gpgsign`) | `--no-gpg-sign` : sa clé ne doit pas attester un code qu'il n'a pas écrit |
| `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` hérités du daemon | environnement reconstruit (`gitEnv`) |

**`--no-verify` ne suffit pas**, et c'est le piège : il ne saute que
`pre-commit` et `commit-msg`. `prepare-commit-msg` et `post-commit` tournent
toujours, et `git worktree add` lance `post-checkout`. Seul `core.hooksPath`
ferme toutes les portes d'un coup. Les tests le vérifient par l'effet — le hook
doit créer un fichier, et le fichier ne doit pas exister — et ils échouent bien
quand on retire la protection (contre-épreuve faite en écrivant le paquet).

Ce qui n'est **pas** neutralisé, délibérément : la configuration de
l'utilisateur. Ses filtres `clean`/`smudge` (Git LFS) restent appliqués — ils
sont définis dans **sa** configuration, hors de portée de l'agent, et les
ignorer casserait un dépôt LFS sans rien protéger.

## Le diff, et pourquoi un index temporaire

> **La copie de l'index garde la date de l'original.** Sans elle, un fichier
> réécrit à taille égale dans la seconde du checkout disparaissait du diff —
> la garde *racy git* de Git ne jouait plus. Détail dans l'en-tête de `diff.ts`
> et dans docs/SLICE4.md (étape 4).


`git diff <base>` ignore les fichiers non suivis. Or l'agent qui crée
`src/health.ts` produit précisément un fichier non suivi : un diff qui l'oublie
ment sur l'essentiel.

`git add -N` réglerait la question en modifiant l'index du worktree — calculer
un diff changerait alors ce que l'agent voit au `git status` suivant.
`diffWorktree` travaille donc sur une **copie** de l'index (`GIT_INDEX_FILE`) :
il y ajoute tout l'arbre de travail, compare au commit de départ, jette la
copie. Copier l'index plutôt que repartir de zéro garde ses informations de
`stat`, qui évitent de relire chaque fichier inchangé.

Le diff se calcule toujours contre `base_commit`, **jamais contre une branche** :
`main` a pu avancer depuis la délégation, et le diff mêlerait alors le travail
de l'agent à celui des autres.

Le patch est plafonné à 1 Mo et **dit** quand il est tronqué
(`patch_truncated`, `patch_bytes`) ; la liste des fichiers et les compteurs
restent complets.

## Identité des commits

`agentIdentity('developer')` rend `Midgaard developer <developer@midgaard.invalid>`.
Jamais l'identité de l'utilisateur : `git blame` doit dire dans six mois que ce
code vient d'un agent. Le domaine `.invalid` est réservé (RFC 2606) et ne peut
appartenir à personne.

## Ce que ce paquet ne fait pas

- **Il ne merge pas.** Décision de la Slice 3 : le merge est un acte humain.
- **Il ne nettoie rien de lui-même.** Les worktrees sont conservés jusqu'à un
  nettoyage demandé ; une minuterie ne doit pas faire disparaître un diff que
  personne n'a lu.
- **Il n'initialise pas les sous-modules** d'un worktree — il les nomme (voir
  plus haut). Un dépôt imbriqué sans `.gitmodules` n'est pas vu ; `git
  submodule` ne l'initialiserait pas non plus.
