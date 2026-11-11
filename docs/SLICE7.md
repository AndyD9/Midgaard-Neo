# Slice 7 — Les agents voient : images, puis un navigateur isolé

**Date :** 2026-11-03 · **Objectif :** qu'un agent puisse **lire une image** —
une capture, une maquette, un schéma du projet — puis **se servir d'un
navigateur** : ouvrir une page ou une application web, la regarder, cliquer,
saisir. Le tout dans un navigateur que le daemon lance à part, sous des
sessions que l'humain approuve et surveille en direct dans l'atelier.

**État : terminée** (2026-11-05). Étapes 1 à 6 faites le 2026-11-03, 7 et 8
le 2026-11-05 ; l'étape 1 constatée contre l'API réelle de Venice, les étapes
1 à 7 en CI sur trois plateformes, l'essai réel réussi à la deuxième tentative
(`deepseek-v4-1-flash` sur TodoMVC). Les deux points restés ouverts après
l'essai sont réglés le même jour : la fenêtre desktop vide (une page plus
vieille que son daemon, qui se recharge désormais), et les textes prévus,
éprouvés par un vrai modèle (une approbation au lieu de sept).

---

## Ce que la Slice 7 renverse

Jusqu'ici, un agent ne lit que du texte : fichiers, pages converties en texte
(`http_fetch`), sorties de commandes. Et il n'agit sur le monde que par trois
portes, chacune gardée : l'écriture dans son worktree, `exec` sous approbation,
la délégation. Un agent qui **voit un écran et agit dessus** ouvre une
quatrième porte, la plus large : une page web contient tout ce qu'un humain
peut y faire, et une image peut porter un texte qui cherche à détourner
l'agent. C'est pour cela que l'ordre est imposé : les images d'abord, qui ne
font rien ; le navigateur ensuite, qui agit.

## Les décisions prises avec l'auteur (2026-11-03)

| Question | Réponse retenue |
|---|---|
| Par quoi commencer ? | **Les images d'abord**, puis le pilotage, dans la même slice |
| Où l'agent « utilise l'ordinateur » ? | **Un navigateur isolé**, lancé par le daemon, sans les sessions ni les cookies de l'utilisateur. Jamais son vrai bureau |
| Que veut dire « utiliser des applications » ? | **Les ouvrir et s'en servir à l'écran.** Dans un navigateur isolé, ce sont des **applications web** ; les applications natives demanderaient une machine virtuelle, hors de cette slice |
| Comment approuver les actions à l'écran ? | **Une session approuvée, surveillée** : l'humain approuve une session (objectif, durée), voit l'écran en direct et peut couper ; saisir du texte et valider restent approuvés à chaque fois |

## Ce que le code offre déjà

- **Venice publie la capacité de chaque modèle** dans son catalogue public
  (`/models`, `model_spec.capabilities.supportsVision`) : relevé le
  2026-11-03, 96 modèles sur 139 lisent les images. **Le modèle des essais de
  la Slice 6, `deepseek-v4-flash-0731`, n'en fait pas partie.** Parmi ceux qui
  lisent les images **et** appellent des outils : `mistral-small-3-2-24b-instruct`
  (0,094 $ / 0,25 $ par million de jetons), `qwen-3-8-flash`, `google-gemma-3-27b-it`.
- **Playwright est déjà une dépendance** du dépôt, de développement seulement
  (`test:ui`) ; Chromium s'installe par `npx playwright install chromium`.
- **La garde réseau** d'`http_fetch` (`tools/src/net.ts` : adresses privées,
  IMDS, redirections) et **la garde des processus** (`tools/src/guard.ts`) sont
  réutilisables pour le navigateur.
- **Les approbations** portent déjà sur une opération préparée, avec empreinte ;
  **le terminal et l'éditeur de l'atelier** montrent déjà le travail en direct
  (Slice 6).
- Manquent : un message qui porte une **image** (`Message.content` n'est que du
  texte, `providers/src/adapter.ts`), la **capacité** d'un modèle, un paquet
  qui pilote un navigateur, et une approbation qui porte sur **une session**
  plutôt que sur une opération.

## Décisions de conception

1. **Une image n'est jamais écrite en base.** Le journal garde son chemin, sa
   taille, son type et son empreinte (SHA-256), jamais ses octets. Une image
   peut montrer un secret — une capture d'écran surtout —, et l'expurgation ne
   sait pas lire une image.
2. **La capacité « vision » est constatée, pas supposée.** Lue dans le
   catalogue du fournisseur quand il la publie (Venice) ; sinon déclarée par
   l'utilisateur pour un profil, et dite comme telle. Sans elle, `read_image` et
   les outils du navigateur sont **refusés avec leur motif**, comme un profil
   sans fournisseur : jamais une image envoyée à un modèle qui l'ignorerait, en
   la facturant.
3. **L'image passe par un message utilisateur.** L'API Chat Completions
   n'admet pas d'image dans un message de rôle `tool`, et Gemini pas davantage
   dans une `functionResponse`. Le résultat de l'outil dit « image jointe »,
   et l'image suit, dans un message utilisateur que la boucle ajoute. La
   normalisation reste dans chaque adaptateur, jamais dans la boucle (PLAN §4).
4. **Une image du projet n'est pas encadrée ; une capture d'une page l'est.**
   Comme pour le texte : un fichier du dépôt n'est pas plus suspect que le
   dépôt, une page web l'est. Une image ne se met pas entre balises : la tâche
   qui en a reçu une venue du navigateur est **marquée non fiable**, comme si
   elle avait lu la page (règle de la Slice 5).
5. **Le navigateur est jetable et sans privilège.** Un Chromium par session,
   profil vierge, sans extension, sans téléchargement, sans permission
   (caméra, micro, géolocalisation, notifications, presse-papiers). Toute
   requête passe par la garde réseau d'`http_fetch` : adresses privées, IMDS et
   redirections vers elles refusées. Il meurt avec la session, la tâche, et
   avec le daemon — y compris tué net (la garde des processus, comme `exec`).
6. **La session est l'approbation.** `browser_open` prépare une session —
   objectif, adresse de départ, durée maximale — que l'humain approuve. Dans la
   session, regarder, faire défiler et cliquer sont libres ; **saisir du texte
   et presser Entrée sont approuvés chacun**, avec le texte exact : c'est par là
   qu'un formulaire part. *Précisé à l'étape 7 : un clic peut aussi envoyer un
   formulaire, sans approbation ; c'est dit à l'humain dans la demande de
   session, et au modèle (décision du 2026-11-05).*
   *Allégé après l'essai réel (décision du 2026-11-05) : les textes que
   l'agent annonce à l'ouverture sont approuvés avec la session, et une
   saisie peut porter son Entrée ; voir « Après l'essai ».* L'humain coupe la session quand il veut, et elle
   expire seule.
7. **L'humain voit ce que voit l'agent.** Un onglet « Navigateur » dans
   l'atelier montre la dernière capture, au fil des actions. Les captures
   restent **en mémoire** (décision 1) ; le journal raconte l'adresse et
   l'action, pas l'image.
8. **Un profil dédié**, plutôt que d'étendre le Researcher ou le Developer :
   ses outils, sa consigne et son budget (les images coûtent des jetons) lui
   sont propres, et le désactiver coupe tout le pilotage d'un coup.
