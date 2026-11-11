# MVP — Claude-Driven Agent Harness Desktop

> **Version :** 1.0 · **Statut :** plan de réalisation · **Plateformes :** macOS et Windows
>
> **Décision produit :** option B — Claude Code officiel intégré à l'application desktop, avec un harness MCP indépendant, des agents exécutants via API et un tableau de bord temps réel.

## 1. Vision et résultat attendu

Construire une application desktop multiplateforme qui permet de travailler dans une session **Claude Code officielle**, de déléguer des tâches à des agents spécialisés utilisant des API de fournisseurs de modèles, et d'observer précisément ce que font ces agents (outils, fichiers, commandes, statut, résultats et coûts).

Le produit doit rester **Claude-driven** : Claude Code planifie, délègue et intègre les résultats. Le harness n'est pas un second orchestrateur autonome. Il assure la gestion des tâches, l'exécution, les permissions, l'isolation, les traces et la remontée des résultats.

### Critères de succès du MVP

1. Ouvrir un projet local dans l'application sur macOS ou Windows.
2. Lancer une **véritable session du CLI Claude Code** dans un terminal intégré, sans récupérer ni réutiliser ses jetons d'authentification.
3. Connecter Claude Code au serveur MCP local du harness.
4. Depuis Claude, déléguer une tâche à un agent `developer` ou `researcher` configuré avec sa propre clé API.
5. Visualiser en direct l'état de la tâche, les appels d'outils, les journaux, les fichiers modifiés et le coût estimé.
6. Autoriser/refuser une action sensible ; interrompre une tâche et récupérer un résultat structuré.
7. Redémarrer l'application sans perdre les sessions, tâches et journaux déjà enregistrés.

## 2. Périmètre

### Inclus dans le MVP (P0)

- Application desktop **Tauri 2 + React + TypeScript** pour macOS et Windows.
- Terminal intégré **xterm.js + PTY natif** pour utiliser le CLI Claude Code officiel.
- Harness local indépendant, exposant un serveur MCP pour Claude Code et une API locale pour l'interface.
- Deux profils d'agents : `developer` et `researcher`, avec instructions et outils distincts.
- Connecteurs API configurables pour **OpenAI** et **Google Gemini** ; architecture d'adaptateurs extensible.
- Outils internes : lecture/écriture de fichiers, recherche dans le projet, terminal contrôlé, Git et recherche web via un fournisseur explicitement configuré.
- Catalogue d'outils, permissions par agent et demandes d'approbation.
- Isolation de tâches de développement par **Git worktree** ; contrôle des accès par sandbox adaptée à l'OS.
- Événements temps réel, timeline, résultats, artefacts, diffs, erreurs et estimation des coûts API.
- Stockage local SQLite et secrets dans le coffre-fort système.

### Reporté (P1 / P2)

- Orchestration autonome depuis le dashboard sans Claude Code.
- Éditeur visuel de workflows et collaboration multi-utilisateurs.
- Marketplace de plugins, installation automatique de MCP tiers et synchronisation cloud.
- Docker systématique, exécution distante, déploiement automatique.
- Routage automatique multi-modèles selon benchmarks/coûts, mémoire sémantique, auto-réparation complexe.
- Pilotage arbitraire du bureau de l'utilisateur ou automatisation d'applications non sandboxées.

### Non-objectifs

- Ne pas imiter l'API Claude à partir des identifiants d'un abonnement.
- Ne pas afficher les chaînes de pensée internes des modèles ; afficher uniquement plans, événements, appels d'outils, messages et justifications explicitement produits.
- Ne pas promettre une isolation forte avec un simple répertoire ou Git worktree.

## 3. Architecture cible

```text
┌──────────────────────────── Desktop Tauri 2 ───────────────────────────┐
│ React UI                                                             │
│ Projects | Claude Terminal | Agents | Task Graph | Tools | Approvals  │
│          │                           │                                │
│          │ PTY                       │ localhost HTTP + WS            │
└──────────┼───────────────────────────┼────────────────────────────────┘
           ▼                           ▼
  Claude Code CLI officiel      Harness Daemon (Node/TS)
  Auth gérée par Claude Code    ├─ MCP Server (stdio ou Streamable HTTP)
           │                    ├─ Task / Agent / Session Manager
           └────── MCP ────────►├─ Provider Adapters (OpenAI, Gemini)
                                ├─ Tool Registry + Permission Engine
                                ├─ Sandbox / Worktree Manager
                                ├─ Event Bus + Audit Log
                                ├─ SQLite + Secret Store adapter
                                └─ Worker Pool
                                       ├─ Developer Agent
                                       └─ Researcher Agent
```

