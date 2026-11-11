# Slice 8 — Des serveurs MCP pour les agents, et des agents créés à la volée

**Date :** 2026-11-05 · **Objectif :** que l'humain **branche un serveur MCP**
sur Midgaard — le premier visé est [REA](https://github.com/morluto/rea),
« Reverse Engineer Anything » — et que les agents délégués par
l'orchestrateur s'en servent ; et que **l'orchestrateur crée et choisisse ses
agents à la volée** au lieu de piocher dans cinq profils figés.

**État : en cours.** Décisions acceptées par l'auteur le 2026-11-05 ; étape 1
faite le même jour, verte en CI sur macOS, Linux et Windows (passage
`42002800496`) ; étape 2 faite le même jour, verte en CI sur les trois plateformes (passage
`42007433791`) ; étape 3 faite le même jour, verte en CI sur les trois plateformes (passage
`42011901280`) ; étape 4 faite le même jour, verte en CI sur les trois plateformes (passage
`42016819429`) ; étape 5 faite le même jour, verte en CI sur les trois plateformes (passage
`42056152169`) ; étape 6 faite le même jour, verte en CI sur les trois plateformes (passage
`42059539829`).

---

## Ce que la Slice 8 renverse

Jusqu'ici, chaque outil d'un agent est écrit dans ce dépôt : sa politique, sa
frontière (racine, worktree, garde réseau) et ce qu'il écrit au journal sont
connus d'avance. Un serveur MCP externe apporte des outils **écrits par
d'autres**, dont Midgaard ne connaît que le nom, la description et le schéma
— annoncés par le serveur lui-même. REA en est l'exemple franc : il lit un
binaire **où qu'il soit**, lance Ghidra, Hopper ou IDA, écrit des dossiers
temporaires, et ses annotations (`readOnlyHint`, `destructiveHint`) sont, de
son propre aveu, « des indications, pas des contrôles d'autorisation ».

Et jusqu'ici, l'orchestrateur choisit parmi des profils que l'humain a réglés.
Le laisser **en créer** revient à lui laisser choisir un modèle, une consigne
et des outils : il faut que rien de ce qu'il crée ne dépasse ce que l'humain a
ouvert.

## Les décisions prises avec l'auteur (2026-11-05)

| Question | Réponse retenue |
|---|---|
| Quel serveur d'abord ? | **REA** (`rea-agents`), un serveur **stdio** : `node …/scripts/rea.mjs mcp` |
| Que veut dire « attribuer plusieurs agents » ? | **L'orchestrateur crée et choisit ses agents à la volée** |
| Comment approuver un outil MCP ? | **Liste blanche par outil** : l'humain coche à la déclaration ceux qui sont libres ; les autres sont approuvés à chaque appel, arguments exacts sous les yeux ; tout résultat est non fiable |
| Qui se sert d'un serveur MCP ? | **Les profils qui le déclarent.** L'orchestrateur ne les appelle pas lui-même ; il délègue à un agent qui les a |

## Ce que le code offre déjà

- **Le SDK MCP** (`@modelcontextprotocol/sdk`) est déjà une dépendance, côté
  serveur (`packages/mcp-server`) ; son client stdio existe dans le même paquet.
- **La garde des processus** (`tools/src/guard.ts`) tue les groupes qu'un
  daemon mort net n'a pas pu tuer ; **`run()`** (paquet `secrets`) reconstruit
  l'environnement d'un fils à partir d'une liste blanche.
- **Les approbations** portent sur une opération préparée et son empreinte
  (`operation_detail`, JSON canonique), revérifiée au moment d'agir.
- **L'encadrement `<untrusted_data>`** à nonce, l'expurgation (`createRedactor`)
  et la règle « une tâche qui a reçu un contenu encadré rend un résultat non
  fiable » (Slice 5).
- **La délégation parallèle** existe déjà (`delegate_task` sans attente, puis
  `wait_for_task` sur chacune, O1 dans `test:orchestrator`), et
  **`tightenLimits`** ne sait qu'abaisser.
- Manquent : un **client MCP dans le daemon**, une **déclaration** de serveur
  par l'humain, des outils dont le nom n'est connu qu'à l'exécution, et des
  profils qui ne soient pas livrés d'office.

## Décisions de conception

### Les serveurs MCP

1. **Un serveur MCP se déclare par l'humain, jamais par un agent.** CLI
   (`harness mcp add rea -- …`) ou dashboard : commande et arguments **absolus**,
   variables d'environnement déclarées. Le binaire est résolu à la déclaration
   et revérifié au lancement, comme `exec`. Un secret passé en variable va au
   coffre, la base n'en garde que la référence.
2. **stdio d'abord.** C'est le transport de REA et celui que Claude Code gère
   le mieux. Le HTTP local (Streamable HTTP) viendra quand un serveur le
   demandera ; il pose d'autres questions (authentification, adresse jugée).
3. **Un processus serveur par tâche**, sous la garde : lancé au premier appel,
   tué — groupe compris — à la fin, à l'annulation, au délai, et après un
   `SIGKILL` du daemon. Aucun partage entre tâches : l'état d'un serveur (un
   binaire ouvert dans REA) ne fuit pas d'une tâche à l'autre. *À vérifier à
   l'essai : Ghidra démarre en jusqu'à 330 s, et des agents parallèles sur le
   même binaire le paieraient chacun. Un partage par arbre de tâches est la
   piste si c'est intenable.*
4. **Le catalogue est constaté, pas supposé.** « Tester la connexion » lance
   le serveur, fait `initialize` puis `tools/list`, et montre à l'humain les
   outils réellement annoncés. Rien n'est décrit à un agent qu'on n'a pas lu
   chez le serveur.
5. **Liste blanche par outil, et sur ce que l'humain a lu.** Cocher un outil
   enregistre l'**empreinte** de son nom, de sa description et de son schéma.
   Un outil ajouté plus tard, ou dont la description ou le schéma a changé, n'est
   **plus** libre : il redemande une approbation à chaque appel jusqu'à ce que
   l'humain le recoche. Sans cela, un serveur mis à jour changerait ce que
   l'humain a autorisé sans qu'il le sache. Les annotations du serveur sont
   montrées pour aider à cocher, jamais appliquées seules.
6. **Un appel non coché s'approuve sur ses arguments exacts**, expurgés, comme
   l'opération préparée d'`exec`. Refusé, il n'atteint jamais le serveur.
7. **Tout ce qui revient d'un serveur MCP est encadré** en `<untrusted_data>`
   avec un nonce, et la tâche qui le reçoit rend un résultat **non fiable**.
   Le résultat est plafonné en taille avant d'entrer dans la conversation, et
   passe par l'expurgation avant d'être journalisé.
8. **La racine du projet ne vaut pas pour un outil MCP**, et c'est dit. REA lit
   un binaire n'importe où sur la machine ; Midgaard ne peut pas vérifier un
   chemin dans des arguments dont il ignore le sens. Cette limite est écrite à
   l'humain au moment de déclarer le serveur et de cocher ses outils, pas
   découverte après.
9. **Des noms préfixés et sûrs.** Un outil MCP devient `<serveur>__<outil>`
   (`rea__open_binary`) : aucun point, aucun conflit avec un outil intégré, et
   le journal dit de quel serveur vient chaque appel.
10. **Un appel long tient, un appel annulé s'arrête.** Borné par l'échéance de
    la tâche (`ToolContext.deadline`), annulé par `notifications/cancelled`
    puis par la mort du processus. Le délai d'un premier appel Ghidra est
    documenté pour qu'un profil de reverse ait un `timeout_s` qui le permette.
11. **Rattaché à des profils.** Un profil porte `mcp_servers` ; seuls ses agents
    voient ces outils. `list_agents` dit à l'orchestrateur quels serveurs a
    chaque profil, pour qu'il choisisse ; lui n'en appelle aucun.

### Les agents créés à la volée

12. **L'orchestrateur crée un agent par un outil, `create_agent`** : un nom,
    une consigne de rôle, un **type de base** (`researcher`, `developer`,
    `navigator`), un modèle, des serveurs MCP, des limites. Il rend un
    identifiant qu'il passe ensuite à `delegate_task`, autant de fois qu'il
    veut, en parallèle s'il veut.
13. **Rien de créé ne dépasse ce que l'humain a ouvert** :
    - les **outils** sont ceux du type de base, jamais plus ;
    - les **limites** sont abaissées depuis celles du profil de base
      (`tightenLimits`), jamais relevées ;
    - les **serveurs MCP** sont pris parmi ceux du **profil de base** — que
      l'humain lui a donnés (`harness mcp attach`). *Précisé à l'étape 4 : une
      case de plus par serveur aurait doublé le réglage sans rien ajouter ; le
      profil de base est déjà ce que l'humain ouvre ;*
    - le **modèle** est pris parmi ceux d'un fournisseur configuré, **offerts**
      à son dernier test de connexion **et tarifés** — un coût inconnu
      échapperait au budget de l'arbre ; la vision d'un Navigator reste
      **constatée** au catalogue, au départ de sa tâche ;
    - un orchestrateur ne crée jamais d'orchestrateur (profondeur 1, Slice 5).
14. **La consigne de rôle s'ajoute à celle du type, ne la remplace jamais.** Les
    règles qui protègent (`submit_result`, le traitement des contenus non
    fiables, le worktree) restent écrites avant elle. L'humain la lit au
    dashboard, dans l'arbre de la tâche.
15. **Un agent créé appartient à son arbre.** Visible du seul orchestrateur qui
    l'a créé, il refuse toute délégation une fois l'arbre fini ; sa ligne reste
    en base pour l'historique. Claude, par MCP, ne le voit pas.
16. **`agent_id` d'un agent créé n'est posé que par le daemon**, comme
    `parent_task_id` et `mode` : aucune route ne permet de rattacher une tâche
    à l'agent d'un autre arbre.
17. **Un plafond de sous-tâches actives par arbre**, réglable par l'humain
    (défaut proposé : 4). Créer des agents à la volée et les lancer en
    parallèle multiplie la dépense ; le plafond se vérifie **avant** la
    création de la sous-tâche, comme toute limite.

## Tranché en cours de route (2026-11-05)

- **Un budget d'arbre : oui** (décision de l'auteur, à l'étape 4). Le
  `max_cost_usd` de l'orchestrateur couvre la somme de son arbre — ses appels
  et ceux de chaque sous-tâche —, vérifié avant chaque appel de modèle de
  chaque tâche de l'arbre et avant chaque délégation.
- **La création d'un agent n'est pas approuvée** (décision de l'auteur, à
  l'étape 4) : elle est bornée par le daemon, et visible de l'humain.

- **Les limites d'un profil se règlent, par une route** (décision de
  l'auteur, 2026-11-05, qui revient sur la Slice 5). REA laisse jusqu'à 330 s
  à Ghidra ; le Researcher avait `timeout_s` 300, et personne ne pouvait plus
  le relever. Entre la CLI seule, une route pour la CLI et le dashboard, ou un
  fichier de configuration, l'auteur a choisi **la route**
  (`PUT /api/agents/:id/limits`), avec ses garde-fous : route à part du
  réglage du modèle (qui ignore toujours des limites glissées dans son corps),
  bornes du schéma, **confirmation de tout relèvement** dans la CLI
  (`harness agents limits`) comme au dashboard, changement journalisé avant →
  après avec son auteur, tâches existantes inchangées.

## Reste à trancher

- **Le processus REA partagé par arbre** (décision 3) si le démarrage de
  Ghidra par tâche se révèle trop lent à l'essai.
- ~~Le délai d'un premier appel Ghidra face aux limites des profils~~ —
  tranché le 2026-11-05 : voir « Les limites d'un profil se règlent ».
- **Choisir les outils d'un serveur exposés à un profil.** REA en annonce
  207, ~55 000 jetons de définitions relus à chaque appel de modèle, et ne
  sait pas en exposer moins (trois variables `REA_MCP_*`, aucune ne filtre).
  Venice les accepte et son cache en absorbe l'essentiel (61 696 jetons
  resservis au deuxième appel) ; un fournisseur plafonné à 128 outils les
  refuserait. À trancher après le second essai, sur ce qu'il aura coûté.

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | Le paquet `mcp-client` : lancer un serveur stdio sous la garde, `initialize`, `tools/list`, `tools/call`, annulation, délai ; aucun processus survivant, `SIGKILL` du daemon compris ; éprouvé contre un faux serveur MCP de test | **fait** — 15 tests, vus échouer sans la garde et sans le groupe ; verts en CI sur trois plateformes |
| 2 | La déclaration : migration (serveurs, outils cochés et leurs empreintes), `harness mcp add/list/test/allow/remove`, routes `/api/mcp`, « Tester la connexion » qui lit vraiment le catalogue | **fait** — migration 11, `PROTOCOL_VERSION` 14 ; deux défauts trouvés par la vraie CLI, réglés ; verte en CI sur trois plateformes |
| 3 | Les outils MCP derrière `ToolContext.mcp` : noms préfixés, liste blanche à empreinte, approbation sur arguments exacts, encadrement, plafond, expurgation ; `mcp_servers` sur un profil ; `PROTOCOL_VERSION` | **fait** — migration 12, `PROTOCOL_VERSION` 15 ; un agent réel du daemon appelle un serveur MCP, vu échouer sur deux défauts introduits ; verte en CI sur trois plateformes |
| 4 | Les agents créés à la volée : `create_agent`, plafonds (outils, limites, serveurs, modèle, vision), consigne ajoutée, rattachement à l'arbre, plafond de sous-tâches actives | **fait** — migration 13, budget d'arbre ; trois défauts introduits vus échouer, un trou trouvé en écrivant ; verte en CI sur trois plateformes |
| 5 | Le dashboard : page « Serveurs MCP » (déclarer, tester, cocher), serveurs d'un profil, appels MCP dans le fil, agents créés et leur consigne dans l'arbre | **fait** — la déclaration reste à la CLI ; D16 et D17 dans `test:ui` ; vu dans le navigateur ; verte en CI sur trois plateformes |
| 6 | Preuves : `test:orchestrator` (création, délégation parallèle, outil MCP), `test:security` (outil non coché refusé sans atteindre le serveur, empreinte changée → plus libre, agent créé qui tente de dépasser son type, rien de non expurgé en base, aucun serveur vivant après `SIGKILL`), CI sur trois plateformes | **fait** — X10 à X13 dans `test:security`, chacun vu échouer sur la protection qu'il garde ; verts en CI sur trois plateformes |
| 7 | L'essai réel : un orchestrateur sur Venice crée deux agents de reverse sur REA et un Developer, analyse un binaire, rend une synthèse ; coût relevé | **cible JavaScript conclue** au troisième essai (2026-11-06) : agent créé avec REA, réponse juste, non fiable, 0,072 $ ; quatre défauts trouvés en chemin et réglés. **Aucun appel REA réel encore** : la recherche textuelle suffisait — à éprouver sur un binaire |

### Ce que chaque étape doit surveiller

- **Étape 1.** Compter les processus vivants, ceux qu'un serveur MCP lance
  lui-même compris (REA lance Ghidra) : un fils qui quitte son groupe de
  processus échapperait à la garde. Et ne jamais écrire sur la sortie standard
  du daemon ce qui vient du serveur.
- **Étape 2.** « Tester la connexion » doit prouver que le serveur **répond au
  protocole**, pas seulement que le binaire existe (même leçon que la clé
  Venice, Slice 2).
- **Étape 3.** L'empreinte d'un outil coché se compare au catalogue lu **au
  lancement** du serveur de la tâche, pas à celui de la déclaration.
- **Étape 4.** Un agent créé qui demande un outil hors de son type, une limite
  plus haute ou un serveur fermé est **refusé avec son motif**, jamais
  silencieusement réduit : l'orchestrateur doit savoir ce qu'il a obtenu.
- **Étape 7.** Le solde Venice est partagé avec un autre usage (Slice 6) : le
  coût se relève par tâche, et la comparaison au solde se dit faite ou non.

## Récit

### Étape 1 — le client MCP du daemon (2026-11-05)

Le paquet `@midgaard/mcp-client` ([README](../packages/mcp-client/README.md)) :
`McpConnection` (poignée de main, catalogue, appel, arrêt) sur
`GuardedStdioTransport`, et `serverEnv`.

**Le transport du SDK n'est pas employé.** `StdioClientTransport` lance le
serveur dans le groupe du daemon et ne tue que le processus principal : REA
lance Ghidra, qui lui survivrait. Le transport de Midgaard reprend la recette
d'`exec` — groupe à lui, garde armée avant le lancement, groupe inscrit dès
qu'il a un pid, `SIGKILL` au groupe à la fin même si le serveur a quitté
proprement. Le protocole reste celui du SDK (`Client`, `ReadBuffer`).

Ce qui a été tranché en écrivant :

- **Aucune capacité cliente.** `sampling` laisserait un serveur faire appeler
  le modèle de l'agent, donc dépenser en son nom ; `roots` et `elicitation`
  n'ont pas d'usage ici. Un serveur qui les demande reçoit « méthode inconnue ».
- **Une progression ne prolonge pas un appel.** Le délai est le reste de
  l'échéance de la tâche (`resetTimeoutOnProgress: false`) : sans cela, un
  serveur qui annonce sa progression tiendrait la tâche au-delà de son terme.
- **Un délai dépassé n'est pas une panne.** Le SDK prévient le serveur
  (`notifications/cancelled`), la connexion reste utilisable ; seule la sortie
  du serveur la rend inutilisable. Les raisons d'échec sont distinctes
  (`start`, `exited`, `timeout`, `cancelled`, `protocol`) parce que l'outil de
  l'étape 3 ne dira pas la même chose au modèle.
- **La sortie d'erreur du serveur n'est recopiée nulle part.** On en garde la
  fin (8 Kio), non expurgée, pour que le daemon l'expurge avant de la montrer.
- **L'environnement est construit, pas hérité.** Une clé d'API posée dans
  l'environnement du daemon n'atteint pas le serveur : vérifié par le serveur
  lui-même, qui rend la liste de ce qu'il a reçu.

**Les preuves.** `tests/unit/mcp-client.test.ts` (dans `test:unit`), contre
`tests/fake-mcp-server.ts`, un vrai serveur du SDK sur un vrai tube. Le cas du
daemon tué net applique la leçon de la Slice 7 : un serveur stdio quitte
souvent seul quand son entrée se ferme, et un test qui ne regarderait que lui
passerait sans la garde. Il **fige** donc le serveur (`SIGSTOP`) et regarde
aussi un petit-enfant qui ne lit rien. Les 15 tests ont été **vus échouer**
sur deux défauts introduits exprès : sans inscription à la garde, le
petit-enfant survit au daemon tué net ; sans groupe de processus, le serveur
survit à la fermeture.

**Constaté en CI** sur macOS, Linux et Windows (passage `42002800496`) : les
15 tests passent partout, les trois cas de processus compris. Sous Windows,
le serveur n'est pas figé (`SIGSTOP` n'existe pas) : le petit-enfant y
prouve la garde seul.