9. **Pas de machine virtuelle ni d'application native** dans cette slice. Le
   besoin se confirmera, ou non, à l'usage du navigateur.

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | Contrats et adaptateurs : contenu image dans `Message`, OpenAI-compatible (`image_url`) et Gemini (`inline_data`) sur réponses enregistrées, capacité « vision » lue au catalogue ou déclarée | **fait** — constaté chez Venice ; la déclaration par profil passe à l'étape 2 |
| 2 | `read_image` : types reconnus par leurs premiers octets (PNG, JPEG, WebP, GIF), taille plafonnée, chemin vérifié comme `read_file`, refus sans vision ; l'image suit le résultat d'outil ; rien de l'image en base | **fait** |
| 3 | Le paquet `browser` : Chromium jetable par Playwright, garde réseau, sans téléchargement ni permission, processus tués à la fin et après `SIGKILL` | **fait** |
| 4 | Les outils et la session : `browser_open` (session approuvée), `browser_screenshot`, `browser_goto`, `browser_click`, `browser_scroll`, `browser_type` et Entrée (approuvés chacun), `browser_close` ; captures non fiables | **fait** |
| 5 | Le profil `navigator` : consigne, outils, limites ; désactivé sans modèle à vision, avec son motif | **fait** — et le moteur, la coupure humaine et la fermeture avant conclusion, exercés dans un vrai daemon |
| 6 | L'atelier : onglet « Navigateur » (dernière capture en direct, adresse, bouton « Couper la session »), l'image lue montrée dans le fil | **fait** — et la case « lit les images » aux Profils |
| 7 | Preuves : unitaires, de bout en bout sur une page locale servie par le test, `test:security` (adresse privée depuis le navigateur, saisie sans approbation, aucun Chromium vivant après `SIGKILL`, aucune image en base), CI sur trois plateformes | **fait** — X7 à X9, verts en CI sur trois plateformes ; un défaut IPv6 et un test de garde qui ne prouvait rien, réglés |
| 8 | L'essai réel : un agent lit une maquette, puis navigue dans une application web, sous session approuvée, coût comparé à la facture | **fait** — N1 à N9 constatés, coût « facturé par le fournisseur » mais non comparé au solde ; une expiration inscrite comme un refus, réglée |

### Ce que chaque étape doit surveiller

