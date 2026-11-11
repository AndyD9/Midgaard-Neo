# `@midgaard/secrets`

Coffre système pour les clés d'API des fournisseurs de modèles, **sans
dépendance native**. La base du harness ne contient que des références
(`provider.3f9a0c21.venice`) ; les clés vivent ici.

## Ce que chaque plateforme offre réellement

| Plateforme | Mécanisme | Protégé par l'OS | Le secret passe par |
|---|---|---|---|
| macOS | `security` — trousseau | oui | argument (voir la limite ci-dessous) |
| Windows | PowerShell `ConvertFrom-SecureString` — DPAPI, lié au compte et à la machine | oui | entrée standard |
| Linux | `secret-tool` — libsecret, trousseau de session | oui | entrée standard |
| partout | repli fichier `0600` dans `~/.midgaard/secrets` | **non** | — |

`SecretVault.osBacked` porte cette colonne. Le repli existe pour les serveurs
sans session graphique ; il est annoncé comme ce qu'il est, pas présenté comme un
coffre.

## Pourquoi ces mécanismes et pas d'autres

**Pas de `keytar`.** C'est une dépendance native : binaire précompilé à
télécharger, compilation locale si la plateforme n'est pas couverte. La Slice 1 a
refusé `better-sqlite3` pour la même raison, et pour le même bénéfice : un
`git clone` suffit partout.

**Pas le Credential Manager de Windows.** `cmdkey`, seul utilitaire fourni
d'office, sait écrire un identifiant mais pas relire un mot de passe — c'est
délibéré de la part de Windows. Le module PowerShell `CredentialManager` le
permettrait, mais il n'est pas installé par défaut.

## Le coffre est par utilisateur, pas par dossier runtime

Le trousseau ne connaît qu'un **service** `midgaard` et des **comptes**.
`MIDGAARD_HOME` déplace la base, le journal et le verrou ; il ne déplace
**pas** le coffre. La référence d'une clé porte donc l'empreinte du dossier
runtime : `provider.<8 hex>.<id>`, calculée par `secretRefFor` dans le daemon.
Jusqu'à la Slice 4, elle valait `provider.<id>`, et deux installations d'une
même session partageaient leurs clés : déclarer `venice` dans l'une écrasait
celle de l'autre, et la retirer la supprimait pour les deux (docs/SLICE4.md,
leçon n° 30). Les références déjà en base gardent leur forme : c'est la base
qui dit où chercher.

Les tests forcent en plus `MIDGAARD_VAULT=file` (voir `tests/helpers.ts`), ce
qui les cantonne à leur dossier jetable, sans rien écrire dans le coffre de la
machine.

## Limites connues, et assumées

