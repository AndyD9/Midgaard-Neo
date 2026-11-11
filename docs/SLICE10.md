# Slice 10 — Spécialisation sécurité : pipeline à portes, vue terminal, débogueur confiné

**Date :** 2026-11-10 · **Objectif :** pousser Midgaard vers un **harness de
recherche de vulnérabilités** spécialisé — un **pipeline à étapes et à portes**
(`recon → hunt → validate → trace → report`) porté par des playbooks, une
**vue terminal** en temps réel (moins d'UI complète, plus de lignes et
d'information sur ce qui se passe, une *dialogue box* vers l'orchestrateur
conservée), et — pour le reverse — des **outils d'analyse en lecture seule**,
l'exécution dynamique restant **confinée à la seule VM Windows**.

**État : ouverte, étapes 1 à 6 faites.** Posée le 2026-11-10 à la demande de l'auteur,
après lecture de deux références qu'il a proposées :
[baby-naptime](https://github.com/faizann24/baby-naptime) (implémentation
ouverte de *Project Naptime* de Google — boucle d'agent avec `CodeBrowser`,
`Debugger` GDB, `ScriptRunner`, `Summarizer`, `Reporter`) et
[harness-kit](https://github.com/ZephrFish/harness-kit) (template pédagogique :
cinq étapes, chacune un `SKILL.md` + un prompt, plus `model-routing.yaml` et
`context-budgets.yaml`). **Elle s'ouvre après la Slice 9**, dont restent 5.4
(survie des processus d'une connexion coupée) et 5.5 (CI Windows réelle) : le
pipeline s'appuie sur la VM Windows, qui doit d'abord être éprouvée sur un vrai
Windows.

---

## Les décisions prises avec l'auteur (2026-11-10)

| Question | Réponse retenue |
|---|---|
| Où autoriser l'exécution dynamique inspirée de baby-naptime (GDB, lancement de la cible) ? | **VM Windows seulement.** L'invariant « aucun échantillon ne s'exécute, jamais » (Slice 9) reste entier ailleurs ; tout dynamique passe par `windows_run`, sous approbation, dans le dossier jetable de la VM. Le reverse hors VM reste statique et en lecture seule. |
| Par quoi commencer ? | **Cette doc de décisions d'abord** (`docs/SLICE10.md`), avant tout code. |

### Pourquoi ces deux références, et ce qu'on en prend vraiment

- **harness-kit donne la *forme*, pas la machinerie.** Son pipeline à cinq
  étapes correspond presque terme à terme à des briques déjà livrées :

  | harness-kit | Midgaard existant |
  |---|---|
  | une étape = un `SKILL.md` + un prompt | un **playbook** attaché à un profil (Slice 9) |
  | `validate` *adversarial* | la **revue** orchestrateur ⇄ Developer (`review`, `accept_result`, Slice 6) |
  | `hunt` concurrent, un agent par tâche | la **délégation parallèle** + `create_agent` (Slices 5, 8) |
  | `model-routing.yaml` | fournisseur + modèle par profil (`PATCH /api/agents/:id`) |
  | `context-budgets.yaml` | les **limites par profil** (`agents limits`) + le **Summarizer** (Slice 1) |

  Autrement dit, l'orchestration, les approbations, l'expurgation, l'encadrement
  `<untrusted_data>` et le suivi des coûts, Midgaard les a **en plus dur** que le
  template. Ce qui manque, ce n'est pas la mécanique, c'est **le savoir métier
  des étapes** et **la discipline des portes**. On ne réimporte donc aucune
  architecture : on écrit des playbooks et on ajoute une porte.

- **baby-naptime donne des *outils bas niveau*, mais une philosophie
  incompatible** (voir « Le point dur » ci-dessous). On en prend la structure
  de boucle et deux outils en version lecture seule (un navigateur de code, un
  rapporteur structuré) ; on en rejette l'exécution-et-exploitation, sauf à la
  confiner à la VM Windows.

## Le point dur tranché avant toute conception

baby-naptime **compile la cible sans mitigations** (`-fno-stack-protector -z
execstack -no-pie`), puis l'**exécute** sous GDB et **lance des exploits**.
C'est frontalement contraire à l'invariant central de la Slice 9 :

> *« Un échantillon ne s'exécute jamais, même approuvé. »* `exec` refuse **dans
> `prepare`**, sans demander à personne, une commande qui lance un échantillon,
> en lance une copie de même contenu, ou le passe à un chargeur, émulateur,
> shell ou interpréteur ; `pe-static.md` étend ce refus à l'émulation (FLOSS,
> Speakeasy, Qiling, Unicorn).

