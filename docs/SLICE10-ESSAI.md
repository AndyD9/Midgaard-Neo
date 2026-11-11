# Slice 10 — guide de l'essai réel (étape 7)

Prêt à lancer. Il éprouve le pipeline `recon → hunt → validate → trace →
report` de bout en bout sur une vraie cible, avec de vrais modèles, et vérifie
que la **porte de traçage** tient et que le **rapport** ne contient que des
findings tracés. On commence par une cible **source (JavaScript)** — tout le
pipeline sans binaire, sans échantillon, sans Ghidra — puis une cible
**binaire/PE** au second passage.

## Ce que l'essai doit prouver

1. L'orchestrateur mène les cinq étapes, en déléguant `hunt` en parallèle.
2. Un finding non tracé **n'entre pas** dans le rapport ; un finding tracé y
   entre, avec sa chaîne — c'est `compile_report` qui l'émet, pas le modèle.
3. Le coût de l'arbre correspond à l'écart du solde Venice (au microdollar,
   comme aux essais précédents).
4. **Aucun échantillon n'est exécuté** (second passage), chaque `exec` et
   chaque script VM approuvés.
5. On relève le coût de `hunt` à concurrence croissante pour fixer
   `MIDGAARD_MAX_ACTIVE_SUBTASKS`.

## Prérequis

- Le clone installé : `npm ci`, `npm run build`, `npm run init` faits.
- Une clé Venice.
- Une cible source avec une vulnérabilité connue (un petit dépôt JavaScript où
  une entrée utilisateur atteint un sink — `child_process.exec`, une
  concaténation SQL, un `eval`). Un dépôt que vous connaissez : l'essai juge le
  pipeline, pas votre mémoire.

## Mise en place

### 1. Le fournisseur et les modèles

Déclarez Venice avec un **modèle capable** par défaut (celui de
l'orchestrateur). La clé est saisie sans écho.

```bash
npm run harness -- providers add venice --model deepseek-v4-1-flash --preset venice
```

Puis, aux **Profils** du dashboard (`#/agents`), réglez le profil `researcher`
sur le modèle rapide **`deepseek-v4-1-flash-uncensored`** : c'est lui qui
exécutera `hunt`. Laissez l'orchestrateur sur le modèle par défaut.

### 2. Les playbooks du pipeline

L'orchestrateur pilote recon/validate/trace/report ; `hunt` va au researcher.

```bash
npm run harness -- playbooks attach recon orchestrator
```
```bash
npm run harness -- playbooks attach validate orchestrator
```
```bash
npm run harness -- playbooks attach trace orchestrator
```
```bash
npm run harness -- playbooks attach report orchestrator
```
```bash
npm run harness -- playbooks attach hunt researcher
```

### 3. (Cible binaire seulement) les préfixes de navigation

Pour un binaire, autorisez les outils d'analyse en lecture seule **depuis le
dépôt de la cible** (la liste blanche se range sous sa racine) :

```bash
npm run harness -- exec allow --prefix -- objdump -d
```
```bash
npm run harness -- exec allow --prefix -- nm -C
```
```bash
npm run harness -- exec allow --prefix -- strings -n 8
```

`rg` n'est pas dans la safelist (son `--pre` lance une commande) : il restera
approuvé au coup par coup, ce qui est voulu. Pour une cible JavaScript, la
navigation se fait avec `rg` sous approbation — aucune liste blanche à poser.

## Lancer (cible JavaScript d'abord)

Au dashboard, `#/new` : profil **orchestrator**, `project_dir` = le chemin
absolu du dépôt cible, et un objectif qui nomme le pipeline, par exemple :

> Run a vulnerability-research pass on this repository. Recon the entry points,
> hunt for injection and command-execution bugs (delegate hunt tasks in
> parallel to researcher executors), validate each finding adversarially, trace
> the attacker-controlled input to the sink, and compile the report of the
> trace-confirmed findings in markdown. Follow your playbooks.

## Observer

- **La vue terminal** (`#/terminal/<id>`) : le flux de l'arbre en lignes —
  `finding` (enregistré), `finding tracé`, les délégations, la sortie `exec`.
  La dialogue box en pied sert à relancer l'orchestrateur s'il demande.
- **Les approbations** : chaque `exec` non couvert par un préfixe suspend la
  tâche ; approuvez au dashboard (ou à la CLI) et lisez la commande exacte.
- **L'atelier** (`#/tasks/<id>`) : la carte « Sous-tâches » montre l'arbre et le
  budget ; le fil montre findings et messages.

## Vérifier (liste de contrôle)

- [ ] L'orchestrateur a **enregistré** des findings (`finding.recorded`), en a
      **rejeté** au moins un (`finding.rejected`), en a **tracé** au moins un
      (`finding.trace_confirmed`).
- [ ] Le `submit_result` contient le rapport de `compile_report`, et ce rapport
      ne liste **que** les findings tracés — aucun `open` ni `rejected`.
- [ ] Le coût de l'arbre (carte « Sous-tâches ») égale l'écart du solde Venice.
- [ ] Le résultat est marqué **non fiable** (il a reçu du contenu encadré).
- [ ] (Binaire) **aucun** processus de la cible lancé ; `exec list` ne montre
      que des préfixes de lecture ; aucun échantillon dans un worktree.

## Régler le plafond `hunt`

Relancez l'essai en augmentant la concurrence de `hunt` et relevez le coût et la
durée à chaque palier :

```bash
MIDGAARD_MAX_ACTIVE_SUBTASKS=2 npm run harness -- status
```

(le plafond se passe au **daemon** à son démarrage ; arrêtez-le, puis relancez
une tâche). Montez `2 → 4 → 8`, notez où le coût par finding tracé cesse de
baisser, et fixez la valeur retenue. C'est la seule mesure que la conception a
laissée ouverte.

## Second passage : cible binaire / PE

Même mise en place, plus :
- la cible passée en **échantillon** (lecture seule) à la tâche — par l'API
  (`POST /api/tasks` avec `samples`), le formulaire du dashboard ne l'expose pas
  encore ;
- les préfixes `objdump`/`nm`/`strings` de l'étape 3 ci-dessus ;
- le playbook `pe-static` sur le profil qui triera le binaire ;
- facultatif : le serveur MCP **REA** (Ghidra) attaché au researcher, pour le
  désassemblage profond — ses outils approuvés sur leurs arguments.

La règle ne bouge pas : **l'échantillon ne s'exécute jamais**, même approuvé ;
toute exécution dynamique, si elle a lieu un jour, passe par la VM Windows.

## Consigner le résultat

Écrivez le récit de l'essai dans `docs/SLICE10.md`, section « Récit », étape 7 :
la cible, les modèles, le nombre de findings à chaque porte (trouvés → survécus
à validate → tracés → rapportés), le coût contre le solde, ce qui a été trouvé
et réglé en chemin, et la valeur retenue pour `MIDGAARD_MAX_ACTIVE_SUBTASKS`.
C'est ce qui clôt la Slice 10.
