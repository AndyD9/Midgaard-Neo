# `@midgaard/dashboard`

L'interface d'observation et de décision : la liste des tâches, l'inspecteur avec
sa timeline temps réel, et les boutons d'approbation. C'est aussi l'endroit
d'où l'on **lance** une tâche (Slice 5) — un orchestrateur en particulier.
Depuis la Slice 6, un **atelier** : conversation avec l'orchestrateur, fil des
échanges entre agents, terminal de sortie des commandes ; et une **vue
terminal**, qui rejoue tout l'arbre d'une tâche en lignes.
React + Vite + Tailwind, composants dans l'idiome shadcn/ui, recopiés dans
`src/components/ui/` ; xterm.js pour le terminal.

```bash
npm run build            # compile dans apps/dashboard/dist, servi par le daemon
npm run dashboard:dev    # serveur Vite avec rechargement à chaud
```

## Servi par le daemon, sur la même origine

En production, le daemon sert ces fichiers lui-même. C'est ce qui permet à ses
contrôles `Host` et `Origin` de rester stricts, sans CORS à ouvrir.

En développement, Vite sert la page sur son propre port et **relaie** `/api`,
`/ui` et `/events` vers le daemon, en réécrivant l'en-tête `Origin` : sans cela
le daemon verrait l'origine de Vite et refuserait, à juste titre. Le port du
daemon est lu dans son fichier de découverte au lancement de Vite — démarre le
daemon (`npm run harness -- start`) avant.

## Authentification

Le dashboard n'a aucun jeton au chargement. Il appelle `/ui/bootstrap`, route
sans jeton mais soumise aux contrôles d'enveloppe du daemon, et garde le jeton
**en mémoire** : ni `localStorage`, ni cookie, ni URL. Pour la WebSocket, le
jeton passe par le sous-protocole — l'API du navigateur ne permet pas de poser
un en-tête `Authorization`.

**Qui demande le jeton, et quand.** `api()` l'obtient lui-même s'il n'en a pas,
plutôt que de compter sur `useHarness`. Ce n'est pas une précaution de style :
React exécute les effets des **enfants avant ceux du parent**, donc `AgentsCard`
demandait ses données avant que `useHarness` n'ait seulement lancé le bootstrap.
Elle recevait deux `401`, son `catch` vide les avalait, et la carte — celle qui
existe pour dire à un nouveau venu qu'aucun fournisseur n'est configuré —
n'apparaissait **jamais** sur son écran d'accueil.

**Le jeton s'oublie à la fermeture de la WebSocket.** Il est régénéré à chaque
démarrage du daemon : le garder faisait réessayer sans fin avec une valeur
périmée, et la page restait « déconnecté » jusqu'à un rechargement manuel. Une
requête de plus à chaque reconnexion, contre une reconnexion qui n'aboutissait
jamais.

Les deux pannes ont été trouvées par `npm run test:ui`, pas par relecture.