- **Étape 1.** Vérifier contre l'API réelle qu'une image passe, et ce qu'elle
  coûte : les réponses enregistrées ne prouvent que la forme. La dette Gemini
  de la Slice 2 (jamais éprouvé contre l'API réelle) touche aussi les images.
- **Étape 2.** Une extension ment : le type se lit dans les octets. Et un
  fichier énorme se refuse avant d'être lu en entier.
- **Étape 3.** Compter les processus Chromium vivants après chaque fin,
  `SIGKILL` du daemon compris : c'est ainsi que la garde d'`exec` a été prouvée.
- **Étape 4.** Une approbation de session porte sur une **opération préparée**
  et son empreinte, comme les autres : objectif, adresse, durée. Une saisie
  approuvée porte sur son texte exact.
- **Étape 8.** Le solde du compte Venice bouge sous un autre usage (Slice 6) :
  une clé sur un compte dédié, ou l'essai ne compare pas au solde, et le dit.

## Récit

### Étape 1 — les images dans la conversation (2026-11-03)

**Un champ de plus, pas une autre forme.** Un message utilisateur garde son
`content` texte et gagne `images` (base64, type parmi PNG, JPEG, WebP, GIF).
Changer `content` en liste de parties aurait obligé à retoucher chaque endroit
qui écrit un message — la boucle, le contexte, les tests — pour un cas qui ne
concerne que les images. Les messages d'avant se traduisent à l'identique : un
test le fixe pour l'API compatible OpenAI.

**Chaque adaptateur traduit, la boucle n'en sait rien.** L'image devient une
partie `image_url` en URL `data:` (une URL externe ferait télécharger l'image
par le fournisseur, et la page d'origine le saurait) ou une partie
`inlineData` à côté du texte chez Gemini. La règle du PLAN §4 tient : les
différences de fil restent dans les adaptateurs.

**La capacité est lue, pas devinée.** `capabilities()` lit `supportsVision`
dans le catalogue Venice, une fois par heure ; il rend `null` pour un modèle
absent du catalogue, pour un catalogue en panne, et chez OpenAI ou un endpoint
`custom`, qui ne publient rien. Deviner d'après le nom (`-vl`, `vision`) aurait
manqué presque tous les modèles relevés : sur les 96 qui lisent les images,
quatre seulement le disent dans leur nom (`qwen3-vl-235b-a22b`,
`z-ai-glm-5v-turbo`, `nvidia-nemotron-3-5-super-vl-120b-a12b`,
`e2ee-qwen3-vl-30b-a3b-p`) ; `gemini-3-7-flash` ou `mistral-small-3-2-24b-instruct`
les lisent sans le dire.

**Déplacé à l'étape 2 :** la **déclaration** de la capacité par un profil,
quand le fournisseur ne la publie pas. Elle ne sert qu'au refus de
`read_image`, et se conçoit avec lui.

**Vérifié :**
- `npm run typecheck` ;
- 6 tests sur réponses enregistrées (`providers.test.ts`, « images et
  capacité ») : la forme exacte des deux fils, un message sans image
  inchangé, le catalogue lu (vrai, faux, non publié, modèle absent), gardé une
  heure, illisible sans échec, et aucune requête chez OpenAI ;
- `npm run test:unit` : 492 tests.

**Constaté contre l'API réelle**, avec l'accord de l'auteur
(`npm run test:live-vision`, opt-in, hors de `npm test`). L'image est l'icône
de la coque, un PNG de 1 401 octets ; la question ne nomme ni la lettre ni la
couleur.

| # | Verdict | Constat |
|---|---|---|
| V1 | ✅ | `mistral-small-3-2-24b-instruct` : `supportsVision` lu au catalogue Venice |
| V2 | ✅ | « The letter "M" is drawn in the image, and the background color is blue. » — le violet de l'icône lu « blue », la lettre juste |
| V3 | ✅ | 0,0001073125 $ facturés par Venice, estimation égale ; 1 094 jetons en entrée pour une question de vingt mots : l'image en compte environ mille |

L'essai lit la base en lecture seule et le coffre de l'utilisateur, sans rien
y écrire. Il prend la référence de clé dans la ligne du fournisseur : la
référence par installation (`provider.<empreinte>.<id>`, Slice 4) ne se devine
pas.

### Étape 2 — `read_image` (2026-11-03)

**L'outil** (`tools/src/image.ts`) lit une image du projet et la rend au
modèle.
- Le type se lit dans les **premiers octets** : un PNG nommé `.jpg` part
  comme PNG, et un texte nommé `.png` est refusé. Un SVG est refusé aussi :
  c'est du texte, qui peut porter un script.
- La taille est plafonnée à **4 Mo**, d'après celle que relève l'ouverture du
  descripteur.
- Le chemin passe par `openUnderRoot`, comme `read_file`.
- Le journal ne garde que le chemin, le type, la taille et le début du
  SHA-256 ; le texte rendu au modèle dit seulement que l'image suit.

**L'image suit tous les résultats de l'étape.** La boucle rassemble les images
des outils d'une étape et les joint dans **un** message utilisateur, après le
dernier résultat. Les joindre après le résultat de `read_image`, quand l'étape
compte d'autres appels, aurait glissé un message utilisateur entre deux
résultats : l'API Chat Completions refuse alors la requête. Le test fixe
l'ordre avec deux appels dans la même étape.

**Qui décide que le modèle lit les images** (`visionOf`, moteur d'agent) :
1. le catalogue du fournisseur, quand il publie la capacité — il l'emporte sur
   une déclaration contraire ;
2. sinon, la déclaration du profil (`agents.vision`, migration 10,
   `PATCH /api/agents/:id` avec `vision`) ;
3. sinon, non, avec un motif qui dit comment faire.

Une déclaration porte sur un modèle : elle **tombe quand le modèle change**,
sauf si la même requête en déclare une pour le nouveau. Le catalogue n'est lu
que pour un profil qui a `read_image`.

**Un modèle qui ne lit pas les images ne se voit pas proposer l'outil.** Le
moteur retire `read_image` des outils envoyés au fournisseur, et le dit par une
note dans la timeline, avec le motif. S'il l'appelait quand même, la politique
le refuserait sans approbation (`ToolContext.vision` absent ou faux : fermé
par défaut, comme `writable`).

**Les profils** Researcher, Developer et orchestrateur reçoivent `read_image`.
Le profil dédié au navigateur viendra à l'étape 5.

`PROTOCOL_VERSION` passe à 12 : un profil porte `vision`, que le serveur MCP
et le dashboard valident.

**Vérifié :**
- `npm run typecheck` ;
- 12 tests (`tests/unit/vision.test.ts`) :
  - les quatre types, un SVG, un WAV et un fichier vide ;
  - le type lu malgré une extension menteuse, un texte déguisé, un fichier
    trop gros, un chemin et un lien hors du projet ;
  - le refus sans vision, et sans contexte de vision ;
  - `visionOf` dans ses cinq cas ;
  - dans un vrai daemon, sur un fournisseur `custom` qui ne publie rien :
    l'outil non proposé et la note, puis la déclaration par `PATCH`,
    l'image arrivée au modèle, et **la base et son WAL lus octet pour octet
    sans un morceau de l'image** ;
  - la déclaration qui tombe quand le modèle change ;
- l'ordre des messages autour d'une image (`agent-runtime.test.ts`) ;
- la migration 10 sur une base arrêtée au schéma 9.

*Constaté en CI sur `0567e2f` : « Worktrees » (`41675724221`) et « Bout en
bout » (`41675724292`) verts sous macOS, Linux et Windows.*

### Étape 3 — le navigateur isolé (2026-11-03)

**Un paquet sans politique.** `@midgaard/browser` ouvre une session, exécute et
dit ce qu'il a vu. Il ne décide pas de ce que l'agent a le droit de faire : la
session approuvée et la saisie approuvée à chaque fois sont l'affaire des
outils (étape 4).

**Un proxy, plutôt que l'interception de Playwright.** Juger les requêtes dans
la page (`route`) jugerait un nom, que Chromium résoudrait ensuite lui-même ;
le DNS peut changer de réponse entre les deux (*DNS rebinding*). L'interception
ne voit pas non plus les WebSocket. Le proxy gardé voit tout ce qui sort, en
`CONNECT` ou en clair, et **se connecte à l'adresse qu'il a jugée**. Sa règle
est celle d'`http_fetch` (`assertPublicHost`) : adresses privées, boucle locale
et IMDS refusées.

**Ce que le test a trouvé : une variable qui désarme la boucle locale.**
Chromium contourne d'office un proxy pour `127.0.0.1`. Le premier essai de
preuve — retirer le drapeau `--proxy-bypass-list=<-loopback>` et constater
l'échec — a **réussi quand même** : Playwright pose déjà cette règle. En lisant
pourquoi, une exception apparaît. Playwright ne la pose pas si la variable
`PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` est définie, et le daemon
hérite de l'environnement de qui le lance. Variable posée, sans le drapeau, la
page locale **se charge** : vu. Avec lui, elle est refusée. Le drapeau reste,
pour cette raison et non pour celle que le premier commentaire donnait, et un
test le vérifie avec la variable posée.

**Jetable et sans privilège.**
- Un Chromium neuf par session, sans cookie, historique ni extension.
- Aucun téléchargement, aucune permission, aucun service worker.
- `http:` et `https:` seulement.
- Une seule page : une fenêtre surgissante est fermée.
- Une liste fermée de touches.
- Des captures en JPEG, plus légères qu'un PNG : moins de jetons par image.

**Aucun processus survivant.** Playwright lance Chromium en chef de son groupe
de processus, ce qui a été constaté : trois processus dans le groupe. La session
le confie dès son lancement à la garde d'`exec` (`guardGroup`), désormais
exportée par `tools`. À la fermeture, elle **tue le groupe**, puis libère la
garde. Le premier jet comptait sur la libération pour tuer, alors qu'elle ne
fait que retirer le groupe de la liste. Le test compte les processus du groupe
au système dans deux cas :
- après la fermeture ;
- après un `SIGKILL` du processus qui tenait la session.

Les deux fois, il en compte zéro.

**Ce que le test a trouvé aussi : l'état relu trop tôt.** Après Entrée sur un
formulaire, la session relisait l'adresse avant que la navigation ne commence,
parce que la page courante était déjà chargée. Elle attend désormais qu'une
navigation de la page principale commence, une seconde au plus, puis qu'elle
se charge.

**Vérifié :**
- `npm run typecheck` ;
- 9 tests sur un vrai Chromium (`tests/unit/browser.test.ts`) :
  - le découpage d'un `CONNECT` ;
  - la navigation, la capture JPEG, le clic, la saisie et Entrée sur un
    formulaire ;
  - les refus de `file:`, de `javascript:`, d'une touche et d'un clic hors de
    la page ;
  - la fenêtre surgissante fermée ;
  - l'IMDS refusé depuis une page ;
  - la boucle locale refusée par la vraie garde, variable de Playwright posée
    comprise ;
  - le groupe mort à la fermeture et après `SIGKILL` — *ce dernier cas ne
    prouvait pas la garde : il passait sans elle, Chromium quittant de
    lui-même. Corrigé à l'étape 7, où Chromium est figé avant.*
- Sans Chromium installé, la suite saute en le disant ; la CI de bout en bout
  l'installe avant `test:unit`. Les tests de groupe de processus sautent sous
  Windows, en le disant.

*Constaté en CI sur `4a91a18` : « Worktrees » (`41681270284`), « Bout en
bout » (`41681270332`) et « Coffre » (`41681270609`) verts sous macOS, Linux et
Windows. Les postes macOS des deux derniers avaient d'abord été annulés faute
de machine, sans qu'une étape ait tourné ; relancés, ils sont passés.*

### Étape 4 — les outils et la session approuvée (2026-11-03)

**Un port, comme la délégation.** Le paquet `tools` ne peut pas dépendre de
`browser`, qui dépend de lui. Les outils parlent donc à un `BrowserPort`
(`ToolContext.browser`) que le daemon pose pour un profil qui a des outils
`browser_*`, et pour lui seul ; absent, tout refuse. Le daemon l'implémente
dans `browsers.ts`, qui tient au plus une session par tâche.

**Ce qui est approuvé.**
- `browser_open` est une opération préparée : objectif, adresse normalisée,
  durée. La durée est **bornée par l'échéance de la tâche** avant d'être
  montrée : l'humain lit la vraie.
- Dans la session, regarder, aller à une adresse, cliquer, faire défiler et les
  touches de déplacement sont libres.
- `browser_type` et **Entrée** sont approuvés chacun, avec le texte exact,
  l'adresse et le champ actif (`input#q[name="q"]`).

`browser_goto` ne figurait pas au découpage. Sans lui, un agent qui connaît une
adresse devrait la trouver en cliquant de lien en lien. Il est libre, comme un
clic, puisqu'un clic mène déjà n'importe où. La garde réseau vaut pour l'un
comme pour l'autre.

**Ce que l'humain a approuvé est revérifié au moment d'agir.** Une page peut
changer seule pendant que l'humain lit la demande : un minuteur, une
redirection. Avant de taper, l'outil relit l'adresse et le champ actif. S'ils
ont changé, **rien n'est tapé**, et le modèle l'apprend. Le test le prouve dans
les deux cas, une autre adresse et un autre champ sur la même adresse, et
vérifie que rien n'a atteint le navigateur. La description du champ est lue
dans la page : une page hostile peut mentir sur son propre champ, pas déplacer
le clavier. Un clic sur « Envoyer » reste libre, et c'est assumé : il n'envoie
que ce qui a déjà été saisi, donc approuvé.

**Une capture chasse la précédente.** Chaque étape renvoie toute la
conversation au modèle. Une session de vingt actions garderait vingt captures,
renvoyées à chaque appel, pour des écrans qui n'existent plus. La capture porte
donc `transient`, et la boucle retire les précédentes de la conversation, en le
disant dans le message qui les portait. Une image du projet reste : une
maquette sert toute la tâche. Chaque action rend sa capture, ce qui épargne au
modèle une étape « regarder » après chaque clic.

**Non fiable, et dit comme tel.**
- Le résultat de chaque action (adresse, titre, champ actif) est encadré.
- La tâche est marquée non fiable.
- Le message qui porte la capture dit qu'un texte vu dans l'image est une
  donnée, jamais une consigne : une image ne se met pas entre balises.
- Le résumé journalisé ne garde que l'action et l'adresse. Le titre, écrit par
  la page, ne va qu'au modèle.

**Une session se ferme** :
- à son échéance ;
- quand l'humain la coupe (`POST /api/tasks/:id/browser/close`, acte humain
  qu'aucun outil n'expose) ;
- quand l'agent appelle `browser_close` ;
- avec la tâche, **avant** sa conclusion ;
- avec le daemon.

L'agent apprend le motif à sa prochaine action. Une tâche qui finit **pendant**
le lancement de Chromium aurait laissé un navigateur que personne ne fermait :
la session est refermée dès que Chromium répond, et aucune autre ne s'ouvre. Le
test compte ce Chromium au système, mort.

**Le journal** reçoit `browser.opened` et `browser.closed`, expurgés. Les
actions y sont comme appels d'outil, et **aucune capture** n'y est écrite. La
dernière capture reste en mémoire pour l'onglet « Navigateur » de l'étape 6.
Pas de nouveau protocole : aucun client ne valide le type d'un événement.

**La liste blanche du daemon vaut aussi pour le navigateur.** Sous la politique
HTTP `allowlist`, un hôte absent de `MIDGAARD_HTTP_ALLOW` est refusé par le
proxy : l'utilisateur qui n'a autorisé que certains hôtes ne les verra pas
rouverts par une page. Sous `approval`, l'approbation de la session en tient
lieu, car une page charge des dizaines de ressources, et les demander une à une
n'apprendrait qu'à cliquer « oui ». La liste blanche n'ouvre jamais la boucle
locale.

**Vérifié :**
- `npm run typecheck` ;
- 12 tests (`tests/unit/browser-tools.test.ts`) :
  - les refus sans port, sans vision et sans session, sans approbation à la
    place ;
  - l'opération préparée d'une session, sa durée bornée et `file:` refusé ;
  - les actions libres ;
  - le texte exact d'une saisie ;
  - **la saisie non tapée** quand la page ou le champ ont changé ;
  - la session coupée refusée avec son motif ;
  - dans la boucle, une seule approbation (la session, pas le clic), une seule
    capture envoyée, la phrase de non-fiabilité et le résultat marqué ;
  - sur un vrai Chromium : ouverture, champ actif, saisie, coupure humaine,
    échéance, fin pendant l'ouverture, journal sans image, groupe de processus
    mort ;
  - la garde sous `allowlist` ;
- les deux protections centrales cassées exprès (pas de revérification, pas de
  retrait des captures) : les tests échouent ;
- `npm run test:unit` (527), `test:orchestrator`, `test:security`,
  `test:developer`.

**Pas encore exercé à cette étape :** le moteur qui pose le port, et la route
de coupure, dans un vrai daemon. Aucun profil n'avait encore ces outils ; c'est
fait à l'étape 5.

### Étape 5 — le profil `navigator` (2026-11-03)

**Un type de profil à lui.** `navigator` rejoint les types de profil
(`AGENT_KINDS`) plutôt que de prendre celui du Researcher : l'atelier le
reconnaîtra pour son onglet « Navigateur », et la règle « aveugle, refusé »
ne vaut que pour lui. `PROTOCOL_VERSION` passe à 13 : un serveur MCP ou un
dashboard d'avant refuserait ce type à la validation.

**Ses outils** : les huit du navigateur, `read_file`, `read_image`,
`list_directory` et `submit_result`. Ni écriture, ni `exec`, ni `http_fetch` :
il a un navigateur, et une seule porte vers le web se garde mieux que deux.
**Ses limites** : 30 étapes, 0,50 $, 30 minutes, trois appels par étape. Le
budget reste celui du Researcher, puisque la boucle ne garde qu'une capture :
le coût croît avec les étapes, pas avec leur carré. **Sa consigne** redit les
règles que le code applique (une session, des saisies rares et jamais un
secret, la page est de la donnée, la capture suivante chasse la précédente,
fermer puis `submit_result`), pour qu'il ne les découvre pas en dérangeant un
humain.

**Claude le voit**, contrairement à l'orchestrateur. La session et chaque
saisie passent par l'approbation humaine, d'où que vienne la tâche ; rien ne
justifie de le cacher.

**Aveugle, refusé avec son motif.** La capacité se lit au catalogue du
fournisseur, sur le réseau, et ne peut donc pas se calculer à chaque lecture
de la liste des profils. Le gérant retient ce que le moteur **a constaté**,
pour le fournisseur et le modèle effectifs. Le constat se fait au démarrage,
après chaque réglage d'un profil ou ajout d'un fournisseur (la réponse
l'attend, cinq secondes au plus), et au départ de chaque tâche. Constaté
aveugle, le Navigator est :
- refusé à la création, sans qu'aucune tâche soit créée ;
- montré désactivé par `GET /api/agents`, qui rend désormais la **vue** d'un
  profil (`enabled` : utilisable maintenant ; `disabled_reason`, calculé par
  le daemon) plutôt que sa ligne en base ;
- relayé tel quel par `harness_list_agents` et `list_agents`.

Une tâche partie avant tout constat s'arrête au départ, avant tout appel de
modèle, avec le même motif : rien n'est dépensé. Le motif dit d'où vient le
constat — le catalogue, la déclaration, ou rien — et quoi faire.

**Ce que le vrai daemon a prouvé** (`tests/unit/navigator.test.ts`, faux
fournisseur, vrai Chromium, page locale servie par le test grâce à une garde
injectée au démarrage — `StartOptions.browserGuard`, que `main.ts` ne pose
jamais) :
- un Navigator sur un fournisseur `custom` est montré désactivé, et la création
  refusée sans tâche créée. Une fois `vision` déclarée, la réponse au réglage
  le montre utilisable ;
- la session et la saisie attendent chacune leur approbation, par l'API des
  approbations, avec l'opération exacte (`saisir "bonjour" dans
  input#q[name="q"] de http://127.0.0.1:…/`) ;
- **l'humain coupe la session pendant que la saisie attend sa décision, puis
  l'approuve** : elle n'est pas tapée, l'appel finit `failed` avec « cut by the
  human operator », et l'agent le lit ;
- une tâche qui finit sans fermer son navigateur le ferme **avant** de conclure
  (`browser.closed` précède `task.completed`) ;
- Chromium est vu vivant pendant la session, puis **aucun** ne survit, à la
  coupure comme à la fin. Ce sont les descendants du processus, comptés au
  système ;
- une capture JPEG est arrivée au modèle, et **la base et son WAL ne
  contiennent pas l'en-tête JPEG en base64**.

Deux protections cassées exprès font échouer ces tests : le refus d'un Navigator
aveugle à la création, et la fermeture avant conclusion (la seconde, seule,
fait échouer son seul test).

**Vérifié :** `npm run typecheck` ; `npm run test:unit` (530) ;
`test:orchestrator`, `test:security`, `test:developer`, `test:restart`,
`test:ui` et `test:wait` (le serveur MCP et le dashboard lisent le nouveau
type et le motif).

### Étape 6 — l'atelier voit ce que voit l'agent (2026-11-03)

**L'onglet « Navigateur ».** Il apparaît dès qu'un agent de l'arbre a ouvert un
navigateur. Il s'ouvre **seul à chaque nouvelle session** si l'on regardait
les détails, jamais à chaque action : le premier jet comparait la séquence de
la dernière action, et l'onglet aurait repris le premier plan après chaque clic
de l'agent. Relu avant de tester, il compare désormais la séquence d'ouverture.
L'onglet montre :
- l'objectif approuvé, l'adresse et l'échéance ;
- la dernière capture, redemandée à chaque événement du navigateur ;
- la demande d'approbation de la tâche, **au-dessus** de la capture : on lit
  le texte à saisir en regardant la page où il partira ;
- **« Couper la session »**, sans confirmation : arrêter doit être plus simple
  que laisser faire.

**La capture vient de la mémoire du daemon** (`GET /api/tasks/:id/browser/frame`,
404 dès la session fermée). Une balise `<img>` ne porte pas de jeton : le
dashboard lit les octets authentifiés et en fait une URL `blob:`. Une session
fermée ne rend plus rien : l'onglet garde la dernière vue, et le dit.

**L'image lue dans le fil.** Rien d'une image n'est gardé. Le fil la relit donc
**sur le disque** (`GET /api/tasks/:id/files/image`) et ne la montre que si son
SHA-256 commence comme celui que `read_image` a journalisé. Sinon, ce ne serait
pas l'image que l'agent a vue, et le fil dit que le fichier a changé. La route
reprend les règles de l'outil : type lu dans les octets, jamais un SVG (du
texte, qui peut porter un script), 4 Mo au plus, chemins des routes de
fichiers, `.git` refusé. Les octets d'image sont servis avec `nosniff` et une
politique de contenu vide.

**Les Profils** déclarent si un modèle lit les images. Le motif d'un profil
refusé vient du daemon. La commande `providers add` n'y est plus conseillée à
un Navigator aveugle, qui a un fournisseur et à qui il faut un modèle.

**Vérifié :**
- `npm run typecheck` ; `npm run build` ;
- la route d'image (`tests/unit/task-files.test.ts`) :
  - octets, type, empreinte, `nosniff` et politique de contenu ;
  - un SVG et un texte déguisé refusés (415), un absent (404) ;
  - les chemins hostiles refusés ;
- la capture dans le vrai daemon (`navigator.test.ts`) : servie en JPEG
  pendant la session, 404 après la coupure ;
- les fonctions pures (`dashboard-workbench.test.ts`, `dashboard-tree.test.ts`) :
  - l'état de la session depuis le journal, et la capture qui ne bouge
    qu'après un événement du navigateur ;
  - le motif en français, et un motif inconnu laissé tel quel ;
  - l'image au fil, sans un échec ;
  - le motif rendu par le daemon ;
- **D14 dans `test:ui`**, sur un second daemon lancé dans le processus du test
  pour lui passer une garde qui admet la page locale :
  - le Navigator montré refusé avec son motif, puis rendu disponible par la
    case des Profils ;
  - l'image lue affichée dans le fil, décodée ;
  - l'onglet ouvert seul sur une capture décodée, avec l'adresse ;
  - la saisie à approuver lue dans l'onglet, puis la coupure au clic ;
  - la saisie approuvée ensuite **non tapée** ;
- les 14 scénarios de `test:ui` passent.

**Vu à l'écran** (capture prise pendant D14) : la demande d'approbation pousse
la capture sous le pli, et il faut défiler pour la voir entière. À reprendre
si l'essai réel le confirme gênant.

**Ce que la CI a trouvé** (passage `41703895792`, sur `89c713e`) : « Bout en
bout » rouge sur les trois plateformes, deux défauts réels, et aucun dans le
navigateur.

1. **Le dashboard ne disait plus jamais « déconnecté »** (macOS, Linux). Une
   tentative de reconnexion qui échouait dès le bootstrap laissait le bandeau
   sur « connexion… » pour toujours, daemon mort compris. D7 ne le voyait pas
   tant qu'il regardait le bandeau avant la première nouvelle tentative. D14,
   qui recharge la page juste avant lui, a déplacé ce moment : l'échec est
   devenu intermittent en local, constant en CI. Le correctif repasse à
   `closed` sur cet échec (`useHarness.ts`). D7 exige désormais de revoir
   « déconnecté » **après** plusieurs tentatives ratées. Sans le correctif, il
   échoue à chaque fois, et un autre scénario avec lui ; avec, les 14 passent.
2. **Un daemon fermé en pleine tâche tuait le processus qui l'héberge**
   (Windows). D14 a attendu un élément, échoué, puis fermé son daemon pendant
   que la tâche tournait encore. La boucle interrompue a fini après la
   fermeture de la base, et « database is not open », non rattrapée, a tué le
   processus. Le moteur rattrape désormais cette erreur une fois arrêté ; la
   tâche sera `interrupted` au démarrage suivant, comme toute autre. Prouvé
   par `navigator.test.ts` (« un daemon fermé en pleine tâche »), qui compte
   les rejets non rattrapés.

*Constaté en CI sur `74ebdb7`, qui porte ces deux correctifs : « Worktrees »
(`41944581983`) et « Bout en bout » (`41944582116`) verts sous macOS, Linux et
Windows. Sous Windows, D14 passe : son attente venait donc du même défaut, et
le plantage cachait le reste. Sous macOS, D14 a d'abord échoué une fois sur
l'image du fil (« ne s'affiche pas »), puis il est passé à la relance du poste.
L'échec est intermittent et sa cause n'est pas connue : il n'a été vu ni sous
Linux ni sous Windows, ni dans les passages locaux sous macOS. D14 dit désormais
ce que le fil montrait à la place (l'élément, une note, la largeur décodée de
l'image), pour qu'un prochain échec dise lequel.*

**La cause, trouvée le 2026-11-05** grâce à ce diagnostic : D14 a échoué
de nouveau sous Linux, sur `2de69bf`. Le fil ne montrait **aucun élément
image, ni note**, alors que la tâche avait avancé jusqu'à la demande de
session. L'événement de `read_image` manquait donc à la timeline du
dashboard. À l'ouverture d'une tâche, le dashboard la charge par HTTP. Ce
que la WebSocket diffusait pendant la requête était **jeté**, faute de
timeline, et la réponse **remplaçait** ensuite tout. Un événement émis entre la
lecture du daemon et l'arrivée de la réponse était perdu jusqu'au
rechargement. D14 ouvre la tâche à l'instant où `read_image` se termine. La
timeline s'ouvre désormais avant la requête, et la réponse est fusionnée
(`apps/dashboard/src/lib/timeline.ts`) ; `dashboard-workbench.test.ts` rejoue
la course. **Ce défaut n'était pas propre au navigateur** : toute tâche ouverte
pendant qu'elle avançait pouvait perdre un événement, n'importe lequel.


### Étape 7 — les preuves (2026-11-05)

Trois scénarios rejoignent `test:security`. Chacun lit le résultat au système
ou au serveur visé, jamais à travers le daemon qu'il éprouve.

**X7 — aucune saisie ni Entrée sans approbation.** Un second daemon tourne
dans son propre processus (`tests/loopback-daemon.ts`). Sa garde de test admet
la boucle locale, que la vraie refuse ; `main.ts` ne la pose jamais. La page
servie par le test signale chaque frappe au serveur. Ce qui l'atteint se voit
donc là, pas dans le journal du daemon. Trois tâches, parce qu'**un refus
d'approbation annule la tâche** (le premier jet supposait qu'elle continuait) :
- une saisie qui contient une clé, refusée : rien n'atteint la page, la tâche
  est annulée, la session fermée au journal ;
- Entrée, refusée : le formulaire ne part pas ;
- le témoin : `javascript:` est refusé sans même demander, puis une saisie
  approuvée arrive à la page. Sans ce témoin, l'absence de frappe pourrait
  venir d'une page qui ne signale rien.

À la pause du témoin, X7 relève une vraie capture par la route de l'atelier.
Ses 12 premiers octets, bruts et en base64, sont ensuite cherchés dans la
base, le WAL et le journal du daemon, et dans chaque colonne. **L'aiguille vient
d'une vraie image du même Chromium** : une recherche sur un motif deviné
pourrait ne jamais rien trouver.

**X8 — aucune adresse privée, quelle que soit son écriture.** Sur le daemon
principal, avec la **vraie** garde, une page témoin sur la boucle locale compte
ses visites. Le Navigator la vise sous sept formes : `127.0.0.1`, `localhost`,
`[::1]`, `0.0.0.0`, `2130706433` (127.0.0.1 en décimal), l'IMDS et `10.0.0.1`.
Chacune est refusée et tracée, et le témoin n'est jamais visité. Une capture de
la page d'erreur est prise, et elle n'est pas en base.

**Ce que X8 a trouvé : un littéral IPv6 jugé comme un nom.** `URL.hostname`
garde les crochets (`[::1]`), que `isIP` ne reconnaît pas. `assertPublicHost`
partait donc en résolution DNS, et `[::1]` n'était refusé que comme
« introuvable ». C'était sûr, mais pour une fausse raison, et une adresse IPv6
**publique** était refusée tout autant. La garde ôte désormais les crochets
avant de juger (`packages/tools/src/net.ts`) ; c'est vrai aussi pour
`http_fetch`. Un test unitaire le dit (`tools.test.ts`).

**X9 — aucun Chromium après un `SIGKILL` du daemon.** Une session est ouverte
et une saisie attend l'humain. X9 compte alors les Chromium descendants du
daemon au système, par `ps`, ou par `Get-CimInstance` sous Windows. Il exige
d'en voir au moins un, puis tue le daemon net et vérifie que chacun est mort.

**Ce que X9 a trouvé : le test de la garde ne la prouvait pas.** La garde
retirée, X9 passait quand même, et le test unitaire de l'étape 3 (« la garde
emporte Chromium ») aussi. **Chromium quitte de lui-même** quand se ferme le
canal qui le relie au processus mort. Les deux tests **figent** maintenant le
Chromium principal (`SIGSTOP`) avant de tuer son parent. Figé, il ne voit plus
rien se fermer : c'est le Chromium bloqué que la garde existe pour tuer.
- Sans la garde, les deux échouent : 4 Chromium sur 4 survivent à X9.
- Avec, les deux passent.