**Frontières de responsabilité**

- **Claude Code** : compréhension de la demande, planification, choix des délégations, consolidation et validation finale.
- **MCP Server** : interface de commandes à disposition de Claude Code ; validation des entrées et publication des identifiants de tâche.
- **Harness Daemon** : état durable, file de tâches, gestion des workers, approbations, budgets et événements.
- **Agents API** : boucle d'exécution modèle → appel d'outil → résultat → modèle, avec limites explicites.
- **Desktop** : terminal Claude, inspection, configuration, contrôle, sans logique d'orchestration cachée.

### Communication locale

- **MCP** : privilégier `stdio` pour l'intégration Claude Code si le serveur est lancé par le CLI ; ou Streamable HTTP sur loopback si un daemon persistant partagé est requis. Éviter de multiplier les serveurs concurrents : le serveur MCP peut agir comme adaptateur vers le daemon.
- **Dashboard** : API HTTP sur `127.0.0.1` + WebSocket pour les événements ; jeton de session local et contrôle strict des origines.
- **PTY** : bridge natif Tauri/sidecar vers un pseudo-terminal ; ne jamais simuler un terminal avec une simple boîte de texte.
- **Tâches longues** : `delegate_task` retourne rapidement un `task_id`, puis `get_task_status` et `get_task_result` permettent le suivi.

## 4. Stack technique et dépôt

| Couche | Choix MVP | Motif |
|---|---|---|
| Desktop | Tauri 2 | Application multiplateforme légère |
| Frontend | React, TypeScript, Vite | UI et développement rapide |
| Design system | Tailwind CSS, shadcn/ui | Composants cohérents |
| Terminal | xterm.js + PTY natif | CLI Claude interactif |
| Visualisation | React Flow | Graphe de tâches |
| Daemon | Node.js LTS, TypeScript | Écosystème MCP et providers |
| MCP | SDK TypeScript officiel | Contrat de communication |
| Données | SQLite + migrations | Local-first, simple à distribuer |
| Événements | Event emitter durable + WebSocket | Traçabilité et temps réel |
| Validation | Zod | Contrats d'outils et API |
| Secrets | Keychain macOS / Credential Manager Windows | Pas de clés en clair dans SQLite |
| Tests | Vitest, Playwright, tests E2E desktop | Qualité automatisée |
| Packaging | Tauri bundler + sidecar | Installation macOS/Windows |

```text
agent-harness/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── features/{projects,terminal,agents,tasks,tools,approvals,settings}/
│       │   ├── components/
│       │   └── lib/
│       └── src-tauri/
├── packages/
│   ├── core/                # tâches, événements, état
│   ├── mcp-server/          # outils exposés à Claude Code
│   ├── agent-runtime/       # boucle agent / budgets / limites
│   ├── providers/           # OpenAI, Gemini
│   ├── tools/               # fs, terminal, git, search
│   ├── sandbox/             # permissions, worktrees, isolation OS
│   ├── persistence/         # SQLite, migrations
│   └── contracts/           # types et schémas partagés
├── docs/
│   ├── architecture.md
│   ├── security.md
│   └── mcp-contracts.md
├── tests/
└── package.json
```

## 5. Expérience utilisateur et écrans

### Écran A — Projects

- Ajouter un dossier existant, sélectionner un projet récent.
- Afficher branche Git, statut du dépôt, nombre de tâches actives.
- Prévenir si le dossier n'est pas un dépôt Git (certaines fonctions d'isolation indisponibles).

### Écran B — Workspace (écran principal)

Disposition proposée :