**Une page plus vieille que son daemon se recharge** (`lib/bundle.ts`). Une
page reste ouverte plus longtemps que le daemon qui l'a servie, la fenêtre
desktop surtout. Remplacé par une version plus récente, le daemon parlait à
l'**ancien** code, qui recevait des données qu'il ne connaissait pas. Constaté
le 2026-11-05 : une fenêtre chargée face au protocole 11 a reçu les événements
`browser.*`, sa timeline a levé une erreur, et React a démonté toute
l'interface. Il ne restait que le fond, et l'auteur a cru à un gel. À chaque
reconnexion, la page relit donc `index.html`, servi sans cache. Si le script
qu'il désigne n'est plus le sien (Vite nomme le bundle d'après son contenu),
elle se recharge, et le fragment garde la tâche ouverte. Dans le doute, elle
ne se recharge pas.

Deux filets de plus. Une erreur d'affichage montre son message et
« Recharger » (`components/ErrorBoundary.tsx`), au lieu d'une page vide. Et un
type d'événement inconnu s'affiche tel quel dans la timeline.

## Reprise sans trou

C'est le point délicat du temps réel. Une WebSocket qui se rouvre naïvement
laisse un trou **invisible** : l'affichage paraît cohérent alors qu'il manque des
événements. Le dashboard mémorise donc la dernière séquence globale reçue et la
renvoie dans `?since=` ; le daemon répond par un instantané complet **et** les
événements manqués. Si l'écart est trop grand, il le dit (`truncated`) et le
bandeau l'affiche, au lieu de faire semblant.

Même logique pour la timeline d'une tâche : elle est chargée **entière** à
l'ouverture (`/api/tasks/:id/events`) puis tenue à jour en direct. On n'accumule
jamais les événements d'une tâche jamais ouverte : ce serait un historique
partiel silencieux, commençant au moment de la connexion.

Une timeline est **ouverte avant que sa requête parte**, et la réponse est
**fusionnée** avec ce que le direct y a mis entre-temps (`lib/timeline.ts`).
Remplacer perdait les événements émis entre la lecture du daemon et l'arrivée
de la réponse : une tâche ouverte juste après sa création pouvait ne jamais
montrer l'image lue par l'agent (Slice 7, D14 intermittent en CI). Une requête
qui échoue referme la timeline, plutôt que de laisser un historique partiel.

## Les types viennent de `@midgaard/contracts`

Uniquement les **types** : le point d'entrée du paquet charge des modules Node
(`node:os`, `node:fs`) qui n'ont pas leur place dans un paquet navigateur. Les
deux seules valeurs nécessaires — les sous-protocoles WebSocket — sont recopiées
dans `src/lib/useHarness.ts`, avec le commentaire qui le signale.

## Lancer une tâche, régler un profil (Slice 5)

Les routes, par le fragment d'URL : `#/tasks/<id>`, `#/new` (formulaire
« Nouvelle tâche »), `#/agents` (profils) et `#/terminal/<id>` (la vue
terminal, plus bas).

- **Le formulaire ne propose que des profils actifs**, et nomme les autres avec
  leur motif (`lib/agents.ts`, la même règle que le daemon). Il montre les
  limites du profil sans manette pour les relever, et pour un orchestrateur son
  **plafond théorique** de sous-tâches.
- **Le dossier de projet est vérifié par le daemon** (`checkProjectDir`) : il
  existe, c'est un dossier, ni `/` ni le dossier personnel. Le formulaire
  affiche le motif d'un refus tel quel. Le dernier dossier saisi est retenu
  dans le `localStorage` de ce navigateur — commodité de ce seul poste, qui ne
  porte rien de ce qui doit durer, et dont la page se passe.
- **La vue « Profils » règle le fournisseur et le modèle** de chaque profil,
  par `PATCH /api/agents/:id`, qui ignore des limites glissées dans son corps.
  *Depuis la Slice 8, les limites s'y règlent aussi*, par leur route à elles
  (`PUT /api/agents/:id/limits`), décision de l'auteur : un relèvement demande
  confirmation, un abaissement non (D18).