**On ne reprend donc pas la boucle de baby-naptime telle quelle.** La décision
de l'auteur (VM Windows seulement) tranche : toute analyse **dynamique** — un
débogueur qui exécute, un script qui fait tourner la cible — n'existe que par
`windows_run`, dans le dossier jetable `~/midgaard/tasks/<tâche>/work` de la VM,
chaque commande lue et approuvée par l'humain, le dossier effacé en fin de
tâche. Partout ailleurs, l'invariant « aucun échantillon exécuté » ne bouge
pas : `exec` continue de refuser dans `prepare`, et aucun échantillon n'est
copié dans un worktree.

Conséquence : le `Debugger` de baby-naptime ne devient **jamais** un outil du
Researcher ni d'un worktree. S'il voit le jour, c'est comme un **script
PowerShell/`gdb` sur la VM**, passé à `windows_run`, soumis aux mêmes règles
que toute commande Windows — et pas avant que la Slice 9 (5.4, 5.5) ait prouvé
la VM.

## Ce qui a été constaté avant de décider (2026-11-10)

Chaque point est lu dans le code ou la doc du dépôt, pas supposé.

1. **Les playbooks sont le véhicule exact du « savoir d'étape ».** Un playbook
   est un fichier Markdown de `playbooks/`, en anglais, attaché à un profil par
   l'humain seul (`PUT /api/agents/:id/playbooks`), relu au départ de chaque
   tâche, SHA-256 cité à la timeline, borné (Slice 9, étape 1). Les six
   existants (`sigma`, `yara`, `pe-static`, `powershell`, `windows-hardening`,
   `python`) montrent le ton : sourcé, « the one rule », pas d'identifiant de
   mémoire inventé. Les cinq étapes du pipeline **sont** cinq playbooks de plus.
2. **La « porte adversariale » existe déjà à moitié.** L'orchestrateur délègue
   une revue (`review`), le Developer propose (`submit_result`), l'orchestrateur
   accepte (`accept_result`) ; la branche ne bouge qu'à l'acceptation (Slice 6).
   Ce qui manque, c'est une **porte de traçage** : un finding non relié d'une
   entrée attaquant à son sink ne devrait pas franchir l'étape.
3. **Le flux temps réel est déjà intégralement diffusé.** `EventBus` écrit et
   diffuse dans la même transaction, `task_events.seq` est global et reprenable,
   la sortie `exec` est découpée **par ligne puis expurgée** et diffusée en
   direct (Slice 6, `agent-runtime/src/output.ts`), le dashboard a déjà un
   terminal xterm **qui ne laisse passer que les couleurs**
   (`apps/dashboard/src/lib/terminal.ts`). Une vue terminal ne demande **aucun**
   changement du daemon : elle consomme le même WebSocket.
4. **Le Summarizer et les limites par profil font déjà le travail de
   `context-budgets.yaml`.** Rien à importer ; au plus, une doc de réglage.
5. **Le point d'entrée du dashboard n'importe de `@midgaard/contracts` que des
   types** et charge `node:os`/`node:fs` : une nouvelle vue reste un module du
   paquet `apps/dashboard`, sans toucher aux contrats.

## Décisions de conception

### A. Les cinq étapes deviennent cinq playbooks

1. **Un playbook par étape**, dans `playbooks/`, en anglais, adapté au terrain
   de Midgaard (reverse/PE, détection, durcissement, Windows) plutôt qu'au web
   générique de harness-kit :
   - `recon.md` — cartographier la cible (sous-systèmes, points d'entrée,
     frontières de confiance, historique Git), produire une file de tâches ;
   - `hunt.md` — investiguer **une** hypothèse de vulnérabilité par tâche, en
     parallèle, sur des fichiers nommés ;
   - `validate.md` — relecteur **adversarial** : chercher pourquoi le finding
     est **faux**, pas le confirmer ;
   - `trace.md` — prouver qu'une entrée attaquant atteint le sink, référence de
     code à chaque pas ;
   - `report.md` — assembler ce qui a **franchi** le traçage ; ce qui échoue à
     `validate` ou `trace` ne passe pas.