**Ce qui reste à constater** : le comportement de Ghidra lancé par REA —
reste-t-il dans le groupe ? — à l'essai réel.

### Étape 2 — déclarer un serveur, cocher ce qu'on a lu (2026-11-05)

Contrats (`contracts/src/mcp.ts`), migration 11 (`mcp_servers`,
`mcp_tool_allow`), service du daemon (`daemon/src/mcp-servers.ts`), routes
`/api/mcp`, commande `harness mcp` (`cli/src/mcp.ts`), `PROTOCOL_VERSION` 14
— sans quoi une CLI à jour face à un daemon resté au protocole 13 aurait pris
un 404.

Ce qui a été tranché en écrivant :

- **L'empreinte couvre ce que l'humain a lu** : nom, titre, description,
  schéma d'entrée **et annotations** — un outil qui cesse de se dire
  « lecture seule » a changé. Le schéma de sortie n'en fait pas partie : il ne
  change ni ce que le modèle lit pour décider, ni ce que l'appel peut faire.
  JSON canonique, pour qu'un ordre de clés différent ne la change pas.
- **Redéclarer un serveur efface son catalogue**, mais pas ses outils cochés :
  le test suivant dit lesquels le serveur annonce autrement (`changed`), et ils
  redemandent une approbation à chaque appel jusqu'à ce qu'on les recoche.