- **macOS expose le secret dans `ps` le temps de l'écriture.** `security
  add-generic-password` n'accepte le mot de passe qu'en argument (`-w`) ; il ne
  lit pas l'entrée standard. Seuls les processus du **même utilisateur** le
  voient — et ceux-là peuvent de toute façon lire le jeton du daemon dans
  `~/.midgaard/daemon.json`. C'est déjà hors du modèle de menace décrit dans
  [`packages/daemon/README.md`](../daemon/README.md). La **lecture** n'expose rien.
- **DPAPI protège contre le vol de fichier, pas contre la session compromise.**
  Tout processus tournant sous le même compte Windows peut déchiffrer. C'est
  également vrai du trousseau macOS sans demande de mot de passe.
- **Un trousseau déverrouillé est un trousseau ouvert.** Aucun des trois
  mécanismes ne redemande de mot de passe à chaque lecture : ils protègent le
  secret **au repos**, pas contre un processus déjà dans la session.

## Comment c'est vérifié

`tests/unit/secrets.test.ts` passe la **même batterie** au coffre système de la
machine qui l'exécute et au repli fichier : aller-retour, secret non-ASCII,
remplacement, suppression, absence, et — le cas qui compte — **deux références
qui ne se mélangent pas**. Elle ne connaît aucun coffre en particulier ; elle ne
parle qu'à `SecretVault`.

Une machine n'en prouve qu'un, d'où `.github/workflows/vault.yml` : macOS,
Windows, Linux avec trousseau, Linux sans. Chaque poste pose
`MIDGAARD_REQUIRE_VAULT` et la suite échoue si ce n'est pas ce coffre-là qui a
été retenu — sinon un poste sans trousseau passerait au vert sans rien éprouver.

### Ce que l'écriture de cette batterie a trouvé

Deux pannes, avant même son premier lancement, dans du code qui avait l'air juste :

- **DPAPI rangeait toutes les références dans un seul fichier.** La référence
  voyageait par `process.env`, que `run()` ne transmet pas : l'environnement du
  fils est reconstruit à partir d'une liste blanche où elle ne figurait pas. Le
  script PowerShell lisait `$null`, et `Join-Path $dir ($null + '.dpapi')`
  désignait toujours la même cible. Chaque clé déposée écrasait la précédente, et
  toute relecture rendait la dernière écrite — **sans la moindre erreur**. Un
  seul des six cas le voit : celui qui garde deux références vivantes en même
  temps. La référence passe désormais en argument de `run()`, ce qui règle au
  passage une course entre deux `set` simultanés.
- **libsecret se déclarait disponible sans bus de session.** `secret-tool` sort
  en 1 aussi bien pour « secret absent » que pour « bus injoignable », et la
  sonde acceptait les deux. Sur un serveur sans session graphique, libsecret
  était donc élu, puis échouait à chaque écriture. Ce qui distingue les deux cas
  est la sortie d'erreur : une absence est muette, une panne parle. Au passage,
  `DBUS_SESSION_BUS_ADDRESS` et `XDG_RUNTIME_DIR` manquaient à la liste blanche
  de `run()` — sans elles, `secret-tool` ne trouve pas le trousseau même là où
  il fonctionne.

Les deux étaient exactement ce que « écrit d'après la documentation, jamais
exécuté » laisse passer.

### Puis la CI en a montré trois de plus

Il a fallu **cinq passages pour obtenir quatre verts**, et chaque rouge disait
quelque chose de vrai :

- **DPAPI reconstruisait le cache d'analyse de modules de PowerShell à chaque
  appel** — 8 à 15 s, contre 264 ms quand il le retrouve, donc au-delà du délai.
  Il manquait `PSModuleAnalysisCachePath` à la liste blanche : non pas une
  variable que PowerShell lit pour travailler, mais une qu'il lit **pour ne pas
  refaire un travail**. La variable passe désormais, et PowerShell reçoit son
  propre délai de 40 s — un cache froid est une lenteur légitime, et couper à
  10 s ferait échouer le premier appel d'une machine neuve.
- **Supprimer un secret absent levait, sur les deux plateformes, pour deux
  raisons différentes.** `secret-tool clear` sort en 1 sur un secret absent ;
  PowerShell sort en 1 dès que sa dernière commande a échoué, même avec
  `-ErrorAction SilentlyContinue`. macOS tenait le contrat (code 44 toléré) et
  le repli fichier aussi (`rmSync` avec `force`) : trois plateformes, trois
  mécanismes, un seul contrat.
- **libsecret se déclarait disponible sur un trousseau sans collection.**
  `secret-tool lookup` réussissait là où tout `store` échouait. La sonde prouve
  que le service **répond**, pas qu'il a **où ranger**. Limite réelle et
  assumée : la combler demanderait d'écrire un secret d'essai à chaque
  démarrage.

Deux messages ont été corrigés en chemin, parce qu'ils envoyaient au mauvais
endroit : un utilitaire tué par le délai ressortait en « code 1 » avec une
sortie d'erreur vide, et une panne Windows s'affichait
`#< CLIXML <Objs Version="1.1.0.1"…` — PowerShell, flux redirigés, sérialise des
objets au lieu d'écrire du texte. `powershellError` en extrait le message.

Un dernier défaut ne s'est montré qu'à la Slice 4, étape 7, en échec
**intermittent** de `secrets.test.ts` (« write EPIPE » après la fin d'un test) :
un utilitaire qui sort sans lire son entrée standard fait échouer l'écriture du
secret, et cette erreur naît sur le flux `stdin` du fils, que `run()`
n'écoutait pas. Exception non rattrapée : dans le daemon, un appel au coffre
l'aurait tué. Reproduit trois fois sur trois avec un fils qui sort aussitôt et
quatre mégaoctets à lui écrire ; le test `run` le rejoue, et échoue sans
l'écouteur.

Trois hypothèses sur la panne DPAPI ont été fausses avant qu'une **bissection**
sur les 145 variables écartées ne nomme la bonne en sept étapes. Chercher par
élimination coûtait un passage ; en deviner trois en a coûté trois.

### État : constaté

Passage `40937579307` du 2026-10-29, quatre postes au vert — trousseau macOS,
DPAPI Windows, libsecret sous session de bureau, et le repli fichier sur un
Linux sans trousseau. DPAPI répond en moins de 1,5 s par cas.

Ce qui n'est **pas** couvert : un Windows sans PowerShell 5.1, un macOS au
trousseau verrouillé, et un service Secret Service sans collection — ce dernier
cas étant la limite de sonde décrite ci-dessus.

## API

```ts
const vault = await openVault(config, process.env)   // choisit, en mesurant
await vault.set('provider.venice', key)
const key = await vault.get('provider.venice')       // null si absent

// Clé d'un fournisseur : coffre d'abord, variable d'environnement en dépannage
const found = await resolveApiKey(vault, config.secret_ref, 'VENICE_API_KEY', process.env)
```

`MIDGAARD_VAULT` force un mécanisme (`macos-keychain`, `windows-dpapi`,
`libsecret`, `file`). Un coffre forcé et indisponible lève : les secrets ne
partent jamais ailleurs en silence.