2. Ils **ne nomment ni modèle ni client** (neutralité, Slice 5) : le routage de
   modèle de harness-kit (`recon`/`validate`/`trace` sur un modèle capable,
   `hunt`/`report` sur un modèle rapide) se **réalise par l'attache à des
   profils** différents, pas écrit dans le playbook.
3. Ils restent **statiques et en lecture seule** par construction : aucun ne
   demande d'exécuter la cible. `recon`/`hunt`/`validate`/`trace` tiennent dans
   un Researcher ; un besoin dynamique passe par un Developer à VM et
   `windows_run`.

### B. Une porte de traçage mécanique (`trace_confirmed`)

4. **Décidé le 2026-11-10 : la porte est un statut, pas une simple consigne.**
   Un finding non tracé jusqu'à une entrée attaquant ne doit pas pouvoir
   franchir l'étape, et on ne s'en remet pas au texte du playbook pour cela : un
   champ de tâche (`trace_confirmed`, migration + `PROTOCOL_VERSION`) rend la
   contrainte **mécanique** dès le départ. `validate.md`/`trace.md` décrivent le
   *comment* (ce qui compte comme entrée attaquant, la référence de code à
   chaque pas) ; le daemon impose le *franchissement* : seul un finding
   `trace_confirmed` entre dans l'étape `report`. C'est le pendant, côté
   qualité, de l'invariant « la fin d'une tâche est un acte, pas une
   interprétation » : un modèle qui écrit « c'est tracé » n'a pas tracé.

### C. Les outils bas niveau de baby-naptime, version lecture seule

5. **Décidé le 2026-11-10 : pas d'outil `CodeBrowser` neuf.** La navigation et
   l'extraction (gros arbre, gros binaire désassemblé) se font par **des
   préfixes `exec` bornés** sur des outils déjà présents — `rg`, `objdump`,
   `nm`, `strings` — via la liste blanche à préfixes de la Slice 9. On réutilise
   ainsi l'approbation et le rejugement au départ de tâche existants, sans créer
   d'outil ni de surface de sécurité. Si un vrai cas montre un besoin que ces
   préfixes ne couvrent pas (navigation structurée, extraction de segments avec
   contexte), on rouvrira la question d'un outil lecture seule dédié — jamais en
   écriture, règles de chemin existantes (`.git` jamais touché, `dev`/`ino`
   revérifiés à l'ouverture).
6. Un **`Reporter`** structuré (un finding sourcé → markdown/SARIF/JSON) peut
   être un outil de l'étape `report`, ou rester un simple playbook de format.
   À trancher à l'étape correspondante, pas maintenant.
7. Le **`Debugger`** n'est **pas** un outil : il n'existe, s'il existe, que
   comme script sur la VM Windows via `windows_run`.

### D. La vue terminal

8. **Décidé le 2026-11-10 : une nouvelle vue du dashboard, pas une TUI à part.**
   Elle devient le mode par défaut de l'observation : flux d'événements en
   lignes, sortie `exec` en direct, coûts et étapes, **une *dialogue box* vers
   l'orchestrateur** (le chat `POST /api/tasks/:id/messages` existe déjà,
   Slice 6). Elle **consomme le flux WebSocket existant** — même bundle, mêmes
   tests Playwright — et le daemon ne change pas. Une TUI Node hors fenêtre
   reste possible plus tard si le besoin « hors du dashboard » apparaît à
   l'usage ; on ne l'écrit pas d'emblée.
9. Elle garde l'invariant du terminal : **seules les couleurs passent**, aucune
   séquence qui efface, déplace le curseur ou réinitialise — sinon l'humain
   approuve en voyant autre chose que ce qui s'est passé.
10. L'atelier VS-Code (Slice 6) **reste** pour l'inspection diff/fichiers ; la
    vue terminal ne le remplace pas, elle devient l'entrée par défaut. La coque
    desktop (`apps/desktop`) ne change pas : même origine, aucune capacité Tauri.

### E. Le modèle de `hunt`