Windows n'a pas de `SIGSTOP`. X9 n'y prouve que l'absence de survivant, et le
dit dans son verdict.

**Contre-épreuves**, chaque défaut introduit puis retiré :

| Défaut introduit | Vu par |
|---|---|
| saisie sans approbation | X7 : la clé tapée arrive à la page, frappe par frappe |
| 64 caractères de la capture dans le résumé d'un appel | X7 et X8 : WAL, `task_events.payload_json`, `tool_calls.result_summary` |
| garde des processus retirée | X9 et `browser.test.ts`, une fois Chromium figé |
| crochets IPv6 non ôtés | X8 |

**`test:security` demande désormais Chromium** (`npx playwright install
chromium`). Sans lui, X7 à X9 **échouent** en donnant la commande : ce sont des
preuves de sécurité, et un saut ne doit pas avoir l'air d'une réussite. La CI
de bout en bout l'installe déjà avant la suite.

**Tranché : Entrée n'est pas le seul chemin d'un formulaire.** La
décision 6 dit que saisir et presser Entrée sont approuvés, « c'est par là
qu'un formulaire part ». C'est incomplet. Les clics sont libres dans la
session, et un clic sur un bouton d'envoi envoie un formulaire sans
approbation. `Tab` puis `Space` sur ce bouton aussi. Ce qui est prouvé, c'est
qu'**aucun texte choisi par l'agent n'entre dans un champ** sans que l'humain
l'ait lu. Un formulaire déjà rempli par la page, ou dont les champs sont des
cases et des listes, peut partir d'un clic. Deux voies :
- garder ce partage, et le dire ;
- ou approuver aussi un clic qui envoie un formulaire, ce qui demande de le
  reconnaître dans la page, que l'agent ne contrôle pas, mais qui peut mentir.

