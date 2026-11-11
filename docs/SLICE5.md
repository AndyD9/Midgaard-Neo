# Slice 5 — Un orchestrateur intégré, sur n'importe quel modèle

**Date :** 2026-10-31 · **Objectif :** qu'une tâche puisse être planifiée et
déléguée par un modèle **autre que Claude**, depuis le dashboard, sans Claude
Code : un profil `orchestrator` qui tourne dans le daemon, sur le fournisseur et
le modèle choisis (Venice, OpenAI, Gemini, compatible OpenAI), et qui délègue
lui-même aux autres profils.

**État : terminée** (démarrée et terminée le 2026-11-01). Avant elle :
décisions prises, découpage arrêté, aucune ligne de code. Elle attendait l'étape 8 de la Slice 4 — ce qui existe
devait avoir fait ses preuves avant qu'on y ajoute un orchestrateur : c'est
fait le 2026-11-01, depuis un clone frais ([SLICE4.md](SLICE4.md)). Les
quatre constats de cet essai sont réglés (leçons n° 30 à 33), dont deux qui la
touchent : la consigne d'approbation d'une sous-tâche se lance d'où qu'on la
lise et vise le bon dossier runtime, et le dashboard dit quelle installation
il sert.

---

## Ce que la Slice 5 renverse

Le document d'origine excluait « l'orchestration autonome depuis le dashboard
sans Claude Code » et voulait un produit « Claude-driven uniquement pour le
MVP » ([MVP_AGENT_HARNESS_PLAN.md](MVP_AGENT_HARNESS_PLAN.md)). Le MVP est
livré ; l'auteur lève cette limite. Claude Code reste un orchestrateur — par
MCP, inchangé — mais n'est plus le seul.

## Les décisions prises avec l'auteur

| Question | Réponse retenue |
|---|---|
| Que veut dire « un autre modèle » ? | **Un orchestrateur intégré au daemon**, et non seulement d'autres clients MCP (Codex, Gemini CLI…) |
| D'où le lance-t-on ? | **Du dashboard seulement** : un formulaire « Nouvelle tâche ». Pas de commande CLI |
| Comment compte-t-il son budget ? | **Budgets séparés** : chaque tâche compte ses propres appels ; pas de plafond d'arbre |
| Quand ? | **Après la Slice 4** |

**Budgets séparés : ce que cela coûte.** Le coût total d'un arbre n'a pas de
plafond déclaré. Il en a un de fait : l'orchestrateur ne peut lancer plus de
`max_steps × max_tool_calls_per_step` sous-tâches, chacune bornée par son
profil. Le dashboard affiche ce **plafond théorique** et le **total de
l'arbre** ; le total porte la plus faible des provenances de ses tâches
(`unknown` dès qu'une l'est) — aucun montant sans sa provenance.

## Ce que le code offre déjà

- `TaskManager.create()` et `wait()` sont des méthodes asynchrones en
  mémoire : une tâche peut en créer et en attendre une autre sans bloquer le
  daemon.
- Approbations, annulation coopérative, encadrement `<untrusted_data>`,
  `tightenLimits` : réutilisés tels quels.