- **Un identifiant de serveur n'a pas de souligné** : `rea__open_binary` doit
  se découper sans ambiguïté (décision 9).
- **Les variables secrètes vont au coffre**, sous
  `mcp.<empreinte du dossier runtime>.<serveur>.<nom>` ; le coffre normalise en
  minuscules, d'où le refus de deux noms qui ne diffèrent que par la casse. Les
  variables ordinaires sont en clair, et la CLI le dit.
- **Le programme est résolu par la CLI**, au `PATH` du terminal, et déclaré
  absolu ; le daemon le revérifie à chaque lancement sans le canonicaliser
  (`node` de Homebrew est un lien vers un dossier versionné).
- **`mcp allow --read-only`** propose les outils annoncés en lecture seule et
  non destructifs, que l'humain lit et confirme : les annotations restent des
  indications.

**Ce que le vrai essai de la CLI a trouvé**, que les tests ne voyaient pas —
les tests passaient au programme des arguments absolus :

1. **Un argument relatif ne mène nulle part.** `mcp add fake -- node
   tests/fake-mcp-server.ts` déclarait le script tel quel ; le serveur, lancé
   dans le dossier runtime, ne le trouvait pas. La CLI rend désormais absolu
   tout argument qui a l'air d'un chemin et désigne un fichier existant, et
   l'affiche. Un humain qui tape `-- node ./rea.mjs mcp` serait tombé dessus.
