> **Plan de réalisation révisé**, approuvé le 2026-10-28. Il part de la spécification d'origine ([MVP_AGENT_HARNESS_PLAN.md](MVP_AGENT_HARNESS_PLAN.md)) et la modifie sur quatre points décidés avec l'auteur (tableau ci-dessous). L'état d'avancement est tenu dans le [README](../README.md) ; les résultats des slices livrées sont dans [SLICE0.md](SLICE0.md) et [SLICE1.md](SLICE1.md).
>
> **Ce document n'est pas réécrit au fil de l'eau** : il garde la trace de ce qui
> avait été décidé *avant* de construire. Quand la réalisation s'en écarte, c'est
> le document de slice qui porte l'écart et sa raison. Quatre écarts à ce jour,
> tous en Slice 1 : `node:sqlite` au lieu de `better-sqlite3`, `node:http` au lieu
> de Fastify, `node --test` au lieu de Vitest, et `interrupted` élargi à tous les
> statuts actifs. Détail et justification : [SLICE1.md](SLICE1.md).

# Plan de réalisation — Agent Harness (MVP révisé)

## Context

Le document `MVP_AGENT_HARNESS_PLAN.md` décrit une application desktop Tauri qui embarque le CLI Claude Code dans un terminal intégré, plus un harness MCP qui exécute des agents via API tierces. Le dossier de travail `/Users/andydodakal/Documents/Midgaard` est vide : tout est à construire.

Le problème que le produit résout réellement : **Claude Code sait planifier et déléguer, mais on ne voit rien de ce que font les exécutants, et on ne peut pas leur imposer de budget ni d'approbation.** C'est ça la valeur. Le terminal intégré, le PTY, le packaging signé et le shell Tauri ne résolvent aucun de ces problèmes — ils reconstruisent une app que l'utilisateur a déjà.

Quatre décisions prises avec l'utilisateur modifient le document d'origine :

| Sujet | Document d'origine | Retenu |
|---|---|---|
| Enveloppe | Desktop Tauri 2 + PTY + sidecar | **Paquet npm : serveur MCP + daemon + dashboard sur `127.0.0.1`.** Tauri reporté en P1 |
| Runtime agent | Boucle maison | **Boucle maison multi-provider (OpenAI + Gemini dès P0)** — confirmé par l'utilisateur |
| Isolation | Sandbox OS, tranchée au Sprint 4 | **Pas de sandbox OS. Worktree + allowlist + approbation + chemins canoniques, annoncés comme tels.** Tranché dès maintenant |
| Suivi des tâches | `get_task_status` en polling | **`wait_for_task` bloquant (long-poll)**, `get_task_status` conservé pour le check ponctuel |

Résultat attendu : `npm i -g @midgaard/harness` → `harness init` → `claude mcp add` → depuis n'importe quelle session Claude Code (terminal ou app desktop), Claude délègue, l'utilisateur observe tout sur `http://127.0.0.1:7777`, approuve ou refuse, et voit le coût.

---

## 1. Architecture

```text
  Claude Code (terminal OU app desktop — non modifié)
        │ stdio
        ▼
  packages/mcp-server      adaptateur mince : valide, traduit, relaie
        │ HTTP loopback + jeton
        ▼
  packages/daemon  ───────────────────────────┐
   ├─ TaskManager (machine à états durable)   │
   ├─ ApprovalBroker                          │  WS + HTTP
   ├─ EventBus (append-only, séquencé)        ├──────────►  apps/dashboard
   ├─ Budget / UsageMeter                     │             (React + Vite, 127.0.0.1)
   ├─ WorkerPool                              │
   └─ WorkspaceManager (worktrees)            │
        │                                     │
        ▼                                     │
  packages/agent-runtime ◄── packages/providers (openai, gemini)
        └── packages/tools (fs, search, exec, git, http)
```

Le serveur MCP **ne contient aucune logique métier**. Il est lancé par Claude Code en `stdio`, et parle au daemon en HTTP loopback. Si le daemon n'est pas lancé, le serveur MCP le démarre (spawn détaché) puis attend son readiness. Ça évite les N daemons concurrents et garde une seule source de vérité.

