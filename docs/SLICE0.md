# Slice 0 — Résultats du spike

> **Note de la Slice 1.** Le dossier `spike/` n'existe plus : le monorepo l'a
> remplacé, comme le plan le prévoyait. Ce document reste tel qu'il a été écrit,
> parce qu'il consigne *pourquoi* le harness est fait comme il est — chaque
> invariant de la Slice 1 vient d'un défaut constaté ici. Le code du spike reste
> consultable dans l'historique Git, au commit
> « Slice 0 : spike Claude Code → MCP → daemon, validé en session réelle ».
> Les chemins cités (`src/daemon.ts`, `npm run approve`…) sont ceux du spike ;
> leur équivalent actuel est indiqué dans [SLICE1.md](SLICE1.md).

**Date :** 2026-10-28 · **Objectif :** prouver Claude Code → MCP stdio → daemon HTTP loopback → réponse, avec une attente longue qui tient.

**Verdict : architecture validée, y compris dans une vraie session Claude Code** (2.1.309) : jeton de progression envoyé, attente de 120 s tenue, `next_action` suivi. Le premier test réel a révélé **deux défauts dans le serveur MCP** qui empêchaient le cycle d'approbation d'aller au bout ; ils sont **corrigés, couverts par des tests (S8, S9) et revérifiés dans une seconde session réelle**, où une attente de 4 min 9 s jusqu'à l'approbation humaine a tenu. **Slice 0 terminée.**

## Ce qui est prouvé

Suite `npm run test:wait`, client MCP officiel du SDK en stdio, 10 scénarios, 0 échec, ~105 s.