2. **L'extrait de la sortie d'erreur avait perdu la cause.** N'en garder que
   la fin montrait la pile d'appels et coupait « Cannot find module ». Il
   garde désormais le début et la fin (`stderrExcerpt`).

Et deux défauts trouvés par les tests eux-mêmes : un serveur qui échoue à la
poignée de main **perdait sa sortie d'erreur** (la connexion n'existe plus
quand on veut la lire : `McpClientError` la porte désormais, et l'arrêt attend
la fermeture des tubes, pas seulement la sortie du processus) ; et
`checkMcpCommand` jugeait un chemin Windows avec les règles de l'hôte.

**Les preuves.** `tests/unit/mcp-servers.test.ts` (22 tests, dans
`test:unit`), sur un vrai daemon et le faux serveur, qui sait désormais
changer la description d'`echo` et répéter un jeton en échouant. La valeur
secrète est cherchée octet pour octet dans la base, son WAL et le journal :
**vu échouer** en retirant l'expurgation du message d'échec. `test:security`
et `test:restart` restent verts au protocole 14. En CI (passage `42007433791`),
les 22 tests passent sous macOS, Linux et Windows — le refus d'un `.cmd` et
l'expurgation compris. Et la CLI, rejouée de bout en
bout dans un dossier runtime jetable : déclaration, test, `--read-only`, refus
sans terminal, outil devenu `changed` après redéclaration, retrait.

### Étape 3 — un agent se sert d'un serveur MCP (2026-11-05)

Les outils MCP sont **construits pour chaque tâche** (`tools/src/mcp.ts`), à
partir du catalogue que ses serveurs annoncent à son départ ; la boucle les
reçoit par `LoopInput.extraTools`, et le daemon les lance et les ferme
(`daemon/src/mcp-sessions.ts`). Un profil porte `mcp_servers` (migration 12,
`PUT /api/agents/:id/mcp`, `harness mcp attach/detach`), et `list_agents` les
montre à l'orchestrateur. `PROTOCOL_VERSION` 15.

Ce qui a été tranché en écrivant :

- **Les serveurs démarrent au départ de la tâche, pas au premier appel.** Il
  faut le catalogue pour décrire les outils au modèle ; et un serveur qui ne
  démarre pas fait échouer la tâche avant tout appel de modèle — un agent de
  reverse sans REA ne ferait que tourner en rond, à nos frais. **Tout ou
  rien** : les serveurs déjà lancés sont fermés.
- **L'empreinte se compare au catalogue annoncé au lancement**, et la liste
  des outils cochés se lit au lancement, comme celle d'`exec`. Le catalogue
  est ensuite figé : un `tools/list_changed` n'ajoute rien à la tâche en cours.
- **La description d'un outil est signée de sa provenance**, bornée à 1 500
  caractères, et dit quand un appel attend un humain. Elle est écrite par le
  serveur et relue par le modèle à chaque appel : c'est la porte d'un
  empoisonnement d'outil, et le seul garde-fou complet reste l'approbation.
- **Un nom qu'un fournisseur refuserait est écarté et dit**, jamais retouché.
  Un identifiant de serveur commence désormais par une lettre : Gemini refuse
  un nom de fonction qui commence par un chiffre.
- **Ce qui part est ce qui a été approuvé** : `run` envoie les arguments du
  détail figé, qui porte aussi l'empreinte de l'outil.
- **Les valeurs secrètes d'un serveur rejoignent l'expurgation de la tâche** :
  un serveur peut répéter son jeton dans un résultat.
- **Un refus humain annule la tâche**, comme pour toute approbation (X7) ; ce
  n'est pas une règle propre aux outils MCP.
- **Retirer un serveur le retire des profils**, et le dit.

**Les preuves.** `tests/unit/mcp-tools.test.ts` (outils seuls, faux port) et
`tests/unit/mcp-agents.test.ts` (un Researcher dans un vrai daemon, face au
faux fournisseur et au faux serveur), tous deux dans `test:unit`. Le second
compte les processus serveur au système grâce au pid que chacun laisse. Deux
défauts introduits exprès l'ont fait échouer :

1. **les serveurs jamais fermés en fin de tâche** : deux scénarios voient des
   serveurs survivre ;
2. **le catalogue enregistré pris pour celui du lancement** : un outil coché,
   décrit autrement par un serveur mis à jour **sur place**, passait sans
   approbation. Le premier jet du test ne le voyait pas — il redéclarait le
   serveur, ce qui efface le catalogue enregistré, et le code fautif
   retombait sur le bon. Le faux serveur lit désormais la description d'`echo`
   dans un fichier, changé après le test de connexion.

`test:security`, `test:orchestrator`, `test:developer` et `test:restart`
restent verts au protocole 15, et la CI (passage `42011901280`) passe les
scénarios MCP sous macOS, Linux et Windows.

**Ce qui reste à voir à l'essai réel** : le coût d'un catalogue de plusieurs
dizaines d'outils relu à chaque appel de modèle (REA propose un profil de
schémas compact, `REA_MCP_INPUT_SCHEMA_PROFILE=compact`, à déclarer en `--env`),
et le délai d'un premier appel Ghidra face au `timeout_s` du profil.

### Étape 4 — l'orchestrateur crée ses agents (2026-11-05)

Deux décisions prises avec l'auteur avant d'écrire : **un budget d'arbre**, et
**pas d'approbation** à la création — bornée, visible.