```text
┌──────────────────────────────────────────────────────────────────┐
│ Projet ▾        Session Claude ▾                 Budget / Settings │
├────────────┬─────────────────────────┬───────────────────────────┤
│ Sidebar    │ Claude Code Terminal    │ Activity / Inspector      │
│            │ (PTY officiel)          │                           │
│ Sessions   │                         │ Agents & task status      │
│ Agents     │ $ claude                │ Tool calls & approvals    │
│ Tasks      │ ...                     │ Logs / diff / costs       │
│ Tools      │                         │                           │
├────────────┴─────────────────────────┴───────────────────────────┤
│ Status bar : MCP connected | 2 agents | 1 task running | $0.14    │
└──────────────────────────────────────────────────────────────────┘
```

- Terminal interactif avec resize, copier-coller, raccourcis, scrollback.
- Panneau de droite synchronisé sur les tâches du projet.
- Ne pas prétendre afficher tout ce que Claude Code fait en interne : la télémétrie détaillée porte principalement sur les actions passant par le harness.

### Écran C — Agent Registry

- Créer/éditer un profil : nom, rôle, provider, modèle, instructions, outils, limites.
- Paramètres : `max_steps`, `timeout_seconds`, `max_cost_usd`, `max_concurrent_tasks`.
- Bouton « Test connection » pour les providers.

### Écran D — Task Inspector

- Graphe parent/enfants, statut, horodatage, durée, agent, modèle.
- Timeline des événements : démarrage, outil demandé, approbation, réponse, erreur, fin.
- Onglets : `Overview`, `Logs`, `Tool Calls`, `Files / Diff`, `Cost`, `Result`.
- Actions : `Cancel`, `Retry` (nouvelle tentative tracée), `Approve`, `Reject`.

### Écran E — Tool Registry

- Liste des outils et des capacités, description, schémas d'entrée, permissions requises.
- Activation par projet et par profil d'agent.
- Section « External MCP » en **preview** : connexion manuelle à des serveurs approuvés, sans marketplace ni auto-installation.

### Écran F — Settings

- Chemin du CLI Claude Code et diagnostic d'installation.
- Providers et clés API (stockées dans le coffre système).
- Sandbox, politique réseau, approbations, limites de coûts et conservation des logs.

## 6. Contrats MCP du MVP

| Outil | Entrée principale | Sortie |
|---|---|---|
| `harness.list_agents` | `project_id?` | profils disponibles |
| `harness.delegate_task` | `agent_id`, `project_id`, `objective`, `context?`, `constraints?` | `task_id`, `status` |
| `harness.get_task_status` | `task_id` | état, progression, timestamps |
| `harness.get_task_result` | `task_id` | résumé, artefacts, tests, erreurs |
| `harness.cancel_task` | `task_id` | accusé de demande d'annulation |
| `harness.list_tools` | `agent_id?` | outils accessibles |
| `harness.get_project_context` | `project_id` | contexte autorisé, résumé projet |

Exemple de délégation :

```json
{
  "agent_id": "developer",
  "project_id": "project_123",
  "objective": "Implémenter une API de gestion d'inventaire",
  "constraints": {
    "max_cost_usd": 1.5,
    "max_steps": 30,
    "requires_review": true
  }
}
```

Réponse immédiate :

```json
{
  "task_id": "task_456",
  "status": "queued",
  "status_hint": "Use harness.get_task_status to monitor progress"
}
```

### Machine à états

`queued → preparing → running → waiting_approval → running → completed`

Transitions alternatives : `failed`, `cancel_requested`, `cancelled`, `timed_out`, `budget_exceeded`.

Toute transition doit être persistée avec un événement et un horodatage. Une tâche redémarrée après crash ne doit jamais être considérée comme réussie sans preuve.

## 7. Runtime des agents API

### Boucle d'exécution

1. Charger profil, consignes, contexte minimal et budget.
2. Préparer un workspace autorisé et, si pertinent, un worktree Git.
3. Appeler le modèle API avec les outils autorisés.
4. Valider chaque appel d'outil (schéma, politique, ressources, chemin, budget).
5. Demander approbation si nécessaire ; bloquer l'outil tant que la décision n'est pas rendue.
6. Exécuter l'outil dans l'environnement prévu ; enregistrer entrée expurgée, résultat et durée.
7. Réinjecter le résultat dans la conversation de l'agent.
8. Arrêter sur succès explicite, limite d'étapes, coût, délai, annulation ou erreur fatale.
9. Produire un résultat structuré : résumé, changements, fichiers, tests, avertissements.