11. **Décidé le 2026-11-10 : `hunt` tourne sur `deepseek-v4-1-flash-uncensored`
    de Venice**, déjà tarifé (`pricing.json`, Slice 9). C'est le modèle
    « rapide » du pipeline, appelé en parallèle sur des tâches étroites ; les
    étapes qui raisonnent longtemps (`recon`, `validate`, `trace`) iront sur un
    profil à modèle plus capable. **Le plafond de sous-tâches par arbre reste à
    fixer par la mesure** : on relève le coût d'un `hunt` réel à concurrence
    croissante avant d'arrêter `MIDGAARD_MAX_ACTIVE_SUBTASKS` pour ce profil
    (défaut actuel : 4). Le routage se fait par **l'attache à des profils**, pas
    par un YAML de routage (neutralité, décision A.2).

## Découpage proposé (sept étapes)

L'ordre va du gain le plus sûr (du texte) au plus engageant (du code, puis du
dynamique confiné). Rien n'est livré tant que la Slice 9 (5.4, 5.5) ne l'est pas
pour ce qui touche la VM.

1. **Les cinq playbooks d'étape** (`recon`, `hunt`, `validate`, `trace`,
   `report`), adaptés reverse/PE/Windows, attachables tout de suite. Verts =
   relus et SHA-256 cités au départ d'une tâche (mécanique déjà testée).
2. **La porte de traçage `trace_confirmed`** : champ de tâche + migration +
   `PROTOCOL_VERSION`, imposé par le daemon (seul un finding `trace_confirmed`
   entre dans `report`) ; `validate.md`/`trace.md` en décrivent le *comment*.
   Éprouvée sur une cible JavaScript puis sur un binaire au volet PE.
3. **La vue terminal** du dashboard : flux + sortie en direct + dialogue box, en
   lecture seule, séquences réduites aux couleurs. D-tests dans `test:ui`.
4. **Les préfixes `exec` de navigation** : `rg`/`objdump`/`nm`/`strings` bornés
   dans la liste blanche (aucun outil neuf). Pas d'étape de code dédiée au-delà
   des préfixes ; le besoin d'un outil `CodeBrowser` ne se rouvre que sur un cas
   réel non couvert.
5. **Le routage par profils** : poser les profils du pipeline — `hunt` sur
   `deepseek-v4-1-flash-uncensored`, les étapes qui raisonnent sur un modèle
   plus capable — et documenter l'équivalent de `model-routing.yaml` sans YAML
   neuf ; fixer le plafond de sous-tâches de `hunt` par la mesure.
6. **Le `report` structuré** (outil ou playbook de format) : à décider ici.
7. **L'essai réel de bout en bout** : un pipeline complet sur une vraie cible,
   coût relevé, résultat non fiable (contenu encadré), zéro échantillon exécuté.
   Le volet dynamique, s'il est tenté, passe par `windows_run` seulement.

## Tranché le 2026-11-10

Les quatre questions laissées ouvertes à la rédaction ont été décidées avec
l'auteur (voir les décisions B, C, D, E ci-dessus) :

1. **Vue terminal → une vue du dashboard**, pas une TUI à part (décision D).
2. **Porte de traçage → un statut `trace_confirmed` mécanique** dès le départ,
   imposé par le daemon, pas une simple consigne de playbook (décision B).
3. **Navigation de code → des préfixes `exec` bornés** (`rg`, `objdump`, `nm`,
   `strings`), aucun outil `CodeBrowser` neuf tant qu'un cas réel ne l'exige
   pas (décision C).
4. **Modèle de `hunt` → `deepseek-v4-1-flash-uncensored`** ; plafond de
   sous-tâches fixé par la mesure (décision E).

## Reste ouvert (à mesurer ou à l'ouverture)

1. **Le plafond de sous-tâches de `hunt`** : à fixer par la mesure d'un `hunt`
   réel à concurrence croissante (décision E), pas par avance.
2. **Le `report` structuré** (étape 6 du découpage) : outil dédié ou simple
   playbook de format — à décider à cette étape, sur un vrai lot de findings.
3. **Le `Debugger` dynamique sur VM** : reste **non** pour l'instant — il dépend
   d'une VM non encore éprouvée sur un vrai Windows (Slice 9, 5.4/5.5). À
   rouvrir seulement une fois ces sous-étapes closes.

## Récit

### Étape 1 — les cinq playbooks (2026-11-10)

Les cinq étapes du pipeline écrites comme cinq playbooks de `playbooks/`, dans
le ton des six existants (anglais, « the one rule », neutres, rappel que ce qui
est lu est de la donnée, statique seulement) :