L'outil `create_agent` (orchestrateur seulement) demande un nom, un profil de
base (`researcher`, `developer`, `navigator`), un rôle, et facultativement un
fournisseur, un modèle, des serveurs MCP et des limites. Le gérant
(`TaskManager.createAgent`) l'enregistre dans `created_agents` (migration 13),
rattaché à la tâche orchestrateur, et l'écrit au journal de celle-ci
(`agent.created`, avec le rôle) ; l'orchestrateur reçoit un `agent_id` qu'il
passe à `delegate_task`. `TaskManager.agentFor` résout un agent créé à partir
de son profil de base (`resolveCreatedAgent`) : **mêmes outils, consigne du
profil puis le rôle** sous un titre qui dit qu'il ne la remplace pas.

Ce qui a été tranché en écrivant :

- **Un dépassement est refusé avec son motif, jamais réduit en silence** :
  limites au-dessus du profil, serveur MCP que le profil n'a pas, fournisseur
  inconnu, modèle non offert, modèle sans tarif. `tightenLimits` aurait réduit
  sans le dire ; l'orchestrateur doit savoir ce qu'il a obtenu.
- **Les serveurs MCP d'un agent créé sont un sous-ensemble de ceux du profil
  de base** (décision 13, précisée) : c'est déjà ce que l'humain ouvre.
- **Un modèle doit être offert et tarifé** : offert, constaté au dernier test
  de connexion du fournisseur ; tarifé, dans la table en vigueur. Un coût
  inconnu n'entre pas dans le budget de l'arbre — il y échapperait.
- **Un agent créé n'existe que dans son arbre** : un autre orchestrateur, une
  tâche de Claude ou du dashboard reçoivent « profil inconnu », la même
  réponse qu'un identifiant qui n'existe pas. Il n'est pas un profil : absent
  de `GET /api/agents`, invisible de Claude. Huit au plus par tâche.
- **Le budget de l'arbre** (`TaskManager.treeBudget`) : chaque tâche de l'arbre
  voit ce qu'ont dépensé les **autres**, et la boucle s'arrête en
  `budget_exceeded` quand sa dépense plus la leur atteint le `max_cost_usd` de
  l'orchestrateur ; une délégation est refusée une fois le budget dépensé.
- **Le plafond de sous-tâches actives** : 4 par défaut,
  `MIDGAARD_MAX_ACTIVE_SUBTASKS`, vérifié avant de créer la sous-tâche.

**Un trou trouvé en écrivant** : le premier jet du contrôle d'arbre ne
s'appliquait qu'à une tâche dont le coût propre était connu — donc **pas
avant son premier appel**. Une sous-tâche née dans un arbre déjà à court
pouvait faire un appel payant. Le coût propre inconnu compte désormais pour
zéro, sans dispenser du contrôle.

**Les preuves.** `tests/unit/created-agents.test.ts` (gérant réel, moteurs
pilotables, dépense écrite par le bus et lue en base) : dérivation du profil,
refus motivés, cloisonnement à l'arbre, plafond de sous-tâches actives, budget
commun. Trois défauts introduits exprès l'ont fait échouer : des limites trop
hautes réduites en silence, un agent créé utilisable hors de son arbre, le
contrôle d'arbre sauté au premier appel. Et dans `tests/unit/mcp-agents.test.ts`,
le **vrai moteur de l'orchestrateur** face au faux fournisseur : il crée un
agent avec le serveur MCP du Researcher, lui délègue, et l'agent reçoit la
consigne du profil, puis le rôle, puis les outils du serveur.
`test:orchestrator`, `test:security` et `test:developer` restent verts, et la
CI (passage `42016819429`) passe ces scénarios sous macOS, Linux et Windows.

### Étape 5 — l'atelier montre les serveurs MCP et les agents créés (2026-11-05)

**Aux Profils**, une carte « Serveurs MCP » (`McpServersCard`) : chaque
serveur, son dernier test, son catalogue ; « Tester la connexion » ; une case
par outil, cochée s'il est libre. Cocher passe par une confirmation qui porte
**le même avertissement que la CLI** ; décocher, non. « Cocher les outils de
lecture » propose ce que propose `mcp allow --read-only`, et le test vérifie
que les deux fonctions disent la même chose. Chaque profil qui peut recevoir
des outils MCP a une case par serveur (`PUT /api/agents/:id/mcp`).

**Dans la carte « Sous-tâches »**, deux choses de l'étape 4 qui ne se
voyaient pas : le **budget de l'arbre** — la carte affirmait encore « l'arbre
n'a pas de plafond en dollars », faux depuis l'étape 4, et le formulaire
« Nouvelle tâche » disait « ce budget ne couvre que l'orchestrateur » ; les
deux sont corrigés — et les **agents créés**, lus dans le journal de
l'orchestrateur, **avec leur rôle**. Un appel d'outil MCP porte le nom de son
serveur dans la liste des appels.