**Pourquoi stdio pour MCP et pas Streamable HTTP** : Claude Code gère le cycle de vie du process, pas d'auth à inventer, pas de port à négocier. Le daemon HTTP existe quand même, mais seulement pour le dashboard et pour les sessions MCP multiples.

### Dépendances à verrouiller au Sprint 0

- `@modelcontextprotocol/sdk` — **v1 stable**. Une v2 beta existe (packages scindés `@modelcontextprotocol/server` / `@modelcontextprotocol/client`, spec 2026-07-28) : à évaluer au spike, mais ne pas bâtir le MVP sur une beta.
- `openai` — tool calling via l'API Responses.
- `@google/genai` — SDK Node actuel pour Gemini (les anciens `@google/generative-ai` et `@google-cloud/vertexai` sont abandonnés). Vérifier `npm view @google/genai version` : les docs tierces divergent, et une Interactions API en beta change la forme des appels sur les SDK ≥ 2.0.
- `better-sqlite3` (synchrone, simple, pas de pool), `zod`, `fastify`, `ws`, `keytar` ou équivalent pour le coffre système.

---

## 2. Arborescence

```text
midgaard-harness/
├── apps/
│   └── dashboard/            React + Vite + Tailwind + shadcn/ui
│       └── src/features/{tasks,agents,approvals,tools,settings}/
├── packages/
│   ├── contracts/            schémas Zod partagés — source de vérité unique
│   ├── persistence/          SQLite, migrations, repositories
│   ├── daemon/               HTTP + WS + TaskManager + EventBus + WorkerPool
│   ├── mcp-server/           adaptateur stdio
│   ├── agent-runtime/        boucle, budgets, limites, assemblage du contexte
│   ├── providers/            adapter.ts + openai.ts + gemini.ts
│   ├── tools/                fs, search, exec, git, http
│   ├── workspace/            worktrees, résolution de chemins, cycle de vie
│   └── cli/                  `harness init|start|status|doctor`
└── tests/
```

`packages/contracts` est écrit en premier et ne dépend de rien. Tout le reste en dépend. Les schémas Zod servent à la fois à valider les entrées MCP, à générer les JSON Schemas des outils envoyés aux providers, et à typer le dashboard.

---

## 3. Contrats MCP

| Outil | Entrée | Sortie |
|---|---|---|
| `harness_list_agents` | `project_id?` | profils, outils, limites |
| `harness_delegate_task` | `agent_id`, `project_id`, `objective`, `context?`, `constraints?` | `task_id`, `status` |
| `harness_wait_for_task` | `task_id`, `timeout_s` (défaut 120, max 600) | **bloque** jusqu'à terminaison, timeout, ou `waiting_approval` |
| `harness_get_task_status` | `task_id` | état, étape, usage courant |
| `harness_get_task_result` | `task_id` | résultat structuré |
| `harness_cancel_task` | `task_id`, `reason?` | accusé |
| `harness_get_project_context` | `project_id` | arborescence autorisée, branche, statut Git |

**`wait_for_task` est le cœur de l'ergonomie.** Implémentation : le TaskManager expose une promesse par tâche ; le handler fait `Promise.race([terminal, approvalNeeded, timeout])`. Au retour il renvoie toujours un `next_action` explicite (`"result_ready"`, `"call_wait_for_task_again"`, `"human_approval_pending"`) pour que Claude sache quoi faire sans deviner.

Nommage en `snake_case` sans point : certains clients MCP tolèrent mal les `.` dans les noms d'outils.

### Machine à états

`queued → preparing → running ⇄ waiting_approval → completed`

Sorties alternatives : `failed`, `cancel_requested → cancelled`, `timed_out`, `budget_exceeded`, `interrupted`.

`interrupted` est le point important : au démarrage du daemon, **toute tâche trouvée en `running` ou `preparing` est marquée `interrupted`, jamais reprise ni considérée réussie.** Son worktree est conservé pour inspection.

Chaque transition écrit une ligne dans `task_events` avec un `sequence` monotone par tâche, dans la même transaction SQLite que la mise à jour de `tasks`.

---

## 4. Runtime agent (boucle maison, deux providers)

