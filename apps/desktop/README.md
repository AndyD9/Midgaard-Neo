# Coque desktop et application autonome

Une fenêtre Tauri 2 autour du dashboard. Elle ne contient **aucune logique du
harness** : elle démarre le daemon, ou s'y rattache, par la CLI, lit l'adresse
du dashboard dans son fichier de découverte, et ouvre une fenêtre dessus. Le
même dashboard s'ouvre toujours dans un navigateur.

Elle existe sous deux formes, du même code :

| | Depuis un clone | Application autonome |
|---|---|---|
| Commande | `npm run desktop:build`, puis `npm run desktop` | `npm run desktop:bundle` |
| Node | celui du clone (`MIDGAARD_NODE`, sinon celui du build) | **embarqué** |
| Harness | les sources du clone | **embarqué**, compilé |
| Dashboard | `apps/dashboard/dist` du clone | **embarqué** |
| Ce qu'il faut sur la machine | Node, le clone, Rust pour construire | rien |

```bash
npm run desktop:build    # la coque seule (Rust requis), après chaque mise à jour du clone
npm run desktop          # ouvre la fenêtre ; démarre le daemon au besoin

npm run desktop:bundle   # l'application autonome : assemble, puis construit le bundle
npm run desktop:portable # l'exécutable unique : un seul fichier, sans installeur
```

## L'application autonome

`npm run desktop:bundle` fait deux choses (`scripts/bundle.mjs`) :

1. **assembler** ce que l'application embarque (`scripts/stage.mjs`,
   `npm run desktop:stage`) dans `src-tauri/runtime/` ;
2. **construire le bundle** par la CLI de Tauri, avec `tauri.bundle.conf.json`
   fusionné à la configuration de base : `.app` et `.dmg` (macOS), `.deb`
   (Linux), installeur NSIS (Windows), dans `src-tauri/target/release/bundle/`.

```text
runtime/
  node[.exe]                          le Node embarqué, et NODE-LICENSE
  app/
    standalone.json                   version, Node, commit
    bin/harness, bin/harness.cmd      le lanceur de la CLI
    dashboard/                        le dashboard compilé
    node_modules/@midgaard/<paquet>/  package.json, dist/, données
    node_modules/<dépendance>/        la fermeture de production
```

Ce que l'assemblage garantit, et pourquoi :

- **Aucune source, aucun lien.** Les paquets du workspace sont copiés depuis
  leur build ; dans le clone ce sont des liens, qui ne survivent ni à un
  bundle Windows ni à une archive. Sans la condition `midgaard-dev`, leurs
  `exports` mènent à `dist/`.
- **Les dépendances sont celles du `package-lock.json`** : la fermeture de
  production de la CLI (`npm ls --omit=dev`), copiée du `node_modules` du
  clone. Aucun `npm install` au moment du build, aucun script de paquet.
- **Le Node embarqué est autonome.** Celui de Homebrew ou d'une distribution
  est lié à des bibliothèques de la machine (`libnode`, `libuv`…) : copié, il
  ne démarre nulle part ailleurs. Le script le **refuse** (`otool -L`, `ldd`)
  et télécharge à la place le Node officiel de la même version sur
  nodejs.org, SHA-256 vérifié contre `SHASUMS256.txt`. Celui de
  `actions/setup-node` est l'officiel : la CI ne télécharge rien.
- **Le dossier produit est effacé puis recréé**, et jamais un dossier qui
  contiendrait le clone.

### L'exécutable unique

`npm run desktop:portable` (`scripts/portable.mjs`) produit **un seul
fichier** — `Midgaard-portable-win32-x64.exe` sous Windows — à copier et à
lancer, sans installeur. L'arbre embarqué est archivé (`runtime.tar.gz`) et
inclus **dans** le binaire (`--features portable`) ; au premier lancement, la
coque le déplie dans le dossier de données de l'application, puis fait comme
un bundle.