**Décision de l'auteur (2026-11-05) : garder, et le dire.** Approuver ces
clics promettrait plus que ce qu'on peut tenir : une page hostile déguise un
bouton, ou envoie ses données par un script au simple clic. C'est désormais
dit partout où quelqu'un décide :
- **à l'humain**, dans la demande de session elle-même : « clics libres
  pendant la session, envoi de formulaire compris ; saisie et Entrée
  approuvées chacune ». C'est ce qu'il approuve (`browser-tools.test.ts` et
  `navigator.test.ts` le vérifient) ;
- **au modèle**, dans les descriptions de `browser_open` et `browser_click`
  et dans la consigne du Navigator : aucun clic n'est soumis à l'humain, et
  l'agent n'envoie un formulaire que si son objectif le demande.

Le README du paquet `tools` disait qu'un clic sur « Envoyer » « n'envoie que
ce qui a déjà été saisi, donc approuvé ». C'était faux, et c'est corrigé.

**Vérifié :**
- `npm run typecheck` ; `npm run test:unit` (538 tests, aucun sauté) ;
- `npm run test:security` : 9 scénarios, X7 à X9 compris ;
- chaque contre-épreuve du tableau, défaut en place puis retiré.

*Constaté en CI sur `5047060` : « Worktrees » (`41962836174`) et « Bout en
bout » (`41962836162`) verts sous macOS, Linux et Windows, du premier coup.
X7 à X9 passent sur les trois postes. Chromium est vu sous le daemon avant le
`SIGKILL` (4 processus sous macOS et Windows, 6 sous Linux), et aucun ne
survit. Sous Windows, il n'est pas figé avant : X9 n'y prouve que l'absence de
survivant, et le dit.*