### Deux profils initiaux

**Developer** : peut inspecter le dépôt, éditer dans son workspace, utiliser Git et exécuter des commandes autorisées ; écriture hors workspace interdite. Les opérations dangereuses nécessitent une approbation.

**Researcher** : accès lecture au projet, recherche web si provider configuré, requêtes HTTP autorisées ; pas d'écriture ni d'exécution shell par défaut.

### Contrat de résultat

```json
{
  "task_id": "task_456",
  "status": "completed",
  "summary": "API d'inventaire ajoutée",
  "artifacts": ["src/inventory.ts"],
  "tests": [{"name": "unit", "status": "passed"}],
  "warnings": [],
  "usage": {"input_tokens": 10000, "output_tokens": 2500, "estimated_usd": 0.08}
}
```

## 8. Sandbox, sécurité et permissions

**Principe :** expérience proche d'OpenCode, mais isolation vérifiable, pas seulement un dossier de travail.

### Modèle de permissions

- **Read** : fichiers explicitement autorisés, métadonnées Git.
- **Write** : uniquement workspace assigné.
- **Execute** : commandes contrôlées avec environnement filtré, timeout et limites de ressources.
- **Network** : désactivé par défaut pour les commandes non approuvées ; accès web explicite via outils dédiés.
- **Sensitive** : suppression massive, installation de dépendances, modification hors workspace, secrets, déploiement et accès système → approbation ou refus.

### Approche multiplateforme

- **macOS** : explorer les mécanismes d'isolation disponibles sur la version cible ; ne pas considérer un simple processus enfant comme sandboxé.
- **Windows** : utiliser des mécanismes adaptés à Windows ; ne pas supposer que les primitives Unix fonctionnent.
- **Fallback sécurisé** : si l'isolation requise n'est pas disponible, bloquer l'exécution sensible ou demander une exécution explicitement approuvée dans un environnement alternatif. Ne jamais dégrader silencieusement la sécurité.
- **Git worktrees** : isolation des modifications entre agents, **pas** barrière de sécurité contre l'accès aux autres fichiers.
- **Docker** : option ultérieure, ou voie d'exécution anticipée si nécessaire pour atteindre un niveau d'isolation annoncé.

### Menaces à traiter dès P0

- Prompt injection dans les pages web, dépôts et sorties d'outils.
- Exfiltration de clés API et variables d'environnement.
- Traversée de chemins (`../`), liens symboliques et accès hors workspace.
- Commandes shell dangereuses et processus enfants persistants.
- Serveur local accessible depuis d'autres origines ou interfaces réseau.
- MCP externe malveillant ; descriptions d'outils non fiables.
- Logs contenant des secrets, données personnelles ou contenu sensible.

### Règles d'implémentation

- Secrets dans Keychain / Credential Manager, jamais dans le frontend ni dans les logs.
- API locale liée à loopback, authentifiée, origine vérifiée ; WebSocket authentifié.
- Aucun outil ne reçoit automatiquement toutes les variables d'environnement du processus parent.
- Validation canonique des chemins avant ET au moment de l'opération ; politique explicite pour les symlinks.
- Approbations rattachées à **une opération exacte**, non à une catégorie vague.
- Journal d'audit append-only au niveau applicatif ; rotation et expurgation configurables.

## 9. Données et événements

### Tables SQLite minimales

- `projects(id, name, root_path, created_at)`
- `claude_sessions(id, project_id, started_at, ended_at, terminal_metadata)`
- `agents(id, name, role, provider, model, config_json)`
- `tasks(id, project_id, parent_task_id, agent_id, status, objective, created_at, updated_at)`
- `task_events(id, task_id, sequence, type, payload_json, created_at)`
- `tool_calls(id, task_id, tool_name, status, input_redacted, output_redacted, duration_ms)`
- `approvals(id, task_id, tool_call_id, decision, requested_at, resolved_at)`
- `artifacts(id, task_id, relative_path, type, metadata_json)`
- `usage(id, task_id, provider, model, input_tokens, output_tokens, estimated_cost_usd)`
- `provider_configs(id, provider, settings_json, secret_reference)`

### Événements temps réel