- **Où il se déplie** : `%LOCALAPPDATA%\fr.midgaard.desktop\portable\<empreinte>\`
  sous Windows, `~/Library/Application Support/fr.midgaard.desktop/portable/…`
  sous macOS. L'empreinte est celle de l'archive : une nouvelle version se
  déplie **à côté** de l'ancienne, jamais par-dessus un daemon qui tourne.
  Les anciennes versions ne sont pas retirées.
- **Jamais à moitié** : le dépliage se fait dans un dossier voisin, renommé à
  la fin. Interrompu, il ne laisse rien sous le nom définitif.
- **Le premier lancement est plus lent** : quelques milliers de fichiers à
  écrire avant que la fenêtre s'ouvre — 5 secondes constatées sous macOS,
  davantage à prévoir sous un antivirus. Rien ne s'affiche pendant ce temps.
- **Sous Windows, WebView2 doit être là** : il est livré avec Windows 11 et
  les Windows 10 à jour ; l'exécutable ne l'installe pas, contrairement à
  l'installeur NSIS.
- **Pour le retirer** : supprimer le fichier, puis son dossier de données.

Constaté sous macOS (arm64), le 2026-11-11 : le fichier seul dans un dossier,
lancé avec un environnement minimal, se déplie et démarre un daemon dont
l'installation est sous le dossier déplié — dont le chemin porte une espace.
**Jamais constaté sous Windows** : l'exécutable y est construit par la CI,
qui ne le lance pas.

### Le lanceur, et les commandes conseillées

Dans l'application il n'y a ni clone ni npm : `npm run harness -- …` n'existe
pas. Le lanceur embarqué (`launcher/harness`, `launcher/harness.cmd`) lance la
CLI embarquée avec le Node embarqué, de n'importe quel dossier :

```bash
"/Applications/Midgaard.app/Contents/Resources/runtime/app/bin/harness" mcp add rea -- node /chemin/vers/rea.mjs mcp
```

Il pose `MIDGAARD_LAUNCHER` — son propre chemin, entre guillemets — et la
coque fait de même : toute commande que la CLI, le daemon ou le dashboard
conseillent passe alors par lui (`harnessCommand`, `harness_command` dans
`/api/health`). Le dashboard affiche donc, dans l'application, une commande
qui se lance.

Le navigateur des agents (Chromium de Playwright) **n'est pas embarqué** : le
message d'un Navigator qui ne le trouve pas donne la commande d'installation
en chemins absolus — le Node embarqué et le `cli.js` du Playwright embarqué.

### Mises à jour et releases

L'application autonome **se met à jour depuis les releases GitHub** du dépôt
(`src-tauri/src/update.rs`). Au lancement, hors du fil de la fenêtre, elle lit
`latest.json` sur la dernière release publiée ; si une version plus récente
existe, un dialogue natif la propose avec ses notes — **rien ne s'installe sans
« Installer »**. Ce qui est garanti :

- **Un paquet n'est installé que s'il est signé par la clé du dépôt, pour la
  version annoncée.** La vérification est celle de `tauri-plugin-updater`
  (minisign) contre la clé publique de `tauri.conf.json` ;
  `requireSignedVersion` refuse un paquet authentique mais plus ancien qu'un
  manifeste falsifié présenterait comme nouveau. Le manifeste, lui, n'est pas
  signé : ses notes sont montrées comme du texte, sans caractère de contrôle.
- **Jamais pendant une tâche.** Avant d'installer, la coque lance
  `harness stop --if-idle` : le daemon décide lui-même s'il est oisif. S'il
  travaille, la mise à jour est **reportée** et l'application le dit ; elle
  sera proposée au lancement suivant.
- **La page n'y a aucune part** : le dialogue est ouvert par la coque, et le
  dashboard ne reçoit toujours aucune capacité Tauri.
- **Deux formes, deux installations.** Le bundle (`.app`, installeur NSIS,
  `.deb`) est remplacé par le plugin. L'exécutable unique télécharge le
  nouvel exécutable sous sa propre cible (`<os>-<arch>-portable`), le vérifie
  de la même façon, puis **se remplace lui-même** : l'ancien est mis de côté
  (`<nom>.old`, retiré au lancement suivant) et remis en place si le nouveau
  ne peut pas l'être.
- **Seule l'application autonome se met à jour** : la coque d'un clone suit
  son clone. `MIDGAARD_NO_UPDATE=1` désactive la vérification. Une
  vérification qui échoue (pas de réseau, aucune release) ne dit rien.

Après la mise à jour, l'ancien daemon est déjà arrêté ; le nouveau démarre au
lancement, d'une autre installation (dossier du paquet daemon + version).

**Publier une release** (`.github/workflows/release.yml`) :

```bash
npm run release:version -- set 0.2.0
```

```bash
git commit -am "Version 0.2.0"
```

```bash
git tag -a v0.2.0 -m "Ce qui change dans cette version"
```

```bash
git push origin main v0.2.0
```

Le tag construit les trois systèmes, signe les paquets de mise à jour, et
crée une release **en brouillon** avec `latest.json`. Tant qu'elle n'est pas
publiée à la main sur GitHub, aucune application ne la voit. Le message du
tag annoté sert de notes de version, dans la release et dans le dialogue. Un
tag qui ne dit pas la version des fichiers arrête le build
(`version.mjs check`) ; `npm run release:version` sans argument dit la
version, et échoue si deux fichiers divergent.

La clé qui signe est dans les secrets du dépôt (`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), **et nulle part ailleurs**. La perdre,
c'est ne plus pouvoir mettre à jour les applications déjà installées : il
faudrait publier une autre clé publique, donc faire réinstaller à la main.
Un build sans la clé (local, `bundle.yml`) ne produit aucun paquet de mise à
jour, et ne signe rien.