- Manquent : le lien parent → enfant, le choix du fournisseur et du modèle par
  profil (`/api/agents` n'accepte que `GET`), la création d'une tâche hors MCP,
  et un `ToolContext` qui atteigne le `TaskManager`.
- Le serveur MCP ne vérifie nulle part le nom de son client. Trois consignes
  **lues par les modèles** nomment en revanche « Claude Code » (`daemon/src/agents.ts`,
  `agent-runtime/src/context.ts`), plus un message d'erreur du moteur d'agent.

## Décisions de conception

1. **Profondeur 1.** Un orchestrateur délègue à tout profil actif, **sauf**
   `orchestrator`. Pas d'arbre récursif, pas de coût qui s'emballe.
2. **L'orchestrateur n'approuve rien.** Aucun outil d'approbation ne lui est
   donné — le même invariant que pour Claude. Une sous-tâche en
   `waiting_approval` attend l'humain ; l'orchestrateur attend avec elle.
3. **Attendre ne coûte pas d'étapes.** `wait_for_task` bloque en mémoire
   jusqu'à la fin de la sous-tâche, l'annulation ou l'échéance du parent. Pas
   de tranches de 15 s : la coupure à 60 s est propre aux clients MCP, et chaque
   retour au modèle serait une étape payée. Un événement `subtask.waiting` dit
   au dashboard qui le parent attend.
4. **Le résultat d'un enfant est de la donnée.** Encadré en `<untrusted_data>`
   avec nonce avant d'être réinjecté : un Researcher remonte du web.
5. **Aucun orphelin.** Annuler le parent annule ses enfants actifs ; un parent
   qui se termine, pour quelque raison que ce soit, annule ceux qui restent. Au
   démarrage, la règle `interrupted` couvre déjà tout l'arbre.
6. **Les limites restent celles des profils.** L'orchestrateur peut abaisser
   celles d'un enfant (`tightenLimits`), jamais les relever.
7. **Le harness ne merge toujours jamais.** Le résultat de l'orchestrateur
   liste les branches `midgaard/…` de ses Developer ; le merge reste humain.
8. **`parent_task_id` est posé par le daemon seul.** Absent de la requête de
   création : ni MCP ni le dashboard ne peuvent rattacher une tâche à une autre.
9. **`project_dir` saisi au dashboard est une source nouvelle.** Jusqu'ici il
   venait des `roots` du client MCP. Il est canonicalisé, doit exister, être un
   dossier, et n'être ni la racine du système ni le dossier personnel lui-même.
   Les enfants l'héritent du parent, jamais du modèle.

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | Neutraliser « Claude Code » dans ce que lisent les modèles : consignes du Researcher et du Developer, contexte assemblé, message d'erreur | **fait** |
| 2 | Contrats et persistance : `kind` `orchestrator`, `parent_task_id` (migration 8), `PATCH /api/agents/:id` pour choisir fournisseur et modèle, `PROTOCOL_VERSION` 10 | **fait** |
| 3 | Les outils de délégation : `list_agents`, `delegate_task`, `wait_for_task`, `cancel_task` derrière un `DelegationPort` du `ToolContext` — sans lui, ils refusent ; cascade d'annulation | **fait** |
| 4 | Le profil `orchestrator` : consigne, outils en lecture plus délégation, ni écriture, ni `exec`, ni web ; désactivé sans fournisseur, avec son motif | **fait** |
| 5 | Le dashboard : formulaire « Nouvelle tâche », tâches en arbre, carte « Sous-tâches » (total et plafond théorique), choix du modèle par profil | **fait** |
| 6 | Preuves : `test:orchestrator` (vrai daemon, faux fournisseur : délégation parallèle, approbation d'un enfant, annulation en cascade, `SIGKILL`), ajouts à `test:security` et `test:ui`, CI sur trois plateformes | **fait** — CI constatée au passage `41307159340` |
| 7 | L'essai réel : un orchestrateur non-Claude lancé du dashboard, un Developer enfant sous approbation, chaque coût comparé à la facture | **fait** — C1 à C9 constatés, coût exact |

### Ce que chaque étape doit surveiller

- **Étape 3.** Compter les tâches actives en base après l'annulation du parent,
  pas l'effet visible depuis un client : c'est ainsi qu'un bug de verrou était
  passé inaperçu.
- **Étape 5.** Le formulaire ne doit proposer que des profils actifs, et dire
  pourquoi les autres ne le sont pas — un profil sans fournisseur est montré
  désactivé avec son motif.
- **Étape 7.** Le scénario n'est pas prouvé tant qu'il n'a pas tourné contre un
  vrai fournisseur ; ne rien écrire avant de l'avoir constaté.

## Récit

### Étape 1 — ce que lisent les modèles ne nomme plus Claude (2026-11-01)

Trois textes remis aux modèles disaient « Claude Code » : les consignes du
Researcher et du Developer (« An orchestrator (Claude Code) delegated… ») et
l'en-tête du contexte (« This was assembled by Claude Code… »). Ils disent
désormais « an orchestrator », et le contexte « the orchestrator that delegated
this task, from what it already explored » — vrai pour Claude comme pour
l'orchestrateur intégré, qui aura des outils de lecture.

Le message d'erreur du moteur sur un `project_dir` manquant ne s'adresse pas au
modèle mais à l'humain ; il ne nomme plus de client non plus, puisqu'une tâche
naîtra aussi du dashboard. Le cas reste celui d'un serveur MCP trop ancien.

**La preuve porte sur le texte entier, pas sur les phrases retouchées.** Le test
« neutralité envers l'orchestrateur » (`tests/unit/agent-runtime.test.ts`)
assemble, pour chaque profil livré, tout ce que reçoit le modèle — consigne,
limites, worktree, contexte — et refuse `claude` et `anthropic` sans égard à la
casse. Il a été vu échouer en réintroduisant l'ancienne phrase du Developer :
une ligne ajoutée plus tard qui citerait Claude ne passera pas.

Ni la base ni le protocole ne changent : les consignes des profils livrés sont
réécrites à chaque démarrage du daemon (`ensureBuiltinAgents`), et
`PROTOCOL_VERSION` reste 9.

### Étape 2 — contrats et persistance (2026-11-01)

**Ce qui existe.** Le type de profil `orchestrator` ; `tasks.parent_task_id`
(migration 8, clé étrangère `ON DELETE CASCADE` et index) ; `parent_task_id`
sur chaque tâche et dans le `task.created` d'un enfant ; `PATCH
/api/agents/:id` ; `PROTOCOL_VERSION` 10.

**`parent_task_id` n'entre que par le daemon.** Le champ est absent de
`POST /api/tasks` ; zod écarte les clés inconnues, et un test envoie le champ
puis lit la tâche **en base** pour constater qu'elle n'a pas de parent. Le
dépôt l'accepte (`createTask({ parentTaskId })`) et le bus le transmet ; le
`TaskManager` ne le pose pas encore — ce sera l'outil `delegate_task` de
l'étape 3, seul appelant prévu. Un parent inexistant fait lever la clé
étrangère, sans tâche ni événement écrit : c'est un bug du daemon, pas une
saisie.

**`PATCH /api/agents/:id` ne règle que le fournisseur et le modèle.** Les
limites restent hors de l'API, même glissées dans le corps (testé) : le
dashboard est servi à tout onglet qui passe l'enveloppe, et un budget qu'un
client pourrait relever ne protégerait personne. Les règles
(`updateAgentModel`, `daemon/src/agents.ts`) :

- le profil simulé refuse (`409 agent_has_no_model`) ;
- un fournisseur non déclaré est refusé (`404 provider_not_found`, avec la
  liste de ceux qui existent) ; l'accepter, c'était voir le profil désactivé
  au démarrage suivant par `reconcileAgents`, sans erreur visible ;
- changer de fournisseur sans dire de modèle remet le modèle à `null` (celui
  par défaut du nouveau) : un nom de modèle n'a de sens que chez son
  fournisseur ;
- un corps vide est un `400` : il ne demande rien, et l'accepter laisserait
  croire qu'un réglage a été pris ;
- le changement vaut pour les tâches créées ensuite ; une tâche en cours
  garde l'adaptateur reçu à son départ.

**Le type avant le profil.** `orchestrator` est connu des contrats et de la
base dès maintenant, mais aucun moteur ne le sert : un profil de ce type,
même actif, est refusé par `TaskManager.create` (`503 engine_unavailable`)
sans qu'aucune tâche soit créée. Le commentaire de `AGENT_KINDS` l'affirmait ;
un test le prouve (`tests/unit/http-agents.test.ts`).

**Preuves.** `tests/unit/http-agents.test.ts`, nouveau, démarre un vrai daemon
dans le processus de test (coffre fichier, fournisseurs écrits sans clé) et
couvre le `PATCH`, le `parent_task_id` glissé par un client et le refus du
type sans moteur ; `tests/unit/store.test.ts` couvre la migration 8 sur une
base arrêtée au schéma 7, le parent et son récit, et le refus d'un parent
inexistant sans rien écrire.

### Étape 3 — les outils de délégation (2026-11-01)

**Ce qui existe.** Les quatre outils (`packages/tools/src/delegation.ts`), le
`DelegationPort` qu'ils appellent (`ToolContext.delegation`), son
implémentation par le `TaskManager` (`delegationFor`), la cascade
d'annulation, l'événement `subtask.waiting`, et `childTasks` au dépôt. Le
moteur d'agent pose le port pour un profil `orchestrator` et pour lui seul —
câblage qui ne sert qu'à partir de l'étape 4 : aucun moteur ne sert encore ce
type.

**Où vivent les règles.** Dans `TaskManager.create`, pas dans les outils :
parent existant et actif (ni fini, ni en `cancel_requested`), parent
orchestrateur, enfant qui n'en est pas un, dossier du parent imposé. Une
seconde copie dans l'outil aurait fini par diverger. Le port ne voit que les
sous-tâches de sa tâche, et répond la même chose pour une tâche inconnue et
pour celle d'un autre arbre.

**Ce qui a été décidé en écrivant.**

- **L'expurgation passe au port.** L'objectif, le contexte et le motif
  d'annulation sont écrits par le modèle de l'orchestrateur, qui a pu lire une
  clé dans le projet, puis persistés. Le plan n'en disait rien ; l'invariant
  « tout ce qui est persisté passe par `createRedactor` » l'imposait. Le port
  reçoit donc le `redact` de la tâche parente (`EngineContext.delegationFor`).
- **La cascade écoute le bus**, sur `cancel_requested` comme sur tout statut
  final : annuler dès la demande, sans attendre que le parent ait atteint son
  point de contrôle. Elle est **différée d'une micro-tâche** pour ne pas
  écrire les événements des enfants pendant la diffusion de celui du parent.
- **`wait_for_task` marque toujours son résultat non fiable**, message
  d'erreur compris : c'est un modèle qui l'a écrit.
- **`subtask.waiting` ne change pas le protocole** : aucun client ne valide le
  type d'un événement à l'exécution. La timeline du dashboard l'affiche déjà
  (« Attend une sous-tâche ») ; la carte « Sous-tâches » est l'étape 5.

**Preuves.** `tests/unit/delegation-tools.test.ts` : refus sans port pour les
quatre outils, refus du port rendu au modèle, résultat marqué non fiable avec
branche et provenance du coût, et **encadrement dans la boucle réelle** d'un
résultat qui contient la balise de fin. `tests/unit/delegation.test.ts`, sur un
vrai daemon dont l'orchestrateur et le Researcher ont un moteur pilotable :
règles de rattachement, attente qui traverse une pause d'approbation, échéance
et arrêt du parent, cascade sur annulation et sur les quatre fins (tâches
actives **comptées en base**), expurgation de l'objectif et du contexte.

Les tests ont été vus échouer en retirant tour à tour la cascade (6 échecs),
l'expurgation, la règle de profondeur, et en laissant une pause d'approbation
interrompre l'attente (un échec chacun).

**Ce qui reste pour la suite.**

- Le résultat de l'orchestrateur lui-même n'est marqué non fiable que s'il cite
  des sources (`finishWith`) : un orchestrateur qui recopie le résultat d'un
  Researcher le rend comme fiable. À trancher à l'étape 4 — la boucle pourrait
  marquer non fiable tout résultat d'une tâche qui a reçu un contenu encadré.
- Le scénario de bout en bout (vrai daemon, faux fournisseur, `SIGKILL`) est
  l'étape 6 ; la suite de sécurité y gagnera un orchestrateur qui recopie une
  clé tierce dans une délégation.

### Étape 4 — le profil `orchestrator` (2026-11-01)

**Ce qui existe.** Le profil livré d'office (`daemon/src/agents.ts`) :
consigne neutre, outils `read_file`, `list_directory`, `search_files` et les
quatre de délégation, ni écriture, ni `exec`, ni web. Désactivé sans
fournisseur, avec son motif, comme les autres. Il tourne sur le moteur
d'agent commun, troisième instance après le Researcher et le Developer, et
seul à recevoir le port de délégation.

**Ses limites par défaut** (`DEFAULT_ORCHESTRATOR_LIMITS`) ne comptent que ses
propres appels : 16 étapes, 4 appels d'outils par étape, 0,50 $, une heure.
Le délai est le maximum permis, parce qu'il attend ses sous-tâches,
approbations comprises ; étapes et appels par étape restent modestes parce
que leur produit — **64** — est le plafond théorique de sous-tâches de
l'arbre, celui que le dashboard affichera.

**Deux décisions prises avec l'auteur en cours d'étape.**

1. **Claude ne délègue pas à un orchestrateur.** Le serveur MCP ne le montre
   pas dans `harness_list_agents` et refuse `harness_delegate_task` vers lui,
   avant toute création. Fidèle à « lancé du dashboard seulement », et
   cohérent avec la profondeur 1 vue de Claude. Le refus vit dans le serveur
   MCP parce que le daemon ne distingue pas ses clients. Scénario S13 de
   `test:wait`.
2. **Un résultat est non fiable dès que la tâche a reçu un contenu encadré**,
   cité ou non — page, sortie de commande, résultat d'une sous-tâche,
   recherche web native. C'est la question laissée ouverte par l'étape 3, et
   la règle générale comble aussi un trou plus ancien : un Researcher qui
   lisait une page sans la citer rendait un résultat « fiable ». Coût assumé :
   tout Developer qui lance une commande rend un résultat non fiable, encadré
   avant de remonter à Claude. Le badge du dashboard dit désormais « contenu
   extérieur », et la note jointe par le serveur MCP nomme les trois sources.

**Preuves.** `tests/unit/orchestrator-engine.test.ts`, nouveau : un vrai
daemon, le vrai moteur et un faux fournisseur ; l'orchestrateur appelle
`list_agents` et `delegate_task` (prouvant que le moteur pose le port — le
test a été vu échouer sans), la sous-tâche est rattachée sur le dossier du
parent, et la cascade l'emporte quand le parent rend son résultat : aucune
tâche active en base ensuite. `http-agents.test.ts` remplace le test de
l'étape 2 (« type sans moteur ») par ce que promet le profil : désactivé avec
son motif, actif avec un fournisseur, sans écriture ni `exec` ni web, seul à
porter les outils de délégation. `agent-runtime.test.ts` : la consigne de
l'orchestrateur rejoint le test de neutralité, et deux tests fixent la règle
du non-fiable (sortie de commande sans citation → non fiable ; lecture du
projet seule → fiable).

### Étape 5 — le dashboard (2026-11-01)

**Ce qui existe.** Deux routes de plus : `#/new`, le formulaire « Nouvelle
tâche », et `#/agents`, les profils avec leur fournisseur et leur modèle
(`PATCH /api/agents/:id`). La liste des tâches est un arbre ; l'inspecteur
d'un orchestrateur porte la carte « Sous-tâches », celui d'une sous-tâche un
lien vers son parent. Côté daemon, `checkProjectDir` vérifie le dossier de
projet à la création (décision 9) ; `HarnessConfig.userHome` lui donne le
dossier personnel, injecté.

**Ce qui a été décidé en écrivant.**

- **La vérification du dossier s'applique à toute tâche qui lit**, MCP compris,
  pas au seul formulaire : le daemon ne distingue pas ses clients. Elle ne
  gêne pas une session ouverte sur un dépôt ; elle refuse désormais une
  session Claude Code ouverte sur `~` ou sur `/`, qui donnait jusqu'ici à un
  agent tout le dossier personnel à lire. Le profil simulé n'est pas vérifié,
  il ne lit rien. Le guide de dépannage cite les cinq motifs.
- **Le motif d'un profil désactivé est calculé au dashboard** (`lib/agents.ts`)
  depuis les profils et fournisseurs que l'API rend déjà, plutôt qu'en ajoutant
  un champ au protocole : la règle tient en deux cas, ceux de
  `TaskManager.whyDisabled`.
- **Le total de l'arbre ignore une tâche qui n'a appelé aucun modèle** : sans
  cela, une sous-tâche simulée ou échouée avant tout appel — provenance
  `unknown` par défaut — rendrait inconnu un total dont tous les termes sont
  connus.
- **Le faux fournisseur sait attendre** : `{{task_id}}` dans un argument est
  remplacé par le dernier identifiant de sous-tâche lu dans la conversation.
  Sans état côté serveur, le scénario d'un orchestrateur peut enfin appeler
  `wait_for_task` ; `orchestrator-engine.test.ts` en profite.

**Preuves.** `test:ui` passe de 8 à 11 scénarios, tous verts : D9, le
formulaire sans fournisseur ne propose que `simulated` et nomme les autres
avec leur motif, puis lance une tâche ; D10, le modèle d'un profil se choisit
à l'écran, en base ensuite, limites intactes ; D11, un orchestrateur lancé du
formulaire — `/` refusé avec son motif, puis le vrai dossier — délègue,
attend et termine ; la sous-tâche est rangée sous lui, la carte affiche
« 1 lancée(s) sur 64 » et le total avec la provenance la plus faible, et les
liens mènent de l'un à l'autre. En unitaire : `dashboard-tree.test.ts`
(rangement, total et provenance, plafond, motif), `project-dir.test.ts`
(chemin relatif, absent, fichier, racine, dossier personnel même par un lien
symbolique, dans les deux sens), deux cas HTTP dans `http-agents.test.ts`.
Les écrans ont aussi été relus en capture, sur bureau et à 390 px de large.

### Étape 6 — les preuves (2026-11-01)

**`test:orchestrator`** (`tests/orchestrator.ts`), nouvelle suite : un vrai
daemon, de vrais dépôts, le faux fournisseur, et chaque effet vérifié **en
base** sur une connexion en lecture seule.

- **O1** — deux délégations dans la même étape ; le Researcher finit pendant
  que le Developer attend l'humain sur une commande. L'orchestrateur reste
  `running`, écrit `subtask.waiting` désignant le Developer, et aucune
  approbation n'est demandée à son nom. L'humain approuve ; tout l'arbre
  termine. Quatre tours scriptés, **quatre appels de modèle** : attendre ne
  coûte pas d'étape. Le résultat de l'orchestrateur est non fiable.
- **O2** — deux Developer en pause d'approbation ; l'orchestrateur est annulé
  comme au dashboard : **zéro sous-tâche active en base**, motif « tâche
  parente annulée », aucune approbation pendante, aucune commande lancée
  dans leurs worktrees. Vu échouer en retirant la cascade (2 actives restent).
- **O3** — `SIGKILL` pendant que l'orchestrateur attend un Developer en pause :
  au redémarrage, l'arbre entier est `interrupted`, l'approbation expirée, le
  worktree conservé, et rien n'est repris.
- **O4** — déléguer à `orchestrator` est refusé ; 1 000 $ demandés pour un
  Researcher donnent le plafond de son profil.

Le faux fournisseur reprend l'identifiant des sous-tâches qu'il a vues
(`{{task_id:N}}`, le N-ième ; `{{task_id}}`, le dernier) : sans état, un
orchestrateur scripté peut attendre une sous-tâche précise.

**`test:security`, X5** — un orchestrateur lit `config/secrets.env`, recopie
la clé tierce dans l'objectif et le contexte d'une délégation, puis dans le
motif de son annulation. Les trois sont expurgés en base (le marqueur y est,
la clé non), et la base et le journal, lus octet pour octet, n'en contiennent
rien.

**`test:ui`** avait reçu ses trois scénarios à l'étape 5 (D9 à D11).

**La CI** gagne l'étape `test:orchestrator` dans `.github/workflows/e2e.yml`,
sur macOS, Linux et Windows. **Constatée** au passage `41307159340` (le
2026-11-01) : sur les trois postes, `test:orchestrator` 4/4, `test:security`
5/5 (X5 compris), `test:ui` 11/11, et toutes les autres suites au vert ;
`worktrees.yml` vert aussi (passage `41307159277`).

#### Leçon n° 35 — une annulation pendant la préparation finissait `failed`

X5 a échoué au premier passage, et pas sur une fuite : l'enfant annulé finissait
`failed` sur « erreur inattendue du moteur : transition interdite …
cancel_requested → running ». Le défaut date de la Slice 2 : une tâche annulée
**pendant sa préparation** — lecture de la clé, et surtout création du worktree
d'un Developer — passe en `cancel_requested`, puis le moteur, sorti de son
attente, écrit `preparing` ou `running`, que la machine à états interdit
depuis ce statut. Personne n'annulait si tôt ; la cascade le fait, puisqu'un
orchestrateur annule des sous-tâches qui viennent de naître.

Corrigé par un point de contrôle après chaque attente de la préparation
(`AgentEngine.execute`, `cancelledNow`). Le même passage a montré un second
défaut, plus discret : quand c'est le moteur qui conclut une annulation à son
point de contrôle, il ne connaît plus le motif, et l'enfant finissait sur
« annulée à la demande de l'utilisateur » au lieu de « tâche parente
annulée ». Le motif est désormais relu dans le journal (`cancelRequestReason`).
Le test de régression (`orchestrator-engine.test.ts`, « annulation pendant la
préparation ») a été vu échouer sans le correctif.

La leçon générale tient de celle de la Slice 4 : **une nouvelle manière
d'appeler un code ancien en trouve les fenêtres**. La cascade n'a rien de
faux ; elle annule simplement plus tôt que ne l'avait jamais fait un humain.

### Étape 7 — l'essai réel (2026-11-01)

*Comme aux Slices 3 et 4, le protocole est écrit avant l'essai et n'est pas
retouché après coup ; les résultats viennent en dessous.*

#### Le terrain

- **Installation** : l'installation de travail (ce clone, `1eb61a5`, runtime
  `~/.midgaard`), daemon redémarré sur le code de la Slice 5 — protocole 10, la
  base passe du schéma 7 au schéma 8 à son démarrage, port 7777.
- **Projet** : `~/Documents/midgaard-demo` à `dea8375`, arbre propre,
  `npm test` 2/2, sans route `/version`.
- **Orchestrateur** : profil `orchestrator` sur le fournisseur `venice`, modèle
  `deepseek-v4-flash-0731` — un modèle qui n'est pas Claude. Limites du
  profil : 16 étapes, 0,5 $, 3 600 s.

#### Le déroulé

1. Relever le solde Venice (`providers test venice`), aucune autre session ne
   se servant de Venice.
2. Au dashboard (`http://127.0.0.1:7777/#/new`), lancer le profil
   `orchestrator`, dossier `/Users/andydodakal/Documents/midgaard-demo`, avec
   l'objectif :

   > Ajoute une route GET /version qui répond 200 avec {"version": "…"}, la
   > version étant lue dans package.json, et un test pour elle dans
   > test/app.test.js, dans le style des tests existants. Le changement doit
   > être vérifié avec npm test.

3. L'orchestrateur lit le projet et délègue lui-même ; aucune sous-tâche n'est
   créée à la main.
4. À chaque approbation demandée par une sous-tâche : l'auteur la lit et décide
   au dashboard. Ni Claude ni l'orchestrateur n'approuvent.
5. À la fin : carte « Sous-tâches », carte « Fichiers et diff » du Developer,
   puis relever le solde.

#### Ce qui sera relevé

| # | Attendu | Ce qui le constate |
|---|---|---|
| C1 | Le formulaire propose `orchestrator`, actif, sur `venice` | dashboard |
| C2 | L'orchestrateur lit le projet, puis délègue à `developer` avec un contexte tiré de sa lecture | timeline, `delegate_task` |
| C3 | La sous-tâche porte `parent_task_id`, hérite de `project_dir`, et paraît en retrait sous son parent | base, liste des tâches |
| C4 | `npm test` suspend le Developer ; l'orchestrateur attend sans approbation à son nom (`subtask.waiting`) | dashboard, base |
| C5 | Approuvée par l'auteur, la commande passe dans le worktree | appel `exec`, code 0 |
| C6 | Developer `completed`, commit à l'identité de l'agent ; l'orchestrateur `completed`, sa synthèse nomme la branche `midgaard/…` | résultats, `git log` |
| C7 | `midgaard-demo` intact : le harness ne merge pas | `git status`, `git log` |
| C8 | Chaque tâche a son coût « facturé par le fournisseur » ; le total de l'arbre porte la même provenance | carte « Sous-tâches » |
| C9 | La somme des coûts de l'arbre égale l'écart du solde Venice | solde avant et après |

Échec du produit : une approbation sans l'humain, une sous-tâche hors de
l'arbre ou d'un autre dossier, une sous-tâche qui survit à son parent, une
écriture hors du worktree, un merge, un coût sans provenance ou qui ne
correspond pas à la facture. Échec de l'essai, à rejouer : un modèle qui ne
délègue pas ou ne conclut pas, un budget trop bas.

#### Relevé avant l'essai

- Daemon redémarré à 13:26 UTC : protocole 10, base migrée au schéma 8.
- **La clé Venice enregistrée est refusée** : `providers test venice` répond
  « clé refusée par le fournisseur (401) », et un appel direct à
  `/api_keys/rate_limits` avec la clé lue dans le trousseau (sans l'afficher,
  63 caractères, décodée de `mg1:`) rend aussi `401`. Ce n'est donc pas le
  harness : la clé n'est plus valide chez Venice. L'essai attend que l'auteur
  la redéclare (`providers add venice`).
- Redéclarée par l'auteur à 16:02 UTC : clé acceptée, solde 7,5846725 $.
  **Mais elle s'est affichée en clair** dans le terminal (leçon n° 36), et
  le solde a baissé de 0,0129 $ entre 16:02:31 et 16:03:32 UTC sans
  qu'aucune tâche Midgaard tourne : la clé sert aussi ailleurs. L'écart du solde ne mesurerait donc pas
  l'arbre. Décision de l'auteur : corriger la saisie d'abord, révoquer cette
  clé et en déclarer une **dédiée à Midgaard** avec la saisie corrigée.

#### Leçon n° 36 — la clé « saisie sans écho » s'affichait en clair

Depuis la Slice 2, `providers add` promettait une saisie sans écho, et le
README le répétait. La fonction posait bien le mode brut du terminal, mais
ouvrait **aussi** une interface `readline` en mode terminal sur l'entrée et la
sortie standard. Cette `readline` gère elle-même l'affichage de la ligne : à
chaque caractère reçu, elle redessine `> ` suivi de tout ce qui a été tapé.
Le mode brut coupe l'écho du terminal, pas celui de `readline`. L'auteur a vu
son invite remplacée par un `>`, puis sa clé en entier.

Aucun test ne regardait **ce qui s'écrivait** pendant la saisie, et le mode
tube (`echo "$CLE" | …`) n'a jamais eu le défaut : seule la saisie au
terminal le montrait.

Corrigé en retirant `readline`, qui ne servait à rien puisque la lecture se
faisait déjà octet par octet (`packages/cli/src/secret-input.ts`, flux
injectables). `tests/unit/secret-input.test.ts` donne à la saisie un faux
terminal et relit toute la sortie : l'invite et le retour à la ligne, rien
d'autre. Le test a été vu échouer avec l'ancienne `readline` remise en place,
sur exactement ce que l'auteur avait vu (`> abc…`). Puis la saisie a tourné
dans un vrai pseudo-terminal (`script`) : l'invite seule, et les 13
caractères lus. *Constaté en CI au passage `41330726373` : le test de la
saisie passe sous macOS, Linux et Windows, avec toutes les autres suites.*

C'est l'invariant « une phrase de documentation est une affirmation à
prouver » (Slice 3, leçon n° 10) : « sans écho » était écrit, jamais vérifié.

#### L'essai — 2026-11-01, 16:59 UTC

Le solde, revérifié avant de lancer : **7,16009597 $**, stable quatre fois de
suite entre 16:58:09 et 16:59:12 UTC, l'autre usage du compte arrêté par
l'auteur. Le formulaire est rempli et soumis depuis le navigateur de la
session ; la session n'y fait **rien d'autre** ensuite.

| # | Verdict | Constat |
|---|---|---|
| C1 | ✅ | `orchestrator` proposé, actif et présélectionné ; « 16 étapes · 0.50 $ · 3600 s — limites du profil », et « jusqu'à 64 sous-tâches » |
| C2 | ✅ | `89a4ea9a` lit `package.json`, `src/app.js`, `test/app.test.js`, `src/server.js`, appelle `list_agents`, puis délègue à `developer` en 4 étapes. Le contexte transmis résume ce qu'il a lu : ESM, Node ≥ 24, le helper `json()`, la forme des tests, et le piège de l'import JSON depuis `src/` |
| C3 | ✅ | `014ec447` porte `parent_task_id` = `89a4ea9a…` et le même `project_dir` ; worktree `midgaard/014ec447` depuis `dea8375`, `base_dirty` 0 ; affichée en retrait sous son parent |
| C4 | ✅ | `exec — exécuter /opt/homebrew/bin/npm test dans …/worktrees/midgaard-demo-56375bb0/014ec447 (délai 120 s)` suspend le Developer ; l'orchestrateur est en `subtask.waiting` sur lui, **aucune approbation à son nom** (0 en base) |
| C5 | ✅ | Accordée depuis le dashboard (`resolved_by: dashboard`) 2 s après la demande, **par l'auteur**, confirmé après coup ; la session n'a fait aucune action dans le navigateur après « Lancer » ; `npm test → code 0 en 0,4 s` |
| C6 | ✅ | Developer `completed` en 8 étapes ; commit `d7087e8` à `Midgaard developer <developer@midgaard.invalid>`, non signé ; `src/app.js` +4, `test/app.test.js` +7. Orchestrateur `completed` en 5 étapes, 1 min 8 s ; sa synthèse nomme `midgaard/014ec447` et `d7087e8`, et rappelle que le merge revient à l'humain |
| C7 | ✅ | `midgaard-demo` : `main` toujours à `dea8375`, arbre propre |
| C8 | ✅ | Orchestrateur 0,00216276 $, Developer 0,004630752 $, tous deux « facturé par le fournisseur » ; « Total de l'arbre : 0.0068 $ facturé, 2 tâche(s) ayant appelé un modèle » |
| C9 | ✅ | Somme **0,006793512 $**. Solde 7,16009597 $ avant, 7,15330246 $ après (17:00:42 UTC) : écart **0,00679351 $**, **exact** à la précision du solde |

Le résultat de l'orchestrateur est marqué « contenu extérieur » : il a reçu le
résultat encadré de sa sous-tâche, et la règle de l'étape 4 s'applique, cité
ou non. L'estimation égale cette fois la facture au microdollar, cache
compris : le tarif caché relevé après la leçon n° 32 tient.

**Ce que l'essai établit.** Un modèle qui n'est pas Claude
(`deepseek-v4-flash-0731` sur Venice), lancé du dashboard sans Claude Code, a
lu un projet, confié le travail à un Developer avec un contexte utile, attendu
l'approbation humaine sans en demander une lui-même, et rendu une synthèse
juste ; chaque coût est celui que Venice a facturé, et leur somme est l'écart
du solde.

**Hors protocole.** Relevé en lisant la base : `tasks.started_at` est `NULL`
pour les 13 tâches de l'installation. La colonne existe, le contrat la porte
et le serveur MCP la transmet à Claude (`harness_get_task_result`), mais rien
ne l'écrit. Défaut ancien, sans lien avec l'orchestrateur.

*Réglé après l'essai.* Comme `ended_at`, c'est une propriété du statut : le
dépôt le pose dans `record()`, à la première entrée en `preparing` ou en
`running`, et ne le déplace plus ; une tâche annulée ou interrompue avant de
quitter la file le garde à `null`, ce que le contrat dit désormais. Trois
tests de `store.test.ts`, et O1 vérifie en base que chaque tâche de l'arbre a
démarré avant de finir et aucun enfant avant son parent. Les deux ont été vus
échouer sans le correctif — O1 sur « orchestrator sans started_at ; developer
sans started_at ; researcher sans started_at ». Les tâches déjà finies gardent
leur `NULL` : on ne réécrit pas l'histoire d'une date qu'on n'a pas relevée.