- `recon.md` — carte (sous-systèmes, points d'entrée, frontières de confiance,
  historique Git) + file de tâches `hunt` ; discipline de budget (exclure
  `vendor`/`dist`/lock) ; pour un binaire, `pe-static` conduit la carte.
- `hunt.md` — une hypothèse par tâche, un finding falsifiable avec sa
  *condition de mort* à remettre à `validate` ; un négatif propre est un
  résultat ; ne pas confirmer son propre travail.
- `validate.md` — relecteur adversarial, lecture seule : chercher la garde
  manquée, la source non contrôlée, le sink inoffensif ; verdict **rejeté** ou
  **survit** (pas « confirmé » : la porte, c'est `trace`).
- `trace.md` — la **porte** : chaîne source→sink sans trou, référence à chaque
  pas, modèle de menace nommé ; dit que le daemon n'inscrit `trace_confirmed`
  que sur une chaîne complète (décision B), et que « confirmé » sans chaîne est
  la seule chose à ne jamais faire.
- `report.md` — n'assemble que les findings `trace_confirmed` ; gravité fondée
  sur l'atteignabilité prouvée, cause, remédiation, limites ; ne ressuscite
  aucun finding rejeté.

Tailles : 3,4 à 4,8 Kio chacun (borne 32 Kio), 20 Kio les cinq. Ils ne vont
pas sur un même profil : `recon`/`validate`/`trace` sur un profil capable,
`hunt` sur le profil rapide (`deepseek-v4-1-flash-uncensored`), `report` à
l'assemblage — le routage par profils de la décision A.2/E. Le README des
playbooks les décrit. **Aucun code** : la mécanique d'attache, de relecture au
départ et de citation du SHA-256 existe déjà (Slice 9, étape 1), donc ces
playbooks sont attachables tels quels. Le statut `trace_confirmed` que `trace`
et `report` décrivent, lui, reste à écrire (étape 2).

### Étape 2 — la porte de traçage mécanique (2026-11-10)

Les **findings** de première classe dans l'arbre d'un orchestrateur, décision B.
Migration 19 (table `findings`, scopée à la tâche racine comme les
`created_agents`), `PROTOCOL_VERSION` 22, trois événements `finding.*`. Un port
`FindingsPort` posé par le daemon pour le seul orchestrateur (comme la
délégation), et quatre outils (`packages/tools/src/findings.ts`) :

- `record_finding` → un finding `open` ;
- `reject_finding` → `rejected`, seulement depuis `open` ;
- `confirm_trace` → **le seul chemin vers `trace_confirmed`** ; le schéma exige
  une chaîne d'au moins deux pas (`MIN_TAINT_PATH`) et le modèle de menace, et
  un finding rejeté ne se confirme pas ;
- `list_findings` → les findings de l'arbre, `list('trace_confirmed')` étant
  tout ce que le rapport peut relire.

La porte est mécanique : le daemon ne pose `trace_confirmed` que par
`confirm_trace`, et `list('trace_confirmed')` ne rend jamais un finding non
confirmé. Les champs passent par l'expurgation avant d'être persistés (comme un
objectif délégué), un finding n'appartient qu'à son arbre, et l'orchestrateur
en hérite les quatre outils et une note de consigne. Le dashboard montre les
trois événements (Timeline), le reste de la vue est pour l'étape 6.

Prouvé par `tests/unit/findings.test.ts` (8 cas, vrai daemon, effets lus en
base) : cycle de vie, la porte (`list('trace_confirmed')` n'a que les
confirmés), rejet/confirmation irréversibles, isolation par arbre, expurgation,
plafond (`MAX_FINDINGS`), arbre à l'arrêt, et au bord de l'outil le refus d'une
chaîne trop courte et des quatre outils sans port. Verts en local :
`test:unit` (786), `test:orchestrator` (6), `test:security` (13), `typecheck`.
**CI sur trois plateformes à confirmer.** Restent `MAX_FINDINGS` à régler par la
mesure, le format du `report` (étape 6) et le reste de la vue dashboard.

### Étape 3 — la vue terminal (2026-11-10)

Décision D : une **vue du dashboard**, pas une TUI. Route `#/terminal/<id>`, un
bouton « Flux terminal » dans la barre d'onglets de l'atelier et un « Atelier → »
pour revenir. Elle rejoue le journal de **tout l'arbre** (racine + sous-tâches)
en un flux monospace ordonné par séquence globale, défilement suivi tant qu'on
ne remonte pas, et porte en pied la **dialogue box** vers l'orchestrateur — le
même `Composer` que le panneau de chat (exporté), avec le même refus du daemon
tant qu'il travaille.

Elle **lit** le même flux WebSocket que la timeline et le terminal de
l'atelier ; le daemon ne change pas. Le formatage est pur et testé
(`apps/dashboard/src/lib/stream.ts`) : `buildStream` fond l'arbre, étiquette
chaque sous-tâche par son profil, et `plain` retire **toutes** les séquences
d'échappement — couleur comprise, puisqu'elle n'est pas interprétée en HTML
(la teinte est portée par une classe CSS) — et les contrôles qui déplaceraient
ou effaceraient ce que l'humain lit. C'est l'invariant du terminal de l'atelier
(Slice 6), tenu ici. Un type d'événement inconnu garde son nom, en sourdine
(daemon plus récent que la page).

Prouvé par `tests/unit/dashboard-workbench.test.ts` (4 cas purs : `plain`,
l'ordre et les étiquettes, la sortie `exec` brute et stderr en danger, le type
inconnu) et par `D19` de `test:ui` (vrai navigateur : le flux en lignes, la
dialogue box, l'aller-retour atelier ↔ terminal). Verts en local :
`test:unit` (790), `test:ui` (19), `typecheck`. **CI trois plateformes à
confirmer.** Restent les préfixes `exec` (étape 4), le routage par profils (5),
le `report` (6) et l'essai réel (7).

### Étape 4 — la navigation de code par préfixes `exec` (2026-11-10)

Décision C : des préfixes `exec` bornés plutôt qu'un outil neuf. **Un point dur
trouvé avant de coder** : la règle de la Slice 9 (`execPrefixRefusal`) refuse
« une option juste après le programme » (pour bloquer `git -c`, `node -e`), or
`objdump -d`, `nm -C`, `strings -n` sont tous **option-first** — ils étaient
donc refusés comme préfixes. Soumis à l'auteur, qui a tranché pour une
**safelist lecture seule**.

`READ_ONLY_ANALYSIS` (`packages/contracts/src/exec-allow.ts`) : pour
`objdump`, `nm`, `strings`, `readelf`, `size`, `od` — et eux seuls — un préfixe
peut commencer par une option. Le critère est **strict** : ils lisent un fichier
et impriment, aucune de leurs options n'exécute un programme ni n'écrit un
fichier. **Écartés délibérément** bien qu'utiles : `rg` (`--pre`/`--hostname-bin`
lancent une commande), `file` (`-C` compile un fichier magique nommé), `xxd`
(`-r` écrit un binaire) — leur préfixe sans approbation pourrait lancer du code
ou écrire hors du worktree ; ils restent approuvés au coup par coup. Le reste de
la règle ne bouge pas : un chemin relatif (`./objdump`) et un seul mot
(`objdump`) sont toujours refusés, et le daemon rejuge au départ de chaque
tâche.

Aucun outil neuf, aucune migration, aucun `PROTOCOL_VERSION` (la règle est
loin du protocole serveur↔daemon ; un durcissement passé devient un
assouplissement, pas une rupture). Prouvé dans `tests/unit/exec-prefix.test.ts`
(les six outils en option-first acceptés, `rg`/`file`/`xxd` en option-first
toujours refusés avec leur motif, `./objdump` refusé en chemin relatif).
`test:unit` (805), `typecheck` verts en local ; `test:developer` (V14) et la CI
trois plateformes à confirmer. Restent le routage par profils (5), le `report`
(6) et l'essai réel (7).

### Étape 5 — le routage par profils (2026-11-10)

Décision E : le routage se fait par l'**attache à des profils**, pas par un
YAML. Constaté avant d'écrire : l'injection des playbooks
(`engines/agent.ts`) est **agnostique au type** de profil, et `setAgentPlaybooks`
n'exclut que le profil simulé — donc l'**orchestrateur peut porter des
playbooks**. Le pipeline tient alors sans code neuf :

- **l'orchestrateur** pilote `recon`, `validate`, `trace`, `report` (il lit le
  projet, tient les outils de findings et assemble) → ses quatre playbooks, sur
  un **modèle capable** ;
