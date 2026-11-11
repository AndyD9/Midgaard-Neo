# `@midgaard/mcp-client`

Le client MCP du daemon (Slice 8, étape 1) : il lance un **serveur MCP stdio**
déclaré par l'humain — REA d'abord —, fait la poignée de main, lit son
catalogue et appelle ses outils, **sous la garde des processus** : rien de ce
que le serveur lance ne survit à la connexion, ni au daemon tué net.

Le paquet ne connaît ni le daemon, ni la base, ni les approbations. Ce qu'un
agent a le droit d'appeler — liste blanche à empreinte, approbation sur
arguments exacts, encadrement du résultat — est l'affaire des outils
(étape 3, [docs/SLICE8.md](../../docs/SLICE8.md)).

```ts
const connection = await McpConnection.open({
  command: '/opt/homebrew/bin/node',                     // absolu, jamais résolu par le PATH
  args: ['/chemin/vers/rea/scripts/rea.mjs', 'mcp'],
  env: serverEnv(sourceEnv, { REA_MCP_INPUT_SCHEMA_PROFILE: 'compact' }),
  cwd: projectDir,
})
const tools = await connection.listTools()               // le catalogue réel, pages comprises
const result = await connection.callTool('open_binary', { path }, { timeoutMs, signal })
await connection.close()                                 // idempotente, ne lève pas
```

## Ce que la connexion garantit

| Garantie | Comment |
|---|---|
| Aucun processus survivant | Le serveur est **chef de son groupe** (POSIX), confié à la garde d'`exec` (`guardGroup`, paquet `tools`) **avant** la poignée de main. Fermé, le groupe entier est tué ; daemon tué net, la garde le fait. Compté au système dans les tests, petit-enfant compris |
| Arrêt complet | La séquence de la spécification MCP pour stdio — fermer l'entrée, `SIGTERM`, `SIGKILL`, deux secondes de grâce entre chaque — adressée au **groupe**. Le `SIGKILL` final part toujours : un serveur qui quitte proprement peut laisser des fils |
| Programme déclaré, pas deviné | La commande doit être un chemin **absolu** ; aucun shell n'interprète les arguments |
| Aucun secret du daemon | `serverEnv` ne transmet qu'une liste nommée (dossier personnel, `PATH`, dossiers temporaires, langue), plus ce que l'humain déclare. Une clé d'API posée dans l'environnement du daemon n'atteint pas le serveur — vérifié par le serveur lui-même |
| Aucune capacité cliente | Ni `sampling` (le serveur ferait appeler le modèle de l'agent, à ses frais), ni `roots`, ni `elicitation`. Un serveur qui en demande reçoit « méthode inconnue » |
| Appels bornés | Chaque appel prend le délai de la tâche ; une progression **ne le prolonge pas**. À l'annulation ou au délai, le SDK envoie `notifications/cancelled` — reçue par le serveur, constaté |
| Sortie standard du daemon intacte | Ce que le serveur écrit sur sa sortie d'erreur n'est recopié nulle part ; on en garde les 8 derniers Kio, **non expurgés**, pour expliquer un échec — au daemon de les expurger avant de les montrer. L'arrêt attend la fermeture des **tubes**, pas seulement la sortie du processus : ce qu'un serveur écrit juste avant de mourir arrive après |
| Mémoire bornée | Un message reçu de plus de 16 Mio ferme la connexion et le dit ; un catalogue de plus de 1 000 outils, ou dont la pagination boucle, est refusé |

## Les échecs

Un outil qui **échoue** rend un résultat `isError: true` : ce n'est pas une
exception, le modèle doit le lire. Une `McpClientError` dit que l'appel n'a
pas abouti, avec sa raison :

| `reason` | Sens |
|---|---|
| `start` | Le programme n'est pas absolu, ne se lance pas, ou ne termine pas `initialize` — un binaire qui existe sans parler MCP est dit tel. L'erreur porte `stderrTail`, la fin de la sortie d'erreur **non expurgée** : la connexion n'existe plus pour la demander |
| `exited` | Le serveur est sorti (code ou signal dans le message) ; la connexion ne sert plus |
| `timeout` | Pas de réponse dans le délai ; la connexion reste utilisable |
| `cancelled` | La tâche a été annulée |
| `protocol` | Réponse hors protocole, catalogue trop grand, pagination qui boucle |

Les messages sont en anglais : c'est le modèle qui les lit.

## Pourquoi pas le `StdioClientTransport` du SDK

Il lance le serveur **dans le groupe du daemon** et ne tue que le processus
principal. REA lance Ghidra, Hopper ou IDA : ces petits-enfants survivraient à
la tâche, et un daemon tué net ne tuerait plus rien. `GuardedStdioTransport`
reprend la recette d'`exec` ; le protocole, lui, reste celui du SDK (`Client`,
`ReadBuffer`, `serializeMessage`).

## Ce qu'il ne couvre pas

- **Un fils qui quitte le groupe** (`setsid`, `detached: true`) échappe à la
  garde comme à la fermeture. Le test le prouve pour un fils ordinaire ; pour
  Ghidra lancé par REA, ce sera constaté à l'essai réel (étape 7).
- **Sous Windows**, l'arbre est atteint par `taskkill /T`, qui ne retrouve
  plus les enfants d'un parent déjà mort — même limite qu'`exec`. Un `.cmd` ne
  se lance pas sans shell : déclarer `node.exe` et le script, comme REA le
  recommande.
- **stdio seulement.** Le HTTP local viendra quand un serveur le demandera
  (décision 2).

## Tests

`tests/unit/mcp-client.test.ts`, dans `npm run test:unit`, contre
`tests/fake-mcp-server.ts` : un vrai serveur du SDK dont les outils
reproduisent ce qu'un serveur réel fait de gênant — durer, annoncer sa
progression, lancer un processus, mourir en cours d'appel, ignorer `SIGTERM`.
Le cas du daemon tué net **fige** le serveur (`SIGSTOP`, POSIX) et regarde un
petit-enfant qui ne lit rien : sans cela, un serveur qui quitte seul à la
fermeture de son entrée ferait passer le test sans la garde (leçon de la
Slice 7). Vu échouer sans la garde, et sans le groupe de processus.