`packages/providers/adapter.ts` définit l'interface minimale que les deux providers implémentent :

```ts
interface ProviderAdapter {
  id: 'openai' | 'gemini'
  complete(req: CompletionRequest): Promise<CompletionResponse>  // non-stream d'abord
  countUsage(res: CompletionResponse): Usage
  testConnection(): Promise<{ ok: boolean; detail: string }>
}
```

`CompletionRequest` porte messages, outils (JSON Schema généré depuis Zod), et limites. La normalisation des différences (OpenAI `tool_calls` vs Gemini `functionCall`, et surtout la forme des messages de retour d'outil) se fait **dans chaque adaptateur**, jamais dans la boucle. La boucle ne connaît que `{assistantText, toolCalls[], usage}`.

Boucle, par itération :
1. Vérifier budget (`max_cost_usd`), étapes (`max_steps`), délai (`timeout_seconds`), annulation. Tout dépassement = arrêt propre avec statut explicite, **avant** l'appel modèle.
2. Appeler le provider.
3. Pour chaque appel d'outil : valider le schéma Zod → évaluer la politique → si sensible, créer une `approval` et **attendre** la décision humaine → exécuter → journaliser entrée/sortie expurgées + durée.
4. Réinjecter les résultats, émettre les événements, incrémenter `usage`.

Arrêt sur résultat structuré explicite : l'agent appelle un outil terminal `submit_result` plutôt que de laisser la boucle deviner la fin depuis du texte libre.

**Coûts** : table de tarifs dans un fichier de config versionné (`pricing.json`), éditable par l'utilisateur, avec la date de dernière mise à jour affichée dans l'UI. Ne jamais coder les prix en dur dans le code.

**Contexte de l'agent** : c'est Claude Code qui fournit `context`. Le runtime y ajoute seulement l'arborescence du workspace et les consignes du profil. L'agent ne refait pas l'exploration du dépôt — sinon le coût explose et la délégation ne sert à rien.

### Profils P0

- **Researcher** — lecture projet, `http_fetch`, recherche web si un provider est configuré. Aucune écriture, aucun shell.
- **Developer** — lecture projet, écriture limitée au worktree, `git` dans le worktree, `exec` sur allowlist. Tout le reste : approbation.

---

## 5. Sécurité — ce qu'on promet et ce qu'on ne promet pas

**Annoncé dans l'UI, littéralement :** « Isolation logique (worktree Git + contrôle applicatif). Ce n'est pas une sandbox OS : un agent compromis peut lire les fichiers accessibles à votre compte utilisateur. »

Contrôles effectivement implémentés en P0 :

- **Chemins** : `fs.realpath` systématique, puis vérification que le chemin résolu est sous la racine autorisée — **à l'ouverture du descripteur, pas seulement avant**. Symlinks sortants refusés par défaut.
- **Écriture** : uniquement dans le worktree assigné. Jamais ailleurs, approbation ou pas.
- **Exécution** : allowlist de binaires par projet, pas d'interprétation shell (`execFile`, jamais `exec`), environnement reconstruit à partir d'une allowlist de variables (jamais `process.env` hérité), timeout + kill du groupe de process.
- **Réseau** : `http_fetch` avec allowlist de domaines, blocage des IP privées et de l'IMDS (`169.254.169.254`), pas de redirection vers une IP privée.
- **Secrets** : coffre système uniquement, référencés par identifiant dans SQLite. Expurgation par motif dans tous les logs et événements avant persistance.
- **API locale** : bind `127.0.0.1` strict, jeton de session dans un fichier `0600`, `Origin` vérifié sur HTTP et sur l'upgrade WebSocket.
- **Approbations** : liées à une opération exacte (commande + arguments + chemin hashés), à usage unique, expirant après 10 min. Jamais « autoriser toutes les commandes `npm` ».
- **Prompt injection** : les résultats d'agents, les contenus web et les sorties d'outils sont encadrés par des marqueurs `<untrusted_data>` avant d'être renvoyés à Claude Code, avec une consigne explicite dans le `result` que ce contenu est de la donnée, jamais une instruction. C'est le canal le plus dangereux du produit : un Researcher qui lit une page web remonte directement vers l'orchestrateur.

---

## 6. Données

Tables : `projects`, `agents`, `tasks`, `task_events`, `tool_calls`, `approvals`, `artifacts`, `usage`, `provider_configs`, `workspaces`.

Deux écarts par rapport au document d'origine :
- `claude_sessions` est supprimée (plus de terminal intégré).
- `workspaces(id, task_id, worktree_path, branch, base_commit, status, created_at)` est ajoutée : sans elle, les worktrees orphelins après crash sont impossibles à nettoyer de façon fiable.

Événements : `task.created|started|completed|failed`, `agent.message`, `tool.requested|completed`, `approval.requested|resolved`, `artifact.created`, `usage.updated`.

**Reprise WebSocket** : le client envoie son dernier `sequence` connu ; le serveur renvoie un snapshot plus les événements manquants. Sans ça, toute reconnexion crée un trou invisible dans la timeline.

---

## 7. Découpage — slices verticales

### Slice 0 — Spike (2–3 j) — ✅ **livrée**
Prouver de bout en bout : un serveur MCP minimal enregistré via `claude mcp add`, appelé depuis une vraie session Claude Code, qui atteint un daemon et renvoie une réponse. Valider au passage `wait_for_task` bloquant sur 120 s (le client ne doit pas couper), le comportement de `@modelcontextprotocol/sdk` v1 vs v2 beta, et les versions réelles de `openai` et `@google/genai`.
**Livrable :** aller-retour Claude Code → MCP → daemon → réponse, avec une attente longue qui tient.

### Slice 1 — Squelette observable (6–8 j) — ✅ **livrée**
`contracts`, `persistence` + migrations, `daemon` (HTTP + WS + EventBus + machine à états), `mcp-server` complet avec une tâche factice qui simule des étapes, dashboard avec Task Inspector et timeline temps réel, CLI `harness init|start|doctor`.
**Livrable :** Claude délègue une tâche factice, l'utilisateur voit son cycle de vie en direct, l'annule, redémarre le daemon et retrouve l'historique avec les tâches en cours marquées `interrupted`.
**Atteint**, plus l'arrêt du daemon sur inactivité et l'étape de build. 91 vérifications automatiques, 0 échec. Résultats, écarts et découvertes : [SLICE1.md](SLICE1.md).

### Slice 2 — Agents réels, Researcher (8–11 j)
`providers` (OpenAI + Gemini derrière la même interface), `agent-runtime` avec budgets et limites, outils lecture/recherche/`http_fetch`, Agent Registry avec « Test connection », coffre système, comptage tokens et coût.
**Livrable :** un Researcher exécute une tâche réelle sur les deux providers et renvoie un résultat structuré ; le coût affiché correspond à la facture.

### Slice 3 — Developer, worktrees, approbations (8–11 j)
`workspace` (création/nettoyage/diff des worktrees), outils écriture + git + exec contrôlé, ApprovalBroker et UI d'approbation bloquante, onglet Files/Diff.
**Livrable :** un Developer implémente un changement dans un worktree isolé, une commande sensible suspend la tâche jusqu'à décision humaine, le diff est consultable, Claude récupère le résultat.

### Slice 4 — Durcissement et distribution (4–6 j) — distribution abandonnée, terminée le 2026-11-01
Tests de sécurité ciblés (traversée de chemins, symlinks, injection shell, IMDS, origines WS), scénarios de crash et reprise, deux tâches concurrentes sur worktrees distincts, publication npm, README et guide de dépannage.
**Livrable :** installable par un tiers en une commande, scénario de démo du document §12 rejoué sans terminal intégré.
*Révisé le 2026-11-01 :* pas de publication npm — Midgaard s'installe depuis un clone (`npm ci`, `npm run build`, `npm run init`), et l'essai §12 se joue depuis un clone frais ([SLICE4.md](SLICE4.md)).

### Au-delà de la Slice 4 — slices suivantes

Ce §7 fixe le plan d'origine (Slices 0–4). Le harness a ensuite été étendu par
des slices verticales supplémentaires, suivies dans `CLAUDE.md` et leur doc
propre, pas réécrites ici : **Slice 5** (orchestrateur intégré,
[SLICE5.md](SLICE5.md)), **Slice 6** (atelier façon VS Code,
[SLICE6.md](SLICE6.md)), **Slice 7** (images et navigateur isolé,
[SLICE7.md](SLICE7.md)), **Slice 8** (serveurs MCP, agents créés à la volée,
[SLICE8.md](SLICE8.md)), **Slice 9** (agents experts : Python, reverse, règles
Windows, [SLICE9.md](SLICE9.md)), **Slice 10** (spécialisation sécurité :
pipeline à portes `recon → hunt → validate → trace → report`, vue terminal,
débogueur confiné à la VM Windows — décidée le 2026-11-10, ouverte après la
Slice 9, [SLICE10.md](SLICE10.md)).

**Total : 28–39 jours.** Le choix d'une boucle maison sur deux providers plutôt que d'un SDK existant coûte environ 5–7 jours de ce total — c'est le prix de l'indépendance vis-à-vis d'un fournisseur, assumé. Ajouter le shell Tauri en P1 coûtera 12–20 jours supplémentaires (PTY/ConPTY, sidecar Node, signature et notarisation), d'où son report.

---

## 8. Vérification

À chaque slice, dans cet ordre :

1. **Unitaire (Vitest)** — machine à états (toutes les transitions, y compris illégales), résolution de chemins avec symlinks et `../`, normalisation des deux adaptateurs sur des fixtures de réponses enregistrées, calcul de coût.
2. **Intégration** — daemon réel + SQLite temporaire : délégation → événements → résultat ; coupure du daemon en plein `running` puis redémarrage, vérifier `interrupted` ; reconnexion WS après coupure, vérifier l'absence de trou dans les `sequence`.
3. **MCP de bout en bout** — depuis une vraie session Claude Code avec le serveur enregistré : déléguer, attendre, approuver, annuler, récupérer. C'est le seul test qui valide l'ergonomie de `wait_for_task` ; il ne peut pas être remplacé par un client simulé.
4. **Sécurité** — suite dédiée : écriture hors worktree, symlink pointant hors workspace, `; rm -rf` dans un argument, fetch vers `169.254.169.254` et vers `127.0.0.1`, WebSocket avec une `Origin` étrangère, secret dans une sortie d'outil (doit être expurgé en base). Chacun doit échouer proprement avec un refus tracé.
5. **Dashboard (Playwright)** — timeline qui se met à jour sans rafraîchissement, approbation bloquante, affichage du diff.
6. **Budget** — tâche avec `max_cost_usd` volontairement bas : vérifier qu'aucun appel modèle ne part après le seuil, et que le statut est `budget_exceeded`, pas `failed`.

Scénario d'acceptation final, joué manuellement sur macOS puis Windows : la demande du §12 du document d'origine (« fais implémenter une route `/health` par Developer »), depuis une session Claude Code, avec approbation, diff, coût et résultat récupéré par Claude.

---

## 9. Points à trancher pendant la Slice 0

1. ✅ Versions exactes et stabilité de `@modelcontextprotocol/sdk` — **v1 stable retenue** (1.32.2).
2. ✅ Comportement réel du client MCP face à un outil qui bloque — **coupure à 60 s sans notifications de progression**, aucune limite atteinte avec. Le `timeout_s` par défaut de 120 s n'est qu'un point de départ : Claude choisit le sien.
3. Fournisseur de recherche web pour le Researcher et son modèle de facturation. → Slice 2
4. Politique de rétention des worktrees et des logs (proposition : worktrees conservés jusqu'à suppression manuelle, logs 30 jours). → Slice 3
5. Politique de merge des worktrees — **recommandation : manuelle uniquement dans le MVP.** Le harness ne merge jamais tout seul. → Slice 3

Point ajouté puis refermé en Slice 1 : ✅ **adoption des « Tasks » MCP natives** — **non**. Elles ne sont utilisables que si le client déclare la capacité `tasks` ; `claude-code` 2.1.309 ne la déclare pas (relevé dans `~/.midgaard/mcp-trace.jsonl`). `harness_wait_for_task` reste nécessaire. À revérifier à chaque montée de version du client ; raisonnement complet dans [SLICE1.md](SLICE1.md).