| # | Scénario | Résultat |
|---|---|---|
| S1 | Deux serveurs MCP lancés simultanément sans daemon | Les deux clients voient le même daemon (l'unicité elle-même est vérifiée par `test:lock`) |
| S2 | Outils exposés à Claude | 5 outils, **aucun outil d'approbation** |
| S3 | Tâche nécessitant une approbation | `wait` rend la main en 1,8 s avec `human_approval_pending` ; après approbation humaine → `result_ready` |
| S4 | Client qui interrompt l'attente | L'attente s'arrête, **la tâche continue** ; `cancel` explicite l'arrête ; double `cancel` refusé |
| S5 | Attente 90 s **sans** notifications de progression | **Coupée par le client à 60,0 s** (`-32001 Request timed out`) — mesure, pas un échec |
| S6 | Attente 90 s **avec** progression + `resetTimeoutOnProgress` | **Tient**, `result_ready` à 90 s, 5 notifications (toutes les 15 s) |
| S7 | Daemon tué (`SIGKILL`) en cours de session | Relancé automatiquement à l'appel suivant (nouveau pid) ; tâche en vol perdue — attendu sans persistance |
| S8 | Consignes d'approbation (défaut n° 1) | Aucune mention de dashboard ; la réponse porte la commande complète avec chemin et identifiant |
| S9 | Rappel de l'attente sur une pause déjà signalée (défaut n° 2) | **Bloque** jusqu'à son délai (`still_waiting_for_human`) au lieu de revenir en 2 ms ; un autre client est prévenu aussitôt ; approbation pendant l'attente → `result_ready` |
| S10 | Daemon d'une version antérieure encore actif | Arrêté et remplacé au premier appel (protocole 2) |

Suite `npm run test:lock` : 8 daemons lancés simultanément, 10 manches (6 à froid, 4 sur verrou périmé) → **un seul survivant à chaque manche**, 40/40 sur quatre passes. Voir la section « Bug d'instance unique » ci-dessous.

Sécurité de l'API locale, vérifiée au `curl` : `401` sans jeton, `403` sur `Host` étranger (DNS rebinding), `403` sur toute `Origin`, fichier runtime en `0600`, nettoyé à l'arrêt.

## Bug d'instance unique (trouvé et corrigé)

**Symptôme.** Deux daemons orphelins de la première exécution de la suite tournaient encore, sur le même dossier runtime, chacun sur son port. Le verrou devait empêcher ça.

**Pourquoi aucun test ne l'avait vu.** S1 vérifiait que deux clients voient *le même* daemon. C'est resté vrai : les deux clients lisaient le même fichier de découverte, écrit en dernier par l'un des deux daemons. Le test contrôlait un symptôme, pas l'invariant « un seul daemon vivant ».

**Deux causes de course :**
1. *À la création* : le verrou était créé vide puis rempli avec le pid. Un concurrent qui le lisait entre les deux trouvait un pid vide, concluait à un verrou périmé et le supprimait. Fenêtre minuscule : reproduit une fois par hasard, jamais en test dirigé.
2. *À la récupération d'un verrou périmé* (après un `SIGKILL`) : A et B lisent le même pid mort ; A remplace le verrou ; B supprime le verrou neuf de A en le croyant périmé. **Reproduit à chaque fois** : 4 manches sur 4 en échec avant correctif.

**Correctif** (`src/daemon.ts`) :
- création atomique *avec contenu* : pid écrit dans un fichier temporaire, puis `link` vers le nom du verrou (échoue si le nom existe) ;
- **bail** vérifié chaque seconde : un daemon qui ne lit plus son pid dans le verrou s'arrête ; le détenteur republie le fichier de découverte si un perdant l'a effacé ;
- à l'arrêt, un daemon ne supprime le verrou et le fichier de découverte que s'ils sont les siens.

Le bail rend la cause 2 bénigne sans la rendre atomique : deux daemons peuvent coexister **au plus une seconde**, au démarrage, sans tâche en cours. Acceptable ici ; à reconsidérer si le daemon devient un service distribué.

**Leçon pour la suite** : tester les invariants directement (compter les processus vivants), pas leurs effets visibles depuis un client.

## Découvertes qui modifient le plan

1. **Le client MCP du SDK coupe un appel d'outil à 60 s par défaut.** Un `wait_for_task` bloquant n'est viable qu'avec des notifications de progression. Implémenté : long-poll vers le daemon par tranches de 15 s, notification entre chaque tranche. `progress` mesure le temps d'attente (la spec exige une valeur strictement croissante, ce que le numéro d'étape ne garantit pas).
2. **Le SDK 1.32 implémente les « Tasks » MCP natives** (`taskId`, `taskStore` dans le contexte du handler) : une primitive du protocole pour les requêtes longues. Piste sérieuse pour remplacer notre `wait_for_task` maison — **à n'adopter que si Claude Code la supporte côté client**. À vérifier en Slice 1.
3. **Le CLI `claude` n'est pas installé sur cette machine.** L'enregistrement passe par un `.mcp.json` de projet, pas par `claude mcp add`. Conséquence pour `harness init` : écrire la config lui-même (`.mcp.json` en portée projet, ou la config utilisateur), sans dépendre du CLI.
4. **Chemin de `node` : utiliser le lien stable** (`/opt/homebrew/opt/node@24/bin/node`), jamais le chemin `Cellar/…/24.18.0` qui casse à la mise à jour suivante. `harness init` doit le résoudre.
5. **Node 24 exécute le TypeScript sans build… sauf sous `node_modules`.** Vérifié : Node refuse avec `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Parfait en développement, mais un paquet publié sur npm doit être compilé. Prévoir l'étape de build dès la Slice 1.
6. **Piège Node à retenir :** `req.on('close')` se déclenche dès que le corps est lu ; pour détecter un client parti pendant un long-poll, écouter `res.on('close')`.
7. **Piège de configuration :** les imports ESM statiques sont hissés, donc une config lue depuis l'environnement au niveau module est figée avant qu'on puisse la changer. En Slice 1, passer la config explicitement (injection), pas via des constantes de module.
8. **`npm install typescript` installe désormais TypeScript 7, le compilateur natif.** `tsc` fonctionne (typecheck du spike en 7.0.2), mais le paquet n'expose plus l'API JavaScript classique (`createSourceFile`, `createPrinter`). Tout outil maison qui manipule l'AST (génération de code, codemods) devra épingler `typescript@5` à côté.
9. **Le daemon survit aux mises à jour du code.** Comme il ne s'arrête jamais seul, un serveur MCP récent peut tomber sur un daemon ancien qu'il ne comprend plus — c'est arrivé après les correctifs des défauts n° 1 et 2 : le daemon de la session de test tournait encore avec l'ancien code, et la pause d'approbation n'aurait jamais été signalée. D'où une **version de protocole** annoncée par `/health` : un serveur MCP qui trouve une autre version arrête le daemon et en démarre un neuf (S10). Indispensable dans le produit, où le daemon survivra aux mises à jour du paquet npm.

## Versions retenues

| Paquet | Version | Remarque |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.2 | v1 stable ; accepte zod 3.25+ ou 4 |
| `zod` | 4.6.7 | `z.toJSONSchema()` natif → schémas d'outils pour les providers |
| `openai` | 7.45.1 | Slice 2 |
| `@google/genai` | 2.31.0 | ≥ 2.0 : la forme des appels change (Interactions API), à lire avant la Slice 2 |
| `better-sqlite3` | 13.0.3 | Slice 1 |
| `fastify` | 5.12.7 | Slice 1 (le spike utilise `node:http`) |
| `typescript` | 7.0.2 | Compilateur natif : `tsc` OK, plus d'API JavaScript du compilateur |
| Node | 24.18.0 | |

## Limites connues (attendues à ce stade)

- Tâches en mémoire : perdues au redémarrage du daemon → Slice 1 (SQLite + statut `interrupted`).
- Approbation en ligne de commande → Slice 1 (dashboard).
- **Le daemon détaché ne s'arrête jamais seul.** Il survit à toutes les sessions. À décider en Slice 1 : arrêt après N minutes sans tâche active ni client.
- Tâches simulées : aucun agent réel → Slice 2.

## Test dans une vraie session Claude Code

**Date :** 2026-10-28, session ouverte sur `Midgaard`, client `claude-code` **2.1.309**. Sources : `.runtime/mcp-trace.jsonl`, `.runtime/daemon.log` et la transcription de la session.

### Chronologie (UTC)

| Heure | Événement |
|---|---|
| 20:18:09 | Claude Code lance le serveur MCP à l'ouverture de la session |
| 20:18:43 | Premier appel d'outil → le daemon démarre seul |
| 20:18:47 | Attente n° 1 (`timeout_s` 120, jeton de progression présent) |
| 20:20:47 | … fin après **120,0 s**, 7 notifications, `call_wait_for_task_again` |
| 20:20:49 | Attente n° 2, `timeout_s` **90 choisi par Claude** → `result_ready` après 23,4 s, **2 ms** après la fin de la tâche |
| 20:21:16 | Délégation de la tâche « test approbation » |
| 20:21:18 | Attente n° 3 (60 s) → `human_approval_pending` après 3,3 s, **1 ms** après la pause |
| 20:21:29 | Attente n° 4 (120 s) → `human_approval_pending` **en 2 ms** ⚠️ |
| 20:21:45 | Claude termine son tour : il demande d'approuver « dans le dashboard Midgaard » et écrit qu'il « reste en attente » |
| 20:21:53 | Approbation humaine (`npm run approve`) |
| 20:21:57 | Tâche terminée — **résultat jamais récupéré par Claude** |

### Ce qui est confirmé

| Question | Réponse |
|---|---|
| Claude Code envoie-t-il un jeton de progression ? | **Oui, à chaque appel** (4/4) |
| Une attente de plus de 60 s tient-elle ? | **Oui** : 120,0 s, 7 notifications, aucune coupure |
| Claude suit-il `next_action` ? | **Oui** : rappel 2,4 s après `call_wait_for_task_again` |
| Claude interroge-t-il le statut en boucle ? | **Non** : zéro appel à `harness_get_task_status` |
| Claude tente-t-il d'approuver lui-même ? | **Non** : il écrit qu'il ne peut pas et renvoie vers l'humain |
| Le daemon démarre-t-il seul ? | **Oui**, au premier appel d'outil, pas à l'ouverture de la session |
| Réactivité | 1 à 2 ms entre le changement d'état et le retour de l'attente |

Constat secondaire : Claude **ajuste `timeout_s` de lui-même** (90 s pour une tâche aux trois quarts finie, 60 s pour une tâche de 10 s). La valeur par défaut de 120 s n'est donc qu'un point de départ.

Plafond propre à Claude Code pour un appel d'outil MCP : non atteint. Le second test a tenu **248,6 s** sur un seul appel (voir plus bas) ; 600 s, le maximum autorisé par `harness_wait_for_task`, reste à essayer.

### Défaut n° 1 — Claude renvoie vers un dashboard qui n'existe pas

Les `instructions` du serveur affirment que les approbations se font « in the Midgaard dashboard ». Claude l'a répété tel quel à l'utilisateur. Or le dashboard n'arrive qu'en Slice 1 : dans le spike, on approuve avec `npm run approve`.

**Corrigé :** les `instructions` ne parlent plus de dashboard. Chaque réponse qui signale une approbation porte un champ `approval_instructions` avec la commande complète, chemin et identifiant de tâche compris, et la consigne demande à Claude de la transmettre telle quelle **avant** de rappeler l'attente. Vérifié par S8.

### Défaut n° 2 — Une seconde attente sur une approbation rend la main aussitôt

Le long-poll considère `waiting_approval` comme un état « à signaler ». Quand Claude rappelle l'attente comme le lui demande la consigne, la tâche est *déjà* en attente d'approbation, et l'appel revient en 2 ms avec la même réponse. Claude a alors raisonnablement cessé de boucler et terminé son tour. Sa phrase « je reste en attente » était donc fausse : plus rien n'attendait, et le résultat de la tâche, terminée 12 s plus tard, n'a jamais été récupéré.

Un client moins prudent aurait pu boucler en consommant des tokens à chaque aller-retour.

**Corrigé :** chaque pause porte un numéro (`approval_seq`), et chaque serveur MCP retient la dernière pause qu'il a signalée à **son** client. Une pause n'est annoncée qu'une fois (`human_approval_pending`) ; ensuite, l'attente bloque jusqu'à la décision humaine, puis continue jusqu'à la fin de la tâche si son délai le permet. Si le délai expire avant, la réponse est `still_waiting_for_human`.

Pourquoi un numéro plutôt que « ne jamais s'arrêter sur une approbation » : une pause survenue *entre* deux attentes doit être signalée tout de suite, sinon Claude bloquerait sans jamais prévenir l'humain ; et une seconde pause sur la même tâche, inévitable avec de vrais agents, doit l'être aussi. Vérifié par S9.

**Vérifié en session réelle** : voir le second test ci-dessous.

## Second test réel, après correctifs

**Date :** 2026-10-28, nouvelle session « Harness Midgaard test approbation », client `claude-code` 2.1.309. Tâche de 10 s avec approbation ; l'humain a volontairement attendu avant d'approuver.

| Heure (UTC) | Événement |
|---|---|
| 20:37:50.754 | Le premier serveur MCP trouve l'ancien daemon (pid 47929, sans version de protocole) et l'arrête |
| 20:37:50.960 | Nouveau daemon prêt, **206 ms** plus tard |
| 20:37:53 | Attente n° 1 (`timeout_s` 60, `known_approval` 0) |
| 20:37:57 | … `human_approval_pending` après 3,4 s, 3 ms après la pause |
| 20:38:02 | Attente n° 2, `timeout_s` **300 choisi par Claude**, `known_approval` 1 → l'appel **bloque** |
| 20:42:06 | Approbation humaine |
| 20:42:10.888 | Tâche terminée ; l'attente rend `result_ready` **à la même milliseconde** |
| 20:42:25 | Claude termine son tour avec le résultat |

| Vérification | Résultat |
|---|---|
| Défaut n° 1 : consigne exacte | ✅ Claude écrit qu'il ne peut pas approuver lui-même et donne la commande complète dans un bloc `bash`, chemin et identifiant compris. Aucune mention de dashboard dans la session |
| Défaut n° 2 : l'attente bloque jusqu'à la décision | ✅ Un seul appel de **248,6 s**, 16 notifications de progression, aucune coupure, aucune boucle |
| Claude prévient *avant* de bloquer | ✅ Message écrit pendant les 5 s entre les deux attentes ; l'humain a pu approuver pendant le blocage |
| Résultat récupéré | ✅ `result_ready` reçu, tour terminé 14 s après |
| Remplacement d'un daemon d'ancienne version (S10) | ✅ En conditions réelles, sans intervention |

Constat : Claude choisit lui-même un délai long (300 s) quand il sait attendre un humain, et un délai court (60 s) pour une tâche courte. La valeur par défaut de 120 s n'a pas servi.

## Rejouer

```bash
cd spike
npm install
npm run typecheck
npm run test:wait          # ~100 s
npm run test:lock          # ~30 s, instance unique sous concurrence
npm run approve            # approuve la tâche en attente (ou liste-les s'il y en a plusieurs)
```

## Fichiers

- `src/shared.ts` — chemins runtime, types, client HTTP authentifié
- `src/daemon.ts` — HTTP loopback, verrou d'instance, tâches factices, long-poll
- `src/mcp-server.ts` — adaptateur stdio, auto-démarrage du daemon, attente par tranches, trace
- `src/approve.ts` — approbation humaine en CLI, sans argument si une seule tâche attend (volontairement hors MCP)
- `test/long-wait.ts` — suite de bout en bout
- `test/single-instance.ts` — instance unique sous concurrence