`task.created`, `task.started`, `agent.message`, `tool.requested`, `approval.requested`, `approval.resolved`, `tool.completed`, `artifact.created`, `usage.updated`, `task.completed`, `task.failed`.

Chaque événement possède `event_id`, `task_id`, `sequence`, `timestamp` et `payload`. Au reconnect, le client recharge un snapshot puis les événements manquants pour éviter les trous.

## 10. Roadmap de réalisation

> Estimation indicative pour un développeur expérimenté assisté par IA. Les contraintes d'isolation native et de packaging peuvent allonger sensiblement le calendrier.

### Sprint 0 — Spike technique et risques (3–5 jours)

- [ ] Vérifier le lancement du CLI Claude Code officiel dans un PTY macOS et Windows.
- [ ] Tester l'intégration MCP locale avec une session Claude Code réelle.
- [ ] Valider le packaging du daemon Node en sidecar Tauri.
- [ ] Prototyper l'isolation minimale par OS ; documenter ses garanties et ses limites.
- [ ] Définir la politique d'approbation et le modèle de menace.

**Livrable :** démonstration terminal Claude → appel MCP → daemon → réponse, sur les deux OS.

### Sprint 1 — Desktop shell et projets (4–6 jours)

- [ ] Initialiser monorepo, Tauri, React, design system.
- [ ] Créer les vues Projects, Workspace, Settings.
- [ ] Implémenter le PTY et la détection du CLI Claude Code.
- [ ] Démarrer/arrêter proprement le daemon.
- [ ] Créer la persistance SQLite et migrations.

**Livrable :** application ouvrant un projet et un terminal Claude fonctionnel.

### Sprint 2 — MCP et gestion des tâches (4–6 jours)

- [ ] Implémenter les outils MCP P0.
- [ ] Créer la machine à états persistante.
- [ ] Ajouter API locale, authentification, WebSocket.
- [ ] Construire Task Inspector et timeline.
- [ ] Gérer annulation et récupération après redémarrage.

**Livrable :** Claude délègue une tâche factice et son cycle de vie apparaît en direct.

### Sprint 3 — Agents et providers (5–8 jours)

- [ ] Ajouter adaptateurs OpenAI et Gemini.
- [ ] Implémenter la boucle d'exécution avec limites.
- [ ] Ajouter Agent Registry et tests de connexion.
- [ ] Construire les outils lecture, recherche projet et HTTP contrôlé.
- [ ] Stocker clés API dans le coffre système.
- [ ] Mesurer tokens et coût estimé selon tarifs configurés.

**Livrable :** agent Researcher exécute une tâche réelle et retourne un résultat structuré.

### Sprint 4 — Développement, worktrees et permissions (6–10 jours)

- [ ] Ajouter outils d'écriture, Git et terminal contrôlé.
- [ ] Implémenter worktrees, nettoyage et conservation des diffs.
- [ ] Intégrer la politique de sandbox par OS et les refus sûrs.
- [ ] Ajouter flux d'approbation dans l'interface.
- [ ] Afficher changements, commandes et tests.

**Livrable :** agent Developer modifie un projet test dans un workspace isolé, sous contrôle de permissions.

### Sprint 5 — Stabilisation et distribution (5–8 jours)

- [ ] Tests E2E macOS/Windows, erreurs réseau, crash et reprise.
- [ ] Tests de sécurité sur chemins, symlinks, commandes et API locale.
- [ ] Optimiser logs, reconnexion et affichage temps réel.
- [ ] Construire packages installables et procédure de signature/notarisation selon canal de distribution.
- [ ] Rédiger onboarding et guide de dépannage.

**Livrable :** build MVP utilisable sur les deux OS.

**Total indicatif : 27 à 43 jours de développement**, hors imprévus majeurs et validation approfondie des garanties d'isolation.

## 11. User stories et critères d'acceptation