- **La carte « Fournisseurs » déclare un fournisseur et dépose sa clé**, sans
  terminal (`components/ProvidersCard.tsx`), par la route qu'emploie déjà la
  CLI (`POST /api/providers`) : le daemon n'a pas changé. La clé se saisit dans
  un champ masqué que le navigateur ne remplit ni ne retient, part dans le
  corps de la requête, est **effacée de l'état de la page dès l'envoi**, et ne
  revient jamais — la carte dit seulement « clé au coffre ». Elle teste dans la
  foulée, comme la CLI. Deux règles du formulaire (`lib/providers.ts`) : un
  fournisseur nouveau exige une clé, et **changer l'adresse ou le préréglage
  exige de la ressaisir** — sinon la clé du coffre partirait vers une adresse
  que l'humain n'avait pas en tête. Cette seconde règle est celle du
  formulaire, pas du daemon : la route, elle, accepte une adresse changée sans
  clé. Retirer efface la clé du coffre, et se confirme. Plusieurs clés d'un
  même fournisseur : un identifiant par clé. Prouvé par D20 (le faux
  fournisseur note la clé qu'il **reçoit**, donc relue au coffre) et par
  `tests/unit/dashboard-providers.test.ts`.
- **Les tâches sont un arbre** (`lib/tree.ts`) : chaque sous-tâche suit son
  orchestrateur, en retrait, dans l'ordre où il l'a déléguée. La carte
  « Sous-tâches » montre ce qu'il a délégué, celle qu'il attend (d'après le
  dernier `subtask.waiting`), le **total de l'arbre avec la plus faible
  provenance de ses termes**, et le plafond théorique. Une sous-tâche nomme
  son parent.

## Comment c'est vérifié

Deux niveaux, et le second a longtemps manqué :

- `tests/unit/dashboard-format.test.ts` couvre les **fonctions pures** de
  `src/lib/utils.ts` — montants, durées, dates — et
  `tests/unit/dashboard-tree.test.ts` celles de l'arbre : rangement, total et
  provenance, plafond, motif d'un profil désactivé. Aucun rendu.
- `npm run test:ui` (`tests/dashboard.ts`) ouvre un **vrai Chromium** sur un
  **vrai daemon** : l'application démarre, une tâche apparaît sans rechargement,
  la progression avance seule, une approbation donnée au clic débloque la tâche,
  un lien profond survit à un `F5`, et la perte **comme le retour** de la
  connexion se voient. Depuis la Slice 5 : le formulaire (D9), le choix du
  modèle (D10), et un orchestrateur lancé du formulaire jusqu'à son arbre
  (D11), sur un faux fournisseur. Depuis la Slice 7 : une page plus vieille
  que son daemon se recharge, et pas une page à jour (D15 et D7). Depuis la
  Slice 8 : les serveurs MCP aux Profils (D16) et l'exécutant créé par un
  orchestrateur, avec son rôle (D17). Il lui faut le dashboard compilé et
  `npx playwright install chromium`, que `npm ci` ne fait pas.

Ce que cette suite ne fait **pas** : comparer des pixels. Elle vérifie des
comportements, pas une apparence — une régression visuelle coûte moins cher
qu'une suite qui rougit à chaque retouche de style.

## Organisation

| Fichier | Rôle |
|---|---|
| `lib/api.ts` | Jeton, appels à l'API, erreurs typées |
| `lib/useHarness.ts` | WebSocket, reprise, état du dashboard |
| `components/StatusBar.tsx` | Connexion et santé — un dashboard déconnecté doit le dire |
| `components/TaskList.tsx` | Colonne de gauche |
| `components/TaskInspector.tsx` | État, résultat, erreur, timeline |
| `components/ApprovalPanel.tsx` | Le seul endroit qui débloque une tâche |
| `components/Timeline.tsx` | Le journal, rendu lisible |
| `components/NewTaskForm.tsx` | « Nouvelle tâche » : profils actifs seulement, dossier vérifié par le daemon |
| `components/AgentsCard.tsx` | Exécutants ; en vue « Profils », fournisseur et modèle de chacun |
| `components/SubtasksCard.tsx` | Sous-tâches d'un orchestrateur, total et budget de l'arbre, agents créés et leur rôle |
| `components/ProvidersCard.tsx` | Fournisseurs : déclaration, clé déposée au coffre, test, retrait |
| `lib/providers.ts` | Préréglages, validation d'une saisie de fournisseur, requête — fonctions pures |
| `components/McpServersCard.tsx` | Serveurs MCP : test, catalogue, outils cochés (Slice 8) |
| `lib/tree.ts` | Arbre des tâches, total et provenance, budget de l'arbre, agents créés — fonctions pures |
| `lib/mcp.ts` | Noms d'outils MCP, proposition « lecture seule », avertissement — fonctions pures |
| `lib/agents.ts` | Motif d'un profil désactivé — fonction pure |
| `components/ChatPanel.tsx`, `lib/thread.ts` | Conversation : le fil reconstitué du journal, la saisie |
| `components/TerminalPanel.tsx`, `lib/terminal.ts` | Terminal de l'atelier : sortie des commandes, couleurs seules |
| `components/TerminalView.tsx`, `lib/stream.ts` | Vue terminal : le journal de l'arbre en lignes |
| `components/BrowserPanel.tsx`, `lib/browser.ts` | Onglet « Navigateur » : ce que voit un agent |
| `components/WorkspaceCard.tsx`, `lib/patch.ts` | Worktree et diff d'une tâche Developer |
| `lib/bundle.ts` | Recharge une page plus vieille que son daemon |

## L'atelier (Slice 6)

```text
 barre d'activité │ tâches │ onglets : Détails │ Navigateur │ conversation
                  │        │ détails de la tâche, ou navigateur │ (fil + saisie)
                  │        │ terminal                         │
```

Tout suit **la tâche sélectionnée et son arbre** : la conversation et le
terminal sont ceux de sa racine et de ses sous-tâches. Les séparateurs se déplacent à
la souris ; les tailles sont retenues dans `localStorage` (une commodité :
sans stockage, la page fonctionne). Les panneaux sont bornés pour laisser à
la zone centrale au moins 40 % de la fenêtre.

- **Conversation** (`ChatPanel`, `lib/thread.ts`). Le fil est reconstitué du
  journal, événement par événement : messages de l'utilisateur, répliques de
  l'orchestrateur, délégations, questions et propositions des sous-tâches,
  réponses et verdicts. Les notes du harness restent dans la timeline. **La
  saisie ne s'ouvre que lorsque la conversation attend l'utilisateur** : le
  daemon refuse un message à une tâche qui travaille, et le motif s'affiche à la
  place. Le panneau dit qu'une conversation ne survit pas au daemon. Tout le
  texte est rendu comme du texte.
- **Terminal** (`TerminalPanel`, `lib/terminal.ts`). xterm.js sans clavier
  (`disableStdin`) : la commande, sa sortie au fil de l'eau (`exec.output`), sa
  fin. **La sortie est nettoyée** : seules les couleurs passent. Une séquence qui
  efface l'écran, déplace le curseur ou réinitialise le terminal (`ESC c`) ferait
  voir à l'humain autre chose que ce qui s'est passé, au moment où il décide
  d'une approbation ; le test unitaire a trouvé `ESC c` et `ESC 7` qui passaient
  au premier jet. Les couleurs du thème (`oklch`) sont converties en `rgb` en
  peignant un pixel, xterm ne lisant pas `oklch`.

Le formulaire « Nouvelle tâche » propose « Conversation », cochée par défaut,
pour un orchestrateur seulement.

Prouvé par `test:ui` (D12 : une conversation ; D13 : sortie au terminal
**pendant** la commande, puis la commande entière) et par
`tests/unit/dashboard-workbench.test.ts`. Le diff d'une tâche Developer se lit
dans ses détails (carte du worktree, D8). Rien ici n'ouvre ni n'écrit un
fichier : le daemon n'en a pas les routes, hors l'image lue par un agent (plus
bas).

## La vue terminal

Le bouton « Flux terminal » de l'atelier ouvre `#/terminal/<id>`
(`TerminalView`, `lib/stream.ts`) : le journal de la racine et de ses
sous-tâches, fondu en un seul flux de lignes monospace ordonnées par séquence
globale, sortie des commandes comprise, avec en pied la même saisie vers
l'orchestrateur que le panneau de conversation. Elle **lit** le même journal
que la timeline, par la même WebSocket, et n'écrit rien d'autre que ce
message. Tout texte y est nettoyé (`plain`) : aucune séquence d'échappement,
couleur comprise — la teinte d'une ligne vient d'une classe CSS. « Atelier → »
revient à la tâche. Prouvé par `test:ui` (D22) et par
`tests/unit/dashboard-workbench.test.ts`.

## Ce que voit un agent (Slice 7)

- **Onglet « Navigateur »** (`BrowserPanel`, `lib/browser.ts`). Il apparaît
  dès qu'un agent de l'arbre a ouvert un navigateur. Il s'ouvre seul à chaque
  **nouvelle** session si l'on regardait « Détails », jamais à chaque action :
  la comparaison se fait sur la séquence d'ouverture. Il montre :
  - l'objectif approuvé, l'adresse et l'échéance ;
  - la dernière capture, redemandée à chaque événement du navigateur. Elle est
    lue dans la **mémoire du daemon**, en octets authentifiés changés en URL
    `blob:`, puisqu'une balise `<img>` ne porte pas de jeton ;
  - la demande d'approbation de la tâche, **au-dessus de la capture** : on lit
    le texte à saisir en regardant la page où il partira.

  Une session fermée ne rend plus de capture : l'onglet garde la dernière vue,
  et le dit. L'adresse et le titre sont du texte, jamais un lien. **« Couper la
  session »** est sans confirmation : arrêter doit être plus simple que laisser
  faire.
- **L'image lue dans le fil.** Une image lue par `read_image` apparaît dans la
  conversation. Elle est relue **sur le disque** (`/api/tasks/:id/files/image`),
  puisque rien n'en est gardé, et montrée seulement si son SHA-256 commence comme
  celui que l'outil a journalisé. Sinon, le fil dit que le fichier a changé.
- **Profils.** Une case déclare si le modèle d'un profil à outils d'image lit
  les images ; le catalogue du fournisseur l'emporte quand il le publie. Le
  motif d'un profil refusé vient du daemon (`disabled_reason`). La commande
  `providers add` n'est conseillée que lorsqu'il manque un fournisseur.

Prouvé par `test:ui` (D14, sur un second daemon lancé dans le processus du test,
pour lui passer une garde qui admet la page locale) et par
`tests/unit/dashboard-workbench.test.ts`. Vu à l'écran : la demande
d'approbation pousse la capture sous le pli ; il faut défiler pour la voir
entière.

## Les serveurs MCP et les agents créés (Slice 8)

**Aux Profils**, la carte « Serveurs MCP » montre chaque serveur déclaré, son
dernier test et son catalogue. On y **teste la connexion** (le daemon lance le
serveur et relit ses outils) et on **coche** les outils libres. Cocher
s'annonce et se confirme, avec le même avertissement que
`harness mcp allow` : une autorisation durable, et un outil MCP n'est pas borné
au projet. Décocher ne demande rien : c'est revenir à l'approbation. Un outil
coché que le serveur annonce désormais autrement est montré **changé**, case
vide. Chaque profil qui peut en recevoir (`researcher`, `developer`,
`navigator`) a une case par serveur ; l'orchestrateur n'en a pas.

**Ce qui ne se fait pas ici** : déclarer ou retirer un serveur. C'est un
programme que le daemon lancera ; la CLI le résout par le `PATH` du terminal,
rend absolus ses arguments-fichiers et saisit une valeur secrète sans écho. La
carte donne les commandes.

**Dans les appels d'outils**, un appel MCP porte le nom de son serveur. **Dans
la carte « Sous-tâches »**, le budget de l'arbre — depuis la Slice 8, le
`max_cost_usd` de l'orchestrateur couvre ses sous-tâches — et les agents qu'il
a créés, lus dans son journal (`agent.created`), **avec le rôle** qu'il leur a
donné : c'est là que l'humain le relit.