- l'étape **`hunt`**, déléguée en parallèle à des exécutants, va sur le profil
  **`researcher`** avec le modèle **rapide** `deepseek-v4-1-flash-uncensored`
  (déjà tarifé) et le playbook `hunt` ; un agent créé par `create_agent` depuis
  `researcher` en hérite.

C'est l'équivalent du `model-routing.yaml` de harness-kit, réalisé par la
configuration. Les commandes exactes (depuis le clone) :

```
npm run harness -- playbooks attach recon orchestrator
npm run harness -- playbooks attach validate orchestrator
npm run harness -- playbooks attach trace orchestrator
npm run harness -- playbooks attach report orchestrator
npm run harness -- playbooks attach hunt researcher
```

Le modèle d'un profil se règle aux **Profils** du dashboard (`#/agents`,
éprouvé par D10) : l'orchestrateur sur un modèle capable, le `researcher` sur
`deepseek-v4-1-flash-uncensored`. Le **plafond de sous-tâches `hunt`**
(`MIDGAARD_MAX_ACTIVE_SUBTASKS`, défaut 4) reste à fixer **par la mesure** d'un
`hunt` réel à concurrence croissante — c'est l'étape 7, l'essai réel, qui le
donnera ; on ne le fige pas d'avance.

Prouvé que le fait porteur tient : `tests/unit/playbooks.test.ts` attache un
playbook à l'orchestrateur (200), là où le simulé est refusé (409) ;
l'injection elle-même est déjà couverte pour un profil quelconque. **Aucun
code, aucune migration.** `test:unit` (806), `typecheck` verts en local.
Restent le `report` (6) et l'essai réel (7).