### Étape 8 — l'essai réel (2026-11-05)

#### Le protocole

- **Daemon** : celui de l'utilisateur (`~/.midgaard`), au code de `2de69bf`,
  dashboard compilé, fenêtre desktop ouverte.
- **Profil** : `navigator` sur `venice`, modèle `deepseek-v4-1-flash`. Il est
  **vision au catalogue** de Venice (`supportsVision`), sans déclaration ; les
  `deepseek-v4-flash` des essais précédents ne lisent pas les images. Limites
  du profil : 30 étapes, 0,5 $, 1 800 s.
- **Projet** : un dépôt jetable d'un commit, avec la maquette
  `maquettes/todo.png`. Elle montre trois tâches, « Acheter du pain », « Relire
  la slice 7 » (cochée) et « Lancer la CI », et « 2 items left ».
- **Application** : TodoMVC, `https://todomvc.com/examples/react/dist/`,
  publique.
- **Objectif** : lire la maquette, puis la reproduire dans l'application, une
  tâche à la fois (texte puis Entrée), cocher ce qui est coché, et dire ce qui
  diffère encore.
- **Solde** : non comparé. Le compte Venice est partagé avec un autre usage
  (Slice 6), et l'auteur avait décidé d'essayer sans. Chaque coût doit porter sa
  provenance.