**Ce qui a été tranché** : **la déclaration d'un serveur reste à la CLI**
(décision 1 la permettait aux deux). Déclarer, c'est désigner un programme que
le daemon lancera : la CLI le résout par le `PATH` du terminal, rend absolus
les arguments-fichiers (le défaut de l'étape 2) et saisit une valeur secrète
sans écho ; un formulaire devrait refaire les trois, moins bien. La carte
donne les commandes exactes.

**Les preuves.** `tests/unit/dashboard-mcp.test.ts` (fonctions pures : noms
MCP, proposition « lecture seule » comparée à celle de la CLI, budget de
l'arbre, agents lus dans le journal). Dans `test:ui`, D16 — test relu, outil
coché après avertissement **et constaté en base**, décoché, serveur donné au
Researcher, aucune case pour l'orchestrateur — et D17 — un orchestrateur crée
un exécutant, la carte le montre avec son rôle et le budget de l'arbre. Le
premier jet de D16 lisait la case juste après la base, avant la réponse de
l'API : une course du test, pas du dashboard. Vu enfin dans le navigateur
intégré, sur un daemon jetable : carte, catalogue, case du Researcher. En CI
(passage `42056152169`), D16 et D17 passent sous macOS, Linux et Windows.

### Étape 6 — les preuves de bout en bout (2026-11-05)

Quatre scénarios de plus dans `test:security`, sur un vrai daemon, le faux
fournisseur et le faux serveur MCP — qui note désormais chaque appel **reçu**
(`calls.log`) et chaque fils lancé :

- **X10** — un outil non coché, refusé par l'humain, et un outil coché puis
  décrit autrement par un serveur mis à jour sur place, refusé lui aussi,
  **n'atteignent jamais le serveur** : il n'a reçu que l'appel témoin coché.
  C'est le serveur qui le dit, pas le journal du harness.
- **X11** — le jeton d'un serveur, rendu par lui dans un résultat puis recopié
  par l'agent dans un appel et dans sa conclusion, est expurgé avant le modèle
  et absent de la base, du WAL et des journaux, lus octet pour octet.
- **X12** — un vrai orchestrateur demande un exécutant aux limites trop
  hautes, puis un autre avec un serveur MCP que son profil n'a pas : refus
  motivés, au journal. L'exécutant légitime est créé et délégué, absent des
  profils, refusé hors de son arbre ; son rôle, qui portait une clé tierce, est
  expurgé.
- **X13** — sur un daemon à part, le serveur MCP d'une tâche et le fils qu'il a
  lancé, vivants pendant une pause d'approbation, meurent après un `SIGKILL` du
  daemon ; le serveur est **figé** avant (leçon de X9 : un serveur stdio
  quitte souvent seul quand son entrée se ferme).

**Chacun vu échouer** sur la protection qu'il garde, et seulement elle :
tout outil MCP libre (X10 et X13 échouent — X13 ne trouve plus de pause),
secrets du serveur hors de l'expurgation de la tâche (X11), rôle d'un agent
créé non expurgé (X12), serveur jamais confié à la garde (X13 : deux
processus vivants dix secondes après la mort du daemon).

**Le premier jet de X11 échouait à tort** : il cherchait le jeton dans toute
la conversation relevée par le faux fournisseur, qui contient aussi les appels
écrits par le modèle scénarisé — lequel recopie le jeton lui-même. Seuls les
résultats d'outils, ce que le harness rend au modèle, comptent.

**Constaté en CI** (passage `42059539829`) : 13 scénarios sur 13 sous macOS,
Linux et Windows. Sous Windows, X13 ne fige pas le serveur (`SIGSTOP`
n'existe pas) : son fils, qui ne lit rien, y prouve la garde seul, et le
scénario le dit.

### Étape 7 — l'essai réel avec REA (protocole, 2026-11-05)

**À lancer par l'auteur** : REA n'est pas installé sur la machine de
développement, et l'essai fait travailler un vrai modèle, donc dépense.

#### Le choix de la cible

**Une application JavaScript d'abord, pas un binaire natif.** L'analyse
JavaScript de REA ne demande ni Ghidra, ni Hopper, ni IDA. Le binaire natif
sera le second essai : un premier appel Ghidra peut durer jusqu'à 330 s, et il
faudra d'abord relever le `timeout_s` du Researcher (300 s par défaut), ce que
`harness agents limits researcher --timeout 900` permet désormais.

**La cible est le dashboard de Midgaard, compilé et minifié, sans ses
sources**, copié seul dans un dépôt jetable. C'est notre code — aucune
question de licence —, et **la bonne réponse est connue** : à chaque
reconnexion, la page relit `index.html` servi sans cache, compare le script
qu'il désigne au sien, et se recharge s'il diffère (`lib/bundle.ts`, Slice 7).
On peut donc juger le résultat, pas seulement le fait qu'il y en ait un.

#### Préparer (une fois, dans un terminal)

**Node d'abord.** `rea-agents` 6.8.0 exige Node `^22.23.4 || ^24.22.1 ||
>=26.12.1` (relevé sur npm le 2026-11-05) ; la 6.7.0, que Homebrew a
installée le 2026-11-06, se contente de `^24.11.0` — le Node 24.18.0 de la
machine de développement suffit alors. Midgaard, lui, se contente de Node 24. Le serveur MCP de REA se lance avec le `node` que `mcp add` résout,
donc celui du `PATH` du terminal au moment de la déclaration.

Installer REA, depuis un dossier qui n'est pas un projet :

```bash
npm install --global rea-agents
```

Déclarer REA, avec le profil de schémas compact (le catalogue entier est relu
à chaque appel de modèle), puis lire son catalogue, à la racine du clone de
Midgaard :

```bash
npm run harness -- mcp add rea --env REA_MCP_INPUT_SCHEMA_PROFILE=compact -- node "$(npm root -g)/rea-agents/scripts/rea.mjs" mcp
```

```bash
npm run harness -- mcp tools rea
```

Cocher les outils de lecture **après les avoir lus** dans la liste
qu'affiche la commande, puis donner REA au Researcher :

```bash
npm run harness -- mcp allow rea --read-only
```

```bash
npm run harness -- mcp attach rea researcher
```

Construire la cible, un dépôt d'un commit qui ne contient que le bundle.
**Sans sa source map** : le build en produit une, qui rendrait les sources
à l'agent — la première préparation l'avait copiée.

```bash
npm run build && rm -rf ~/midgaard-essai-rea && mkdir -p ~/midgaard-essai-rea && cp -R apps/dashboard/dist ~/midgaard-essai-rea/cible && rm -f ~/midgaard-essai-rea/cible/assets/*.map && git -C ~/midgaard-essai-rea init -q && git -C ~/midgaard-essai-rea add -A && git -C ~/midgaard-essai-rea -c user.name=Essai -c user.email=essai@example.org commit -qm cible
```

#### Lancer

**Machine éveillée, humain présent.** Une approbation expire au bout de
quinze minutes, et un portable capot fermé se met en veille : c'est ce qui a
fait échouer le premier essai. Le daemon ne s'en défend pas — ses délais
suivent l'horloge murale, la veille les consomme. Dans un terminal à part,
pendant tout l'essai :

```bash
caffeinate -dims
```

Au dashboard, « Nouvelle tâche » : profil `orchestrator`, dossier
`~/midgaard-essai-rea` (chemin absolu), objectif :

> Le dossier `cible/` contient une application web compilée et minifiée, sans
> ses sources. Avec l'outil d'analyse de rétro-ingénierie disponible pour les
> exécutants, explique comment cette application décide de se recharger
> d'elle-même après une reconnexion au serveur, avec les preuves (fichier,
> fonction, chaîne) et ce qui reste incertain.

Profils : `orchestrator` et `researcher` sur `venice`, modèle
`deepseek-v4-flash-0731` (tarifé, appelle des outils). Limites des profils :
orchestrateur 0,5 $ pour **tout l'arbre**, Researcher 12 étapes, 300 s.

#### Ce qu'on constate

| # | Attendu | Ce qui le constate |
|---|---|---|
| R1 | `mcp add` teste REA : catalogue lu, nombre d'outils, aucun processus REA ensuite | CLI, `ps` |
| R2 | Seuls des outils lus et cochés sont libres ; leur empreinte est enregistrée | `mcp tools rea` |
| R3 | **Venice accepte les schémas des outils de REA** dans la liste d'outils | premier appel du Researcher sans erreur 400 |
| R4 | REA démarre au départ de la sous-tâche, dans `~/midgaard-essai-rea` ; la timeline dit « serveur MCP rea : N outil(s), M libre(s) » | timeline |
| R5 | L'orchestrateur délègue au Researcher, ou crée un exécutant à partir de lui avec `rea` ; dans ce cas l'arbre montre l'agent et son rôle | carte « Sous-tâches » |
| R6 | Un outil REA non coché attend l'humain, serveur, outil et arguments exacts sous les yeux | approbations |
| R7 | **La réponse est juste** : relecture de `index.html`, comparaison du script, rechargement s'il diffère | résultat |
| R8 | Le résultat est **non fiable** | résultat |
| R9 | Chaque coût a sa provenance ; l'arbre reste sous 0,5 $ ; le coût du catalogue se lit dans les jetons d'entrée du premier appel du Researcher | base, carte « Sous-tâches » |
| R10 | Aucun processus REA après la fin | `ps` |

Échec du produit : un outil non coché qui part sans l'humain, un coût sans
provenance ou au-delà du budget de l'arbre, un processus REA survivant, une
tâche qui démarre sans ses serveurs. Échec de l'essai, à rejouer : un modèle
qui n'emploie pas REA, épuise ses étapes, ou se trompe sur la cible.

Ce que l'essai ne couvre pas : Ghidra et un binaire natif (second essai, après
avoir tranché les limites), un processus REA partagé par arbre.

### Étape 7 — premier essai, non conclu (2026-11-06)

Lancé par l'API avec l'objectif du protocole ; REA déclaré (`mcp add`),
donné au Researcher, **aucun outil coché**. Le daemon en marche datait de la
veille (protocole 13, base en v10) : `harness start` l'a remplacé, et la
base a été migrée à son démarrage.

**Ce qui a marché.** R1 : `mcp add` a lu 207 outils en 3,9 s, aucun
processus REA ensuite. R3 : **Venice accepte les 207 outils** — 61 548
jetons d'entrée au premier appel du Researcher, 0,0082 $ facturés ; au
deuxième, 61 696 jetons resservis par le cache du fournisseur. R4 : REA
démarré au départ de la sous-tâche, « serveur MCP rea : 207 outil(s), 0
libre(s) ». R5 : l'orchestrateur a délégué au Researcher. R6 : le premier
appel REA (`binary_session {}`) a attendu un humain, serveur, outil et
arguments sous les yeux. Chaque coût a sa provenance (`provider`).

**Ce qui a fait échouer l'essai.** Personne n'a approuvé, et le capot s'est
fermé six minutes après le départ (`pmset -g log` : *Clamshell Sleep* à
08:49 UTC, puis des réveils de maintenance). L'approbation a expiré à son
quart d'heure, au réveil suivant ; l'orchestrateur a fait la recherche
lui-même, puis relancé un Researcher dont le premier appel de modèle est
parti juste avant une nouvelle veille ; à l'heure d'horloge murale,
l'orchestrateur a fini `timed_out` et sa cascade a annulé le Researcher.
Les appels de modèle « bloqués » quinze et trente et une minutes n'étaient
que la veille : ni défaut du fournisseur, ni du délai de 180 s.

**Deux défauts réels, trouvés en lisant la timeline.**

1. **`search_files` prenait `glob: "*.js"` à la lettre.** Le Researcher avait
   passé `.js` et trouvé ; l'orchestrateur a passé `*.js` et reçu sept fois
   « aucune correspondance » — jusque sur `react` et sur le CSS —, puis il a
   conclu que l'outil était cassé et l'a écrit au Researcher suivant. C'est
   le faux négatif de la Slice 2 revenu par une autre porte. Désormais
   `*.ext` et `**/*.ext` sont lus comme le suffixe, les autres jokers
   refusés avec la forme attendue, et un filtre qui ne retient aucun fichier
   le dit. En chemin : une ligne longue (le bundle tient sur une ligne de
   1,25 Mo) était rendue par ses 300 premiers caractères, la même pour chaque
   motif ; elle l'est désormais autour de chaque occurrence, avec sa
   colonne, et un fichier sauté (plus de 2 Mo, binaire) est compté dans la
   réponse.
2. **« Refusé par un humain » sans humain.** Le Researcher avait demandé
   deux outils REA dans la même étape. Le premier a expiré ; pour le second,
   aucune demande n'a pu être créée — la tâche était finie —, et la boucle
   l'a inscrit « refusé par un humain ». Même faute pour une tâche annulée
   pendant une attente (cascade d'un parent, annulation, arrêt du daemon) :
   l'annulation de la tâche était journalisée comme un refus de l'opération.
   `ApprovalOutcome` gagne `cancelled` (« tâche arrêtée avant la décision
   humaine ») et `not_asked` (« tâche arrêtée : aucune approbation
   demandée ») ; seul le refus d'un humain sur cette opération nomme un
   humain. C'est la suite de la leçon de la Slice 7 sur l'approbation
   expirée.

Les deux sont prouvés par des tests vus échouer sans leur correctif
(`tests/unit/tools.test.ts`, `tests/unit/conversation.test.ts`).

**Coût, et un écart qui n'est pas le nôtre.** L'arbre a coûté 0,0258 $
(orchestrateur 0,0153 $, premier Researcher 0,0106 $, second 0 $). Le solde
Venice a baissé de 0,5248 $ dans le même temps ; mais depuis le relevé du
2026-11-03 il a baissé de 4,96 $ quand Midgaard n'en a dépensé que 0,06 $ :
la clé sert ailleurs. L'historique de facturation de Venice
(`/billing/usage-history`) exige une clé d'administration ; R9 ne peut donc
pas se conclure par le solde tant que la clé est partagée.

**Pour le second passage** : machine éveillée (`caffeinate`), l'humain
présent pour les approbations, et la cible préparée **sans sa source map**
(la première préparation l'avait copiée ; elle a été retirée avant le
lancement, et la commande du protocole corrigée).

### Étape 7 — second essai, non conclu (2026-11-06)

Relancé sur le daemon corrigé, machine maintenue éveillée (`caffeinate`).
L'auteur avait coché cinq outils REA de lecture : « serveur MCP rea : 207
outil(s), 5 libre(s) ».

**Ce qui a marché.** Les deux correctifs du premier essai : l'orchestrateur
emploie `glob: "*.js"` et trouve, et chaque occurrence dans le bundle d'une
ligne arrive avec sa colonne. **La réponse est juste (R7)** : l'orchestrateur
a établi, preuves à l'appui, que la page relit `/`, compare le script de
module désigné au sien (`Rn`, `Mn`) et se recharge s'il diffère, sur un
calendrier de reconnexion (`Vn`). Aucun processus REA après la fin (R10) ;
chaque coût a sa provenance ; l'arbre a coûté 0,087 $ (orchestrateur
0,0345 $, Researcher 0,0529 $), sous le budget de 0,5 $ (R9).

**REA n'a pas servi.** Ni le Researcher ni l'orchestrateur ne l'ont appelé :
pour cette cible, la recherche textuelle suffisait. Le catalogue a pourtant
coûté : 62 379 jetons d'entrée au premier appel du Researcher, 877 084 sur
ses dix appels. L'essai n'éprouve donc toujours pas un appel REA de bout en
bout (approbation, encadrement, résultat non fiable).

**Ce qui a fait échouer l'essai : deux défauts de la boucle.**

3. **La relance valait pour toute la tâche.** Le modèle (`deepseek-v4-flash-0731`,
   un modèle de raisonnement) a passé 4 095 de ses 4 096 jetons de sortie à
   réfléchir dès le premier appel du Researcher : coupé, relancé, il a
   continué. À l'étape 10, sa synthèse a été coupée de même, et la tâche a
   échoué **sans relance** — `nudged` n'était jamais remis à zéro —, sous un
   message qui disait « 2 fois, relance comprise ». La relance se rouvre
   désormais après chaque réponse qui appelle un outil, et celle qui suit une
   coupure dit au modèle le plafond, raisonnement compris.
4. **L'agent ne voyait pas venir la fin.** L'orchestrateur a écrit « The
   picture is complete » à l'étape 13, puis vérifié trois détails, et atteint
   la limite de 16 étapes sans `submit_result`. Ses limites lui sont dites au
   départ, mais rien ne les lui rappelle. La boucle le prévient désormais à
   deux appels de la limite, puis au dernier (`STEPS_WARNING`).

Les deux sont prouvés par des tests vus échouer sans leur correctif
(`tests/unit/agent-runtime.test.ts`). En chemin, le faux fournisseur de ce
test gardait la liste des messages par référence : un test qui lit ce qu'un
appel a reçu voyait l'état final. Il en garde désormais une copie.

**Pour le troisième passage** : le plafond de sortie de 4 096 jetons est trop
bas pour un modèle de raisonnement ; le relever est un acte de l'auteur
(`harness agents limits researcher --max-output-tokens 16384`, confirmé).
Pour éprouver REA lui-même, il faudra une cible où la recherche textuelle ne
suffit pas — un binaire, donc le second essai prévu, avec Ghidra.

### Étape 7 — troisième essai, conclu sur la cible JavaScript (2026-11-06)

Même cible, même objectif, daemon redémarré sur les correctifs de la boucle,
plafond de sortie du Researcher relevé par l'auteur à 16 384 jetons
(journalisé « max_output_tokens 4096 → 16384, par cli »).

| # | Constat |
|---|---|
| R1 | `mcp add` : 207 outils lus, aucun processus REA ensuite (premier essai) |
| R2 | 5 outils cochés par l'auteur, « 207 outil(s), 5 libre(s) » au départ |
| R3 | Venice accepte les 207 outils, à chaque essai |
| R4 | REA démarré au départ de la sous-tâche, dans `~/midgaard-essai-rea` |
| R5 | **L'orchestrateur a créé un exécutant** (`create_agent`) : « REA JS analyser », base `researcher`, serveur `rea`, son rôle ajouté après la consigne du profil, limites du profil de base ; puis l'a délégué et attendu |
| R6 | **Non éprouvé** : aucun outil REA appelé, donc aucune approbation |
| R7 | **Juste.** Le hook `Gn` ; à une reconnexion sans jeton, après une première ouverture (`o.current`), `Rn()` relit `/` et compare le script de module désigné au sien ; différent → `location.reload()`, sinon nouveau bootstrap. Calendrier `Vn=[300,700,1500,3e3,6e3,1e4]`. Comparé à `apps/dashboard/src/lib/useHarness.ts` : condition, ordre et tableau identiques (`everOpenRef`, `servedBundleChanged`, `BACKOFF_MS`). Il a aussi relevé la source map référencée mais absente, et la seconde occurrence de `location.reload()` (le bouton de la frontière d'erreur) |
| R8 | Résultat **non fiable** : l'exécutant a fait une recherche web native |
| R9 | 0,0723 $ pour l'arbre (orchestrateur 0,0099 $, exécutant créé 0,0624 $), tout `provider`, sous le budget d'arbre de 0,5 $ ; le catalogue pèse ~62 000 jetons par appel de l'exécutant (937 080 jetons d'entrée en dix appels) |
| R10 | Aucun processus REA après la fin |

Les correctifs de la boucle n'ont pas eu à jouer : l'exécutant a conclu à
l'étape 10 sur 12, l'orchestrateur à la 8e sur 16, sans réponse coupée. Le
plafond de 16 384 jetons a suffi.

**Ce que la cible JavaScript ne pouvait pas prouver.** Le rôle donné par
l'orchestrateur disait d'employer REA ; l'exécutant ne l'a pas fait, et il
avait raison : `search_files` trouvait tout. Aucun appel REA n'a donc
traversé la chaîne réelle — approbation sur arguments exacts, encadrement,
résultat d'un serveur MCP marqué non fiable. Ces maillons sont prouvés par
X10 à X13 contre le faux serveur, pas contre REA. Il faut pour cela une
cible où la recherche textuelle ne suffit pas : un binaire, donc le second
essai prévu, avec Ghidra (relever d'abord `--timeout` du Researcher).

### Les limites d'un profil se règlent (2026-11-05)

Tranché avec l'auteur avant le second essai (voir « Tranché en cours de
route ») : `PUT /api/agents/:id/limits`, `harness agents limits <profil>`
(`--steps`, `--max-cost`, `--timeout`, `--max-output-tokens`,
`--tool-calls`, `--yes`), et un éditeur aux Profils du dashboard.
`PROTOCOL_VERSION` 16.

- **Partiel** : seules les limites données changent ; un corps vide, ou qui ne
  porte que son auteur, est refusé.
- **Borné** par le schéma des limites (1 à 100 étapes, 0 à 1 000 $, 5 à
  3 600 s, 64 à 200 000 jetons, 1 à 20 appels par étape) ; le profil simulé
  refusé.
- **Un relèvement se confirme**, un abaissement non — dans la CLI (refus sans
  terminal sauf `--yes`) comme au dashboard. Relever le budget de
  l'orchestrateur rappelle qu'il couvre tout son arbre.
- **Journalisé** : `profil « researcher » : limites timeout_s 300 → 900, par
  cli — vaut pour les tâches à venir`. Une tâche garde les limites de sa
  création.
- **Le `PATCH` du modèle ignore toujours les limites** glissées dans son corps
  (test de la Slice 5, inchangé) : un réglage de modèle ne relève jamais un
  budget en passant.

Les preuves : quatre tests de la route et de la CLI dans
`tests/unit/http-agents.test.ts` (changement partiel, tâche existante
inchangée, bornes, corps vide, profil simulé, lecture des options) ; D18 dans
`test:ui` — relèvement refusé à la confirmation : rien ne change ; confirmé :
changé en base ; abaissement sans confirmation.

Verte en CI sur trois plateformes (passages `42182564486` « Bout en bout »
et `42182567697` « Worktrees »). Les passages lancés par le push
(`42065138919`, `42065138959`) n'avaient rien prouvé sur macOS : le poste n'a
jamais reçu de machine, GitHub l'a annulé au bout de quinze minutes sans
qu'aucune étape ait tourné. Un poste annulé n'est pas un poste vert ; ils ont
été relancés sur le même commit.