**Limites.** Sous macOS, seule l'architecture du poste de CI (arm64) est
publiée. Le `.deb` se remplace par le gestionnaire de paquets, qui demande le
mot de passe. L'exécutable unique doit être dans un dossier où l'utilisateur
peut écrire.

### Ce qui n'est pas fait

- **Aucune signature.** macOS : signature **ad hoc** seulement
  (`signingIdentity: "-"`), sans laquelle un binaire arm64 ne démarre pas.
  Ni Developer ID, ni notarisation : Gatekeeper refuse l'application
  téléchargée tant qu'on ne l'a pas autorisée (clic droit → Ouvrir, ou
  `xattr -dr com.apple.quarantine`). Windows : installeur non signé,
  SmartScreen avertit.
- **Aucune signature de code**, ce qui n'est pas la signature des mises à
  jour (voir « Mises à jour et releases ») : celle-ci prouve qu'un paquet
  vient de ce dépôt, pas à macOS ou à Windows que l'éditeur est connu.
- **Pas d'AppImage.** Elle se monte à un chemin qui change à chaque
  lancement ; l'identité d'une installation et le lanceur conseillé sont des
  chemins, qui seraient faux au lancement suivant.
- **Le dossier runtime reste `~/.midgaard`**, partagé avec un clone sur la
  même machine.

### Ce qui a été constaté, et ce qui ne l'a pas été

Constaté sous macOS (arm64), le 2026-11-11 : le `.app` copié hors du clone et
ouvert avec un environnement minimal (`PATH=/usr/bin:/bin`, ni
`MIDGAARD_REPO` ni `MIDGAARD_NODE`) démarre un daemon dont le processus est le
Node **du bundle**, dont l'installation (`/api/health`) est sous le bundle,
qui sert le dashboard embarqué et reçoit le `PATH` du shell de connexion ; la
signature ad hoc se vérifie (`codesign --verify --deep`).