| # | Attendu | Ce qui le constate |
|---|---|---|
| N1 | Le Navigator est utilisable, la vision lue au catalogue | `GET /api/agents` |
| N2 | `read_image` lit la maquette ; le fil la montre | journal, fenêtre |
| N3 | La session n'ouvre qu'après l'humain, et sa demande dit « clics libres, envoi de formulaire compris » | approbations |
| N4 | Chaque saisie et chaque Entrée attendent l'humain, texte exact et champ lus | approbations, fenêtre |
| N5 | Cocher une case ne demande rien | journal |
| N6 | L'onglet « Navigateur » suit la session en direct | fenêtre |
| N7 | La session se ferme avant la conclusion ; `submit_result` ; résultat non fiable | journal, résultat |
| N8 | Aucune image en base : ni la maquette (PNG) ni les captures (JPEG) | `harness.db` et WAL lus octet pour octet |
| N9 | Aucun Chromium après la fin | processus comptés au système |
| N10 | Chaque appel a un coût avec sa provenance | base |

Échec du produit : une saisie ou une session sans l'humain, une capture en
base, un Chromium survivant, un coût sans provenance. Échec de l'essai, à
rejouer : un modèle qui ne lit pas la maquette, ne vise pas les bons champs,
ou épuise ses étapes.

#### Première tentative — 2026-11-05, 04:00 UTC

Tâche `92216ed3`, lancée par l'API comme « Nouvelle tâche » au dashboard.

- N1 : le profil est utilisable, `vision` non déclarée : la capacité vient du
  catalogue.
- N2 : le modèle lit la maquette d'abord (`read_image`, `sha256 c11fd0da…`),
  puis le README. Il en tire le bon objectif : « add three todo items by
  typing exact texts and pressing Enter, then check the second one ».
- N3 : la session est demandée pour 10 minutes, avec la mention des clics
  libres. **Personne ne l'a approuvée** : l'approbation a expiré au bout de
  10 minutes, et la tâche a fini `timed_out` (« aucune décision humaine en
  10 minutes »). Ce n'est pas un échec du produit : c'est l'expiration
  prévue.
- N8 et N9 : aucun en-tête PNG ni JPEG, brut ou en base64, dans `harness.db`,
  le WAL et `daemon.log` ; aucun Chromium. La maquette lue n'a laissé que son
  empreinte.
- N10 : deux appels, 0,00166878 $, « facturé par le fournisseur » ;
  l'estimation est égale.