### Étape 6 — le `report` déterministe (2026-11-10)

Question laissée ouverte par le plan (« outil ou playbook »), tranchée avec
l'auteur : **un outil `compile_report`**. C'est le maillon qui manquait pour
fermer la boucle de la porte : la porte garantit que le store ne contient que
des findings jugés, mais si le modèle recomposait la liste **de mémoire** dans
son `submit_result`, il pourrait en oublier ou en inventer. L'outil l'émet à sa
place.

`compile_report` (orchestrateur seul, `packages/tools/src/findings.ts`) lit
`list('trace_confirmed')` de son arbre et rend un rapport **déterministe** —
`markdown` (humain), `json` (outil aval), `sarif` 2.1.0 (scanner) — par un
formateur **pur**, `formatReport`, testé sans daemon : à findings égaux, sortie
égale, pas d'horodatage, règles SARIF triées. Le modèle l'inclut tel quel et
n'écrit que sa prose autour (gravité, impact, l'entonnoir, le hors-périmètre).
Le `report.md` le dit, et la consigne de l'orchestrateur aussi. Rejetés et non
confirmés n'y apparaissent jamais — c'est l'outil, pas le modèle, qui le
garantit.

Prouvé dans `tests/unit/findings.test.ts` : `formatReport` dans les trois
formats (titre/source→sink/chaîne/évidence ; `count` et champs JSON ; SARIF
2.1.0 valide avec règle et localisation du sink), son **déterminisme**, et
l'outil qui n'inclut que les findings tracés de l'arbre (un `open` n'y est
pas), résultat `untrusted`. `test:unit` (811), `test:orchestrator` (6),
`typecheck` verts en local. **CI trois plateformes à confirmer.** Reste
l'**essai réel** de bout en bout (étape 7), qui donnera aussi le plafond de
sous-tâches `hunt`.

### Étape 7 — l'essai réel (à lancer)

Prêt mais non lancé : il demande une clé Venice, une cible et du budget API,
donc il revient à l'auteur. Le **guide prêt à lancer** est
[docs/SLICE10-ESSAI.md](SLICE10-ESSAI.md) : mise en place (fournisseur,
modèles, playbooks, préfixes), lancement sur une cible **JavaScript d'abord**
puis **binaire/PE**, ce qu'on observe (vue terminal, approbations, événements
`finding.*`), la liste de contrôle (la porte a tenu, le rapport n'a que des
tracés, le coût égale l'écart du solde, aucun échantillon exécuté) et la mesure
du plafond `hunt`. Le récit de l'essai viendra ici même clore la slice.