**Jamais constaté** : la fenêtre elle-même n'a pas été regardée dans cet
essai (seuls les processus et le daemon l'ont été) ; les bundles Linux et
Windows n'ont jamais été construits ni lancés hors CI ; `harness.cmd` n'a
jamais tourné ; une installation par le `.dmg`, le `.deb` ou l'installeur
NSIS n'a jamais été faite.

Mises à jour — constaté sous macOS (arm64), le 2026-11-11, avec une clé
jetable : le bundle sort son paquet de mise à jour signé
(`Midgaard.app.tar.gz` et sa signature), l'exécutable unique est signé, les
deux signatures portent la version, `release.mjs` en tire un `latest.json`
complet ; l'exécutable unique démarre et, sans release publiée, sa
vérification échoue sans rien montrer. **Jamais constaté** : une mise à jour
réelle, d'une version publiée à la suivante — ni le dialogue, ni le
téléchargement, ni le remplacement du bundle ou de l'exécutable, sur aucun
système ; le workflow `release.yml` n'a jamais tourné.

## Ce que la coque garantit

- **La page n'a aucune capacité Tauri** (`app.security.capabilities: []`) :
  le dashboard ne parle qu'au daemon, en HTTP, comme dans un navigateur. Les
  deux plugins de la coque (mise à jour, dialogue) ne servent qu'à elle, en
  Rust : aucune de leurs commandes n'est accordée à la page.
- **L'origine ne change pas.** La fenêtre charge `http://127.0.0.1:<port>/`,
  l'origine que le daemon accepte déjà : ses contrôles `Host`, `Origin` et
  `Sec-Fetch-Site` restent ceux du navigateur. Une page embarquée
  (`tauri://localhost`) aurait demandé d'ouvrir la liste blanche des origines.
- **Elle ne navigue que sur le dashboard** (`on_navigation`) : ni lien ni
  redirection ne mène ailleurs. Un fichier déposé sur la fenêtre est
  intercepté par le gestionnaire de Tauri, gardé exprès : sans IPC, il n'a
  aucun effet. Et l'adresse lue dans `daemon.json` doit être sur la boucle
  locale, sans quoi la fenêtre du dashboard ne s'ouvre pas.
- **Elle n'utilise pas le jeton** de `daemon.json` : elle n'en retient que
  `dashboard_url`, et le jeton n'est ni copié ni passé à la fenêtre. Le
  dashboard obtient le sien par `/ui/bootstrap`, comme ailleurs.
- **Elle n'arrête pas le daemon** en se fermant : il s'arrête de lui-même
  après son délai d'inactivité.
- **L'arbre embarqué ne vaut que s'il est entier** (`standalone_at`) : Node,
  CLI, lanceur, dashboard et `standalone.json`. Sinon la coque retombe sur le
  clone de son build. `MIDGAARD_REPO` passe devant tout : c'est
  `npm run desktop`.
- **Une panne au démarrage se lit dans la fenêtre.** Une application ouverte
  d'un double-clic n'a pas de terminal. Si le daemon ne démarre pas, la
  fenêtre charge la page embarquée (`ui/index.html`) avec le motif et la
  sortie de la CLI, affichés comme du texte ; cette page n'a aucune capacité
  et ne mène nulle part.

## Le `PATH`, sans le shell

Une application ouverte d'un double-clic n'hérite pas du `PATH` du terminal.

- **Pour trouver `node`** (coque d'un clone) : `build.rs` grave dans le
  binaire le chemin du `node` de npm (`npm_node_execpath`) et la racine du
  clone. Au lancement, `MIDGAARD_NODE` et `MIDGAARD_REPO` passent devant :
  c'est ce que fait `npm run desktop`, qui transmet aussi `--home` par
  `MIDGAARD_HOME`. L'application autonome n'en a pas besoin.
- **Pour le daemon** (application autonome, macOS et Linux) : il hérite du
  `PATH` de la coque, et c'est par lui qu'`exec` résout `git` ou `npm`. La
  coque demande donc son `PATH` au shell de connexion (`$SHELL -l -c`), une
  fois, avec un délai de trois secondes et des marqueurs autour de la valeur
  — un profil bavard ou bloquant ne casse pas l'ouverture.

## Fichiers

| Fichier | Rôle |
|---|---|
| `src-tauri/src/main.rs` | Choix de la CLI (embarquée ou clone), démarrage du daemon, lecture de l'adresse, fenêtre, page d'erreur |
| `src-tauri/src/update.rs` | Mise à jour depuis les releases GitHub : vérification, dialogue, arrêt du daemon oisif, installation |
| `src-tauri/build.rs` | Contexte Tauri, chemin de `node` et racine du clone gravés |
| `src-tauri/tauri.conf.json` | Configuration de base : aucune fenêtre ni capacité déclarée, pas de bundle ; la clé publique et l'adresse des mises à jour |
| `src-tauri/tauri.release.conf.json` | Ce qu'une release ajoute : les paquets de mise à jour signés (seulement avec la clé) |
| `src-tauri/tauri.bundle.conf.json` | Ce que le bundle ajoute : `runtime/` en ressource, signature ad hoc |
| `src-tauri/Cargo.toml` | Dépendances ; les macros procédurales ne sont pas dépouillées (macOS 27 ne les chargeait plus) |
| `src-tauri/icons/` | `icon.png`, et `icon.ico` qui le contient tel quel : Windows exige l'ICO pour la ressource de l'exécutable |
| `ui/index.html` | Page embarquée : n'apparaît que si le daemon n'a pas pu démarrer |
| `scripts/stage.mjs` | Assemble `src-tauri/runtime/` |
| `scripts/bundle.mjs` | Assemble, puis lance le bundler de Tauri |
| `scripts/portable.mjs` | Assemble, archive, et compile l'exécutable unique |
| `scripts/release.mjs` | Fichiers à publier d'un poste de build, et `latest.json` |
| `scripts/version.mjs` | La version, lue, vérifiée et écrite partout (`npm run release:version`) |
| `launcher/harness`, `launcher/harness.cmd` | Le lanceur de la CLI embarquée |
| `packages/cli/src/desktop.ts` | `harness desktop`, le lanceur de la coque d'un clone |

## Comment c'est vérifié

- `npm run test:desktop` : les tests Rust — l'adresse du dashboard (boucle
  locale seulement), l'arbre embarqué qui ne vaut qu'entier, le lanceur cité
  sans préfixe Windows, le `PATH` lu entre ses marqueurs ; avec
  `--features portable`, le dépliage de l'archive (une fois, jamais à moitié) ;
  pour la mise à jour, la cible de l'exécutable unique, les notes montrées,
  et le remplacement de l'exécutable — entier ou pas du tout.
- `tests/unit/release.test.ts` : les cibles et le manifeste `latest.json`
  (refus d'une version qui diverge, d'une cible en double, d'une signature
  vide), la version écrite partout sans reformater ; `test:restart` (R10) :
  `harness stop --if-idle` sur un vrai daemon.
- `npm run test:standalone` (`tests/standalone.ts`) : l'arbre assemblé dans
  un dossier jetable, puis **lancé par son lanceur, hors du clone** — aucune
  source ni lien, daemon de l'arbre, dashboard embarqué servi, commandes
  conseillées par le lanceur, aucun processus après `stop`. Sur un poste dont
  le Node n'est pas embarquable, l'arbre est assemblé avec un lien
  (`--link-node`) et la suite **dit** que la portabilité du Node n'y est pas
  éprouvée.
- `.github/workflows/bundle.yml` : `test:standalone` avec le Node officiel,
  puis le bundle, sur macOS, Linux et Windows ; les bundles sont gardés en
  artefacts.