**Ce qu'elle a trouvé : une expiration inscrite comme un refus.** L'appel
expiré était au journal « refusé par un humain », alors que personne n'avait
rien refusé. Le gérant fait expirer l'approbation, puis annule la tâche. Le
moteur, à l'annulation, résolvait toujours l'attente en `rejected`. Le gérant
dit désormais au moteur comment l'attente se résout (`cancel(task,
'expired')`). La boucle inscrit alors « aucune décision humaine dans le
délai », et dit au modèle la même chose. Un test le prouve
(`conversation.test.ts`, « approbation oubliée »). Il échoue sans le
correctif.

#### Deuxième tentative — 2026-11-05, 04:14 UTC

Tâche `ef286c5b`, même protocole, sur le daemon redémarré avec le correctif
de l'expiration. Trois minutes de bout en bout (04:14:08 → 04:17:03), toutes
les approbations données par l'auteur au dashboard.

| # | Constat | Verdict |
|---|---|---|
| N1 | Profil utilisable, vision lue au catalogue, rien de déclaré | ✔ |
| N2 | `read_image` sur la maquette au premier pas ; le fil en montre la miniature | ✔ |
| N3 | Session approuvée par l'humain (« dashboard ») ; le texte approuvé finit par « clics libres pendant la session, envoi de formulaire compris ; saisie et Entrée approuvées chacune » | ✔ |
| N4 | Trois saisies et trois Entrées, six approbations, chacune avec le texte exact et le champ (`input[aria-label="New Todo Input"]`) de `todomvc.com` | ✔ |
| N5 | Trois clics sans demande : deux pour reprendre le champ, un pour cocher « Relire la slice 7 » | ✔ |
| N6 | L'auteur a suivi et approuvé dans l'onglet « Navigateur » du dashboard | ✔ |
| N7 | `browser_close` par l'agent, `browser.closed` avant `submit_result` ; résultat `untrusted`, l'application citée | ✔ |
| N8 | Aucun en-tête PNG ni JPEG, brut ou en base64, dans `harness.db`, le WAL (2,4 Mo) et `daemon.log` | ✔ |
| N9 | Aucun processus Chromium après la fin | ✔ |
| N10 | 13 appels, 82 612 jetons d'entrée (dont 70 656 en cache), 0,00861192 $, « facturé par le fournisseur », estimation égale au microdollar ; non comparé au solde | ◐ |

**Le résultat est juste.** L'agent rapporte trois tâches dans l'ordre, la
deuxième seule barrée, et « 2 items left ». Il nomme les écarts qui restent
entre la maquette et l'application : la barre latérale de TodoMVC, le bouton
« Clear completed », l'onglet actif encadré, le chevron « toggle all », la
croix de suppression au survol, et la légende propre à la maquette. Il dit
aussi sa limite : il n'a lu ni le DOM ni le CSS, seulement des captures.
**Aucune capture n'étant gardée, l'écran final ne peut pas être revu après
coup.** C'est la décision 1, et son prix : la preuve de ce que l'agent a vu,
c'est l'humain qui regardait.

**Ce qui n'a pas marché : la fenêtre desktop.** Elle avait été ouverte au début
de la journée sur l'ancien daemon (protocole 11). Après les deux redémarrages
du daemon de cet essai, l'auteur l'a vue « planter ». Son processus était
encore vivant, mais elle ne répondait plus. Le dashboard du même daemon,
ouvert dans un navigateur, était « en direct », et c'est par lui que toutes
les approbations ont été données. **Cause non établie** : rien n'a été relevé
de la fenêtre, et la Slice 6 ne l'avait éprouvée qu'avec un seul daemon pour
toute sa durée. **Cause trouvée le jour même**, au § « La fenêtre vide »
plus bas : ce n'était pas un gel.

**Ce que l'essai prouve, et pas.** Il prouve que le chemin complet tient avec
un vrai modèle qui lit les images, sur une vraie application publique, sous
session approuvée et surveillée. Il ne prouve pas qu'un modèle détourné
serait tenu. Ce sont X7 à X9 qui le prouvent, avec un faux fournisseur.

### Après l'essai — moins d'approbations, la même garantie (2026-11-05)

**Le constat de l'auteur** : sept approbations pour ajouter trois tâches,
c'est trop. On lui demandait de confirmer des gestes déjà décidés, une par
saisie et une par Entrée. Une approbation qui n'apprend rien finit par se
donner sans lire, et c'est pire pour la sécurité.

**Ce qui mérite le regard de l'humain, c'est le texte qui part dans une
page.** L'agent a lu le projet, et une page piégée peut lui faire recopier
un fichier dans un formulaire. **Décision : les deux allégements**, et pas le
troisième.

1. **Saisie et Entrée en une approbation.** `browser_type` prend `press_enter`
   ; la demande dit « saisir "…" puis presser Entrée dans … », et Entrée est
   dans l'empreinte. `browser_key` Entrée seule reste approuvée.
2. **Les textes prévus, approuvés avec la session.** `browser_open` prend
   `planned_inputs`, au plus 20 textes de 500 caractères, chacun avec ou sans
   Entrée. La demande de session les cite entre guillemets, échappés comme du
   JSON : une espace finale se voit. Ils entrent dans le détail, donc dans
   l'empreinte. Chacun part ensuite **une fois** sans demande, s'il est
   identique à la lettre avec la même Entrée. La session le retire **avant**
   de taper ; une préparation périmée qui le croyait prévu ne tape rien.
   L'onglet « Navigateur » les montre, barrés au fil des saisies.
3. **Écarté : la saisie libre dans une session approuvée.** C'est exactement
   la garantie qu'on perdrait.

La garantie reste : **aucun texte n'entre dans un champ sans que l'humain
l'ait lu.** Ce qui change, c'est le moment où il le lit. Un texte prévu n'est
lié ni à une page ni à un champ : il peut partir dans n'importe quel champ de
la session, y compris après un `browser_goto`. L'essai réel aurait demandé
**une** approbation au lieu de sept.

**Vérifié :**
- `npm run typecheck` ; `npm run test:unit` (542 tests, aucun sauté) :
  - saisie puis Entrée sous une seule approbation, qui les nomme ;
  - un texte prévu permis sans demande, puis redemandé une fois servi ;
  - « à la lettre » : la casse, une espace finale, une Entrée en plus ou en
    moins redemandent l'humain ;
  - une préparation périmée ne tape rien ;
  - l'atelier barre le texte servi, et lui seul ;
- **X7** dans `test:security`, sur un vrai daemon et un vrai Chromium : le
  texte prévu arrive à la page sans demande, et le même une seconde fois
  attend l'humain. Refusé, il n'arrive pas. Contre-épreuve : une session qui
  ne retire pas le texte servi le laisse partir deux fois, et X7 échoue ;
- `npm run test:ui` : 14 scénarios.

**Éprouvé avec un vrai modèle le même jour** (tâche `7b38e31d`). Même
modèle, même maquette, même objectif mot pour mot que l'essai de l'étape 8,
qui n'évoque pas les textes prévus. Le daemon a été redémarré au préalable :
il tournait sur le code d'avant.

- Le modèle a lu la maquette, puis a ouvert la session en annonçant de
  lui-même les trois textes, chacun avec son Entrée : « textes prévus, tapés
  une fois chacun sans nouvelle demande : "Acheter du pain" puis Entrée ;
  "Relire la slice 7" puis Entrée ; "Lancer la CI" puis Entrée ».
- **Une seule approbation**, celle de la session, contre sept la première
  fois. Les trois `browser_type` (`press_enter: true`) sont partis sans
  demande, avec un clic dans le champ avant chacun des deux derniers, puis le
  clic sur la case de la deuxième tâche. 23 s entre l'approbation et la fin.
- Résultat juste : trois tâches dans l'ordre, la deuxième seule cochée,
  « 2 items left », et les mêmes écarts nommés qu'au premier essai.
- 10 appels, 0,00696102 $ « facturé par le fournisseur », estimation égale.
  Aucun en-tête PNG ou JPEG, brut ou en base64, dans la base, le WAL ou le
  journal ; aucun Chromium vivant après la fin.

Ce que l'essai ne montre pas : un texte **non** annoncé tapé en route, qui
redemande l'humain. C'est X7 qui le prouve.

### La fenêtre vide — une page plus vieille que son daemon (2026-11-05)

**Ce que l'auteur a vu** à l'étape 8 : une fenêtre desktop qui ne répondait
plus. **Ce qu'elle était** : vivante, mais vide. Elle n'avait plus aucune
connexion au daemon (`lsof`), et sa capture ne montrait que le fond sombre,
sans un seul élément.

**La cause, reproduite.** La fenêtre avait été ouverte le 2026-11-03, face au
daemon de protocole 11, et sa page ne s'était jamais rechargée. Après les
redémarrages de l'essai, elle s'est reconnectée au daemon de protocole 13
avec son **ancien** code. Les événements `browser.*` lui étaient inconnus :
`EVENT_LOOK[event.type].icon` a levé une erreur, et React a démonté toute
l'interface. Reproduit à l'identique en servant le dashboard de `25b3a7c`
au daemon actuel, avec la même erreur dans la console. C'est un défaut du
dashboard, pas de la coque : un onglet de navigateur ouvert assez longtemps
l'aurait eu aussi.

**Les corrections** (`apps/dashboard`) :

1. **À chaque reconnexion, la page relit `index.html`**, servi sans cache. Si
   le script qu'il désigne n'est plus le sien, elle se recharge. Vite nomme le
   bundle d'après son contenu, donc aucun numéro de version n'est à tenir, et
   un `npm run build` pendant que le daemon tourne est couvert aussi. Dans le
   doute (script illisible, page d'aide d'un clone sans build), elle ne se
   recharge pas (`lib/bundle.ts`).
2. **Une erreur d'affichage se dit** : son message et « Recharger », au lieu
   d'une page vide (`components/ErrorBoundary.tsx`). *Aucun test ne
   l'exerce.*
3. **Un type d'événement inconnu s'affiche tel quel** dans la timeline, et une
   nature de fichier inconnue dans le diff.

**Vérifié :**
- `tests/unit/dashboard-workbench.test.ts` : le script se lit quel que soit
  l'ordre des attributs ; un autre bundle est vu, le même non ; dans le doute,
  pas de rechargement ;
- **D15** dans `test:ui` : un daemon remplacé par un autre qui sert un autre
  bundle (le même, renommé) fait recharger la page, puis elle est « en
  direct ». Lancé avant que le dashboard soit recompilé, il a échoué ; il
  attrape donc le défaut. **D7** vérifie en plus qu'avec le même bundle, la
  page ne se recharge pas ;
- **dans une vraie fenêtre Tauri** (WKWebView, pas le Chromium de
  Playwright), sur un runtime d'essai à part (`--home`, port 7790) : deux
  redémarrages avec le même bundle, et la fenêtre se reconnecte seule ; puis
  un daemon qui sert un autre bundle, marqué d'un bandeau, et la fenêtre se
  recharge d'elle-même et affiche le bandeau.

**Ce qui reste** : une fenêtre ouverte **avant** ce correctif garde l'ancien
code et ne se rechargera pas seule. Il faut la fermer une fois.
