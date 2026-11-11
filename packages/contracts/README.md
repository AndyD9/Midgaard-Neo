# `@midgaard/contracts`

Source de vérité unique du harness : schémas Zod, types, machine à états et
protocole. Ne dépend d'aucun autre paquet et n'a **aucun effet de bord au
chargement** — c'est ce qui permet de le charger depuis le daemon, la CLI,
les tests et (pour les types) le dashboard.

| Module | Contenu |
|---|---|
| `config.ts` | `HarnessConfig` et `loadConfig(env, overrides)` — configuration **injectée**, jamais lue au niveau module |
| `advice.ts` | `harnessCommand` : la forme unique des commandes conseillées (`npm --prefix` hors du clone, `--home` pour un autre runtime) |
| `mcp.ts` | Serveurs MCP déclarés pour les agents (Slice 8) : déclaration, catalogue, outils cochés |
| `task.ts` | Modèle de tâche, statuts (dont `waiting_input`, Slice 6), table des transitions légales, modes (`oneshot`, `chat`, `review`), `inputFrom`, `nextActionFor`, `isActionable` |
| `events.ts` | Journal append-only : `seq` global (reprise WebSocket) et `task_seq` local (timeline) |
| `approvals.ts` | Demande d'approbation : opération précise, usage unique, expiration |
| `protocol.ts` | `PROTOCOL_VERSION`, formes des réponses HTTP, messages WebSocket |
| `runtime.ts` | Fichier de découverte du daemon (lecture, écriture atomique, `pidAlive`) |
| `client.ts` | `daemonFetch` / `daemonJson` — client HTTP authentifié |
| `agent.ts` | Profils d'agents exécutants : modèle, outils ; `MAX_OUTPUT_TOKENS` |
| `provider.ts` | Configuration des fournisseurs de modèles ; la clé n'y est qu'une référence au coffre |
| `usage.ts` | Consommation et coût, toujours avec sa provenance (`cost_source`) |
| `exec-allow.ts` | Liste blanche `exec` : `execPrefixRefusal` (quel préfixe est refusé, et pourquoi — Slice 9 ; `READ_ONLY_ANALYSIS` accepte une option en tête pour `objdump`/`nm`/`strings`… — Slice 10), `execRuleMatches`, `programFamily` |
| `workspace.ts` | Worktree d'un agent écrivant, et ce qui y manque (travail non commité, sous-modules) ; entrées de la liste blanche `exec` |
| `tools.ts` | Noms d'outils, journal des appels, `wrapUntrusted` |
| `redact.ts` | `createRedactor`, `redactDeep` : l'expurgation avant toute persistance |

## Deux règles à ne pas casser

**La configuration est injectée.** Rien ici ne lit `process.env` au chargement.
Chaque point d'entrée appelle `loadConfig(process.env)` une fois et passe le
résultat. Le spike faisait l'inverse, et les imports ESM étant hissés, les tests
devaient recourir à des imports dynamiques pour changer `MIDGAARD_HOME`.

**`PROTOCOL_VERSION` s'incrémente à tout changement incompatible** de l'API
HTTP, du modèle de tâche ou du protocole WebSocket. Le daemon survit aux mises
à jour du code ; c'est ce numéro qui le fait remplacer (`ensureDaemon`, dans la
CLI) au lieu de laisser un code récent dialoguer avec un daemon périmé. Il ne
redescend pas quand une brique est retirée.

## Deux filets contre ce qui vient d'ailleurs

**`createRedactor`** expurge avant journalisation et persistance : les secrets
connus (la clé du fournisseur) exactement, les autres par motif (`sk-…`,
`ghp_…`, `AIza…`…). **Tout** ce qui s'écrit en base y passe, y compris le
message d'un refus : il cite ce que le modèle a demandé, et un modèle détourné
y recopie ce qu'il a lu. Deux chemins l'oubliaient jusqu'à la Slice 4 ; la suite
`tests/security.ts` les a trouvés en lisant la base octet pour octet.

**`wrapUntrusted`** encadre ce qui vient d'une source que personne ne contrôle,
entre deux marqueurs portant un nonce aléatoire, et désamorce toute balise de
fin dans le contenu **et dans l'étiquette** — pour `exec`, l'étiquette est la
commande écrite par le modèle, et elle passait telle quelle jusqu'à la Slice 4.
Les deux sont éprouvés directement par `tests/unit/redact.test.ts`.