| ID | User story | Critère vérifiable |
|---|---|---|
| US-01 | En tant qu'utilisateur, j'ouvre un projet | Chemin persisté, réouverture possible |
| US-02 | Je lance Claude dans l'app | CLI officiel interactif, PTY stable |
| US-03 | Claude délègue à Developer | MCP retourne un `task_id` valide |
| US-04 | Je vois les événements en direct | UI mise à jour sans refresh manuel |
| US-05 | Je configure une API provider | Secret jamais écrit en clair dans SQLite |
| US-06 | Un agent demande une permission | Exécution suspendue jusqu'à décision |
| US-07 | Je refuse une action | Action non exécutée, refus tracé |
| US-08 | J'annule une tâche | Processus/outils stoppés dans la mesure du possible, état cohérent |
| US-09 | Je consulte les changements | Diff Git et chemins des artefacts accessibles |
| US-10 | Je redémarre l'app | Historique présent, tâches interrompues correctement marquées |
| US-11 | Je dépasse un budget | Aucun nouvel appel modèle après atteinte du seuil configuré |
| US-12 | Je lance deux tâches de code | Worktrees distincts, pas d'écriture croisée autorisée |

## 12. Scénario de démonstration final

**Demande dans le terminal Claude intégré :**

> « Analyse ce projet TypeScript, fais implémenter une nouvelle route `/health` par Developer, puis vérifie les fichiers et résume les changements. »

**Déroulé attendu :**

1. Claude Code lit le contexte du projet et appelle `harness.delegate_task`.
2. Le harness crée `task_001`, réserve un worktree et sélectionne Developer.
3. L'agent lit les fichiers autorisés et propose les changements.
4. Si une commande sensible est nécessaire, l'application affiche une demande d'approbation.
5. L'agent écrit dans son workspace et lance les tests autorisés.
6. Le dashboard affiche la timeline, les appels d'outils, les diffs et le coût.
7. Le harness termine avec un résultat structuré ; Claude le récupère via MCP.
8. Claude résume le résultat, vérifie les limites et demande confirmation avant intégration si nécessaire.

**Définition de « terminé » :** ce scénario fonctionne sur macOS et Windows, avec persistance, permissions et reprise cohérente après interruption.

## 13. Principaux risques et décisions

| Risque | Impact | Réponse |
|---|---|---|
| CLI Claude non détecté / non installé | Bloque l'UX | Diagnostic, chemin configurable, instructions d'installation |
| Différences PTY entre macOS et Windows | Terminal instable | Spike Sprint 0 sur les deux plateformes |
| Sandbox non équivalente entre OS | Risque de sécurité | Capacités annoncées par OS, refus si garantie absente |
| MCP externe malveillant | Exfiltration / actions non désirées | Allowlist, validation, approbations, désactivé par défaut |
| API provider indisponible | Tâche bloquée | Timeouts, retries bornés, état d'erreur explicite |
| Dépenses API imprévues | Coût | Budget par tâche et global, plafonds, affichage estimé |
| Agent produit du code non fiable | Régressions | Worktree, diff, tests, validation Claude et humaine |
| Perte de session après crash | Mauvaise expérience | Événements durables et stratégie de reprise |

### Décisions actées

- **Orchestration :** Claude-driven uniquement pour le MVP.
- **Interaction :** Claude Code officiel dans le terminal intégré de l'application (option B).
- **Desktop :** Tauri 2, macOS et Windows.
- **Agents :** exécutants via API de providers ; aucun détournement de l'authentification Claude.
- **Outils :** natifs d'abord, MCP externes ensuite.
- **Isolation :** workspace et worktrees avec contrôle de sécurité OS ; ne jamais confondre séparation Git et sandbox.
- **Persistance :** locale, SQLite.

### Décisions à confirmer pendant Sprint 0

1. Versions minimales macOS/Windows et architectures CPU à distribuer.
2. Choix concret du backend PTY et des mécanismes de sandbox par OS.
3. Mode MCP final : adaptateur `stdio` ou daemon Streamable HTTP local.
4. Fournisseur de recherche web et gestion de sa facturation.
5. Politique de conservation des logs, artefacts et sessions terminal.
6. Politique de merge des worktrees : validation manuelle dans le MVP recommandée.

## 14. Ordre de construction recommandé

**Vertical slice n° 1 :** application → terminal Claude officiel → MCP → tâche factice → événement temps réel.

**Vertical slice n° 2 :** tâche réelle → provider API → outil lecture → résultat Claude.

**Vertical slice n° 3 :** agent Developer → worktree → écriture et tests → approbation → diff → résultat Claude.

Cet ordre permet de prouver rapidement le cœur du produit sans construire prématurément un dashboard complexe ou une plateforme de plugins complète.
