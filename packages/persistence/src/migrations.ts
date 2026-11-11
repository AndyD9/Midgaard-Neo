/**
 * @file Schéma de la base et migrations versionnées.
 *
 * La version du schéma est suivie par `PRAGMA user_version`, un entier stocké
 * dans l'en-tête du fichier SQLite. Pas de table de suivi à maintenir, et la
 * lecture comme l'écriture participent à la transaction de la migration : une
 * migration interrompue ne laisse jamais une base à moitié migrée.
 *
 * **Règle** : une migration publiée ne se modifie plus. Toute évolution ajoute
 * une entrée à la fin de {@link MIGRATIONS}. Les bases des utilisateurs existent
 * déjà ; réécrire une migration passée les laisserait dans un état que personne
 * ne peut reproduire.
 */
import type { DatabaseSync } from 'node:sqlite'

/** Une étape de migration : du schéma `version - 1` vers `version`. */
export interface Migration {
  version: number
  /** Ce que cette étape apporte, pour le journal et la revue de code. */
  label: string
  sql: string
}

/**
 * Limites par défaut appliquées aux tâches de la Slice 1, qui n'en avaient pas.
 *
 * Écrites en toutes lettres dans le SQL de la migration 2 plutôt qu'importées de
 * `@midgaard/contracts` : une migration publiée ne se modifie plus, et elle doit
 * donc produire le même résultat dans dix versions, même si les valeurs par
 * défaut du code ont changé entre-temps. Importer une constante vivante ferait
 * dériver une migration figée.
 */
const SLICE1_DEFAULT_LIMITS =
  '{"max_steps":12,"max_cost_usd":0.5,"timeout_s":300,"max_output_tokens":4096,"max_tool_calls_per_step":5}'

/** Consommation nulle, pour les tâches antérieures au comptage des coûts. */
const ZERO_USAGE =
  '{"model_calls":0,"input_tokens":0,"output_tokens":0,"reasoning_tokens":0,"cached_tokens":0,' +
  '"web_searches":0,"cost_usd":0,"cost_source":"unknown","cost_usd_estimated":null,"cost_usd_reported":null}'

/**
 * Migrations, dans l'ordre. La version 1 est le schéma de la Slice 1, les
 * versions 2 et 3 celui de la Slice 2, la 4 ouvre la Slice 3, la 9 la Slice 6,
 * la 10 la Slice 7.
 *
 * Des tables prévues au plan (§6), deux n'existeront pas. `projects` : un
 * projet est le dépôt d'où la tâche est déléguée, déjà porté par
 * `tasks.project_dir` et `workspaces.repo_dir` — une table de plus serait une
 * copie à tenir cohérente. `artifacts` : le diff d'un worktree se calcule à la
 * demande, et le figer en ferait une seconde vérité. `usage` n'a pas de table
 * non plus — voir la migration 2.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    label: 'Slice 1 — tâches, journal d\'événements, approbations',
    sql: `
      CREATE TABLE tasks (
        id            TEXT    PRIMARY KEY,
        objective     TEXT    NOT NULL,
        status        TEXT    NOT NULL,
        step          INTEGER NOT NULL DEFAULT 0,
        steps_total   INTEGER NOT NULL,
        needs_approval INTEGER NOT NULL DEFAULT 0,
        approval_seq  INTEGER NOT NULL DEFAULT 0,
        duration_s    INTEGER NOT NULL,
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL,
        started_at    TEXT,
        ended_at      TEXT,
        result_json   TEXT,
        error         TEXT
      );
      CREATE INDEX tasks_status_idx  ON tasks(status);
      CREATE INDEX tasks_created_idx ON tasks(created_at DESC);

      -- 'seq' est AUTOINCREMENT et non un simple rowid : SQLite réutilise les
      -- rowid libérés, ce qui casserait la reprise WebSocket (un client ayant vu
      -- la séquence 412 pourrait manquer un événement renuméroté 412).
      CREATE TABLE task_events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        task_seq     INTEGER NOT NULL,
        type         TEXT    NOT NULL,
        status       TEXT    NOT NULL,
        at           TEXT    NOT NULL,
        payload_json TEXT    NOT NULL DEFAULT '{}',
        UNIQUE(task_id, task_seq)
      );
      CREATE INDEX task_events_task_idx ON task_events(task_id, task_seq);

      CREATE TABLE approvals (
        id             TEXT PRIMARY KEY,
        task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        seq            INTEGER NOT NULL,
        operation      TEXT NOT NULL,
        operation_hash TEXT NOT NULL,
        status         TEXT NOT NULL,
        requested_at   TEXT NOT NULL,
        expires_at     TEXT NOT NULL,
        resolved_at    TEXT,
        resolved_by    TEXT,
        reason         TEXT,
        UNIQUE(task_id, seq)
      );
      CREATE INDEX approvals_status_idx ON approvals(status);
    `,
  },
  {
    version: 2,
    label: 'Slice 2 — agents, fournisseurs, appels d\'outils, consommation',
    sql: `
      -- Les tâches gagnent de quoi dire QUI les exécute, avec QUEL contexte,
      -- sous QUELLES limites, et ce qu'elles ont COÛTÉ.
      --
      -- 'agent_id' prend 'simulated' par défaut : les tâches de la Slice 1 ont
      -- toutes été exécutées par le moteur simulé, et le dire après coup est
      -- exact, alors que les laisser sans agent obligerait tout le code aval à
      -- traiter un cas « tâche sans exécutant » qui n'existe pas.
      ALTER TABLE tasks ADD COLUMN agent_id    TEXT NOT NULL DEFAULT 'simulated';
      ALTER TABLE tasks ADD COLUMN context     TEXT;
      ALTER TABLE tasks ADD COLUMN limits_json TEXT NOT NULL DEFAULT '${SLICE1_DEFAULT_LIMITS}';
      ALTER TABLE tasks ADD COLUMN usage_json  TEXT NOT NULL DEFAULT '${ZERO_USAGE}';
      CREATE INDEX tasks_agent_idx ON tasks(agent_id);

      -- Fournisseurs de modèles. 'secret_ref' désigne une clé dans le coffre
      -- système : cette table n'en contient jamais aucune, pour qu'une base
      -- copiée ou sauvegardée ne donne accès à rien (§5 du plan).
      CREATE TABLE provider_configs (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL,
        preset         TEXT NOT NULL,
        base_url       TEXT,
        default_model  TEXT NOT NULL,
        secret_ref     TEXT,
        web_search     TEXT NOT NULL DEFAULT 'off',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        last_test_json TEXT
      );

      -- Profils d'agents. 'provider_id' est volontairement SANS clé étrangère :
      -- supprimer un fournisseur ne doit pas faire disparaître les profils qui
      -- s'y référaient, sinon l'utilisateur perd sa configuration en voulant
      -- changer de clé. Un profil orphelin se désactive, il ne s'efface pas.
      CREATE TABLE agents (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        provider_id   TEXT,
        model         TEXT,
        system_prompt TEXT NOT NULL DEFAULT '',
        tools_json    TEXT NOT NULL DEFAULT '[]',
        limits_json   TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      -- Appels d'outils. Arguments et résultats y sont stockés EXPURGÉS : si une
      -- clé traverse un outil, elle ne doit pas se retrouver en clair dans une
      -- base que l'utilisateur sauvegardera sans y penser.
      CREATE TABLE tool_calls (
        id             TEXT PRIMARY KEY,
        task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        step           INTEGER NOT NULL,
        call_id        TEXT NOT NULL,
        name           TEXT NOT NULL,
        status         TEXT NOT NULL,
        decision       TEXT NOT NULL,
        arguments_json TEXT NOT NULL DEFAULT '{}',
        result_summary TEXT,
        result_bytes   INTEGER,
        duration_ms    INTEGER,
        error          TEXT,
        requested_at   TEXT NOT NULL,
        ended_at       TEXT
      );
      CREATE INDEX tool_calls_task_idx ON tool_calls(task_id, requested_at);
    `,
  },
  {
    version: 3,
    label: 'Slice 2 — racine de lecture d\'une tâche',
    sql: `
      -- Dossier que l'agent a le droit de lire, transmis par le serveur MCP à la
      -- délégation (son propre dossier de travail, donc le dépôt ouvert dans la
      -- session Claude Code).
      --
      -- NULL pour les tâches simulées, qui ne lisent rien. Une migration à part
      -- de la 2 parce que celle-ci était déjà appliquée aux bases de développement
      -- quand le besoin est apparu : une migration publiée ne se modifie plus,
      -- même la veille.
      ALTER TABLE tasks ADD COLUMN project_dir TEXT;
    `,
  },
  {
    version: 4,
    label: 'Slice 3 — worktrees des agents écrivants',
    sql: `
      -- Un worktree Git par tâche d'agent écrivant (PLAN §6). Sans cette table,
      -- les worktrees laissés par un crash seraient impossibles à retrouver de
      -- façon fiable : le dossier seul ne dit ni à quelle tâche il appartient,
      -- ni de quel commit il est parti.
      --
      -- base_commit est la référence de tout diff : jamais la branche d'origine,
      -- qui a pu avancer depuis. base_dirty compte les chemins non commités du
      -- dépôt d'origine au moment de la délégation — absents du worktree, et
      -- donc à annoncer. La ligne n'est jamais supprimée : 'removed' garde la
      -- trace de la branche, qui survit au worktree.
      CREATE TABLE workspaces (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        repo_dir      TEXT NOT NULL,
        subdir        TEXT NOT NULL DEFAULT '',
        worktree_path TEXT NOT NULL UNIQUE,
        branch        TEXT NOT NULL,
        base_commit   TEXT NOT NULL,
        base_ref      TEXT,
        base_dirty    INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        removed_at    TEXT
      );
      CREATE INDEX workspaces_status_idx ON workspaces(status, created_at);
    `,
  },
  {
    version: 5,
    label: 'Slice 3 — opération exacte des approbations',
    sql: `
      -- La forme structurée de ce qu'une approbation autorise : pour 'exec', le
      -- programme résolu, les arguments, le dossier absolu et l'empreinte du
      -- binaire. L'empreinte 'operation_hash' est tirée de ce JSON canonique, et
      -- non plus du texte affiché : deux opérations qui s'affichent pareil
      -- n'ont plus la même empreinte. NULL pour les demandes plus anciennes.
      ALTER TABLE approvals ADD COLUMN operation_json TEXT;
    `,
  },
  {
    version: 6,
    label: 'Slice 3 — liste blanche exec par projet',
    sql: `
      -- Commandes qu'exec lance sans approbation, pour UN dépôt (sa racine
      -- canonique). Le plan (§5) voulait une liste par projet ; la variable
      -- MIDGAARD_EXEC_ALLOW, globale, reste et s'y ajoute.
      --
      -- argv_json est l'argv EXACT, en JSON : 'npm test' n'autorise pas
      -- 'npm test -- --watch'. added_by dit qui l'a ajoutée — un humain, par la
      -- CLI ; une entrée sans auteur ne se relirait pas.
      CREATE TABLE exec_allow (
        repo_dir   TEXT NOT NULL,
        argv_json  TEXT NOT NULL,
        added_at   TEXT NOT NULL,
        added_by   TEXT NOT NULL,
        PRIMARY KEY (repo_dir, argv_json)
      );
    `,
  },
  {
    version: 7,
    label: 'Slice 4 — sous-modules absents des worktrees',
    sql: `
      -- Chemins des sous-modules du commit de départ, en JSON. git worktree add
      -- les laisse vides, et ce qu'un agent y écrit est ignoré sans un mot par
      -- git add -A : la liste est gardée pour être dite à l'agent, à Claude et
      -- dans le dashboard. '[]' pour les worktrees créés avant.
      ALTER TABLE workspaces ADD COLUMN submodules_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 8,
    label: 'Slice 5 — tâches déléguées par une tâche',
    sql: `
      -- La tâche qui a délégué celle-ci, posée par le daemon seul ; NULL pour
      -- une tâche née d'un client (serveur MCP, dashboard), donc pour toutes
      -- celles d'avant.
      --
      -- ON DELETE CASCADE, comme le journal et les approbations : rien ne
      -- supprime de tâche aujourd'hui, mais un enfant sans parent se lirait
      -- comme une tâche de premier niveau, ce qu'il n'a jamais été.
      ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
      -- L'annulation en cascade et la carte « Sous-tâches » cherchent les
      -- enfants d'un parent.
      CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);
    `,
  },
  {
    version: 9,
    label: 'Slice 6 — conversations et attente d\'un message',
    sql: `
      -- Manière dont la tâche converse (oneshot, chat, review), posée par le
      -- daemon seul. Toute tâche d'avant était un objectif suivi d'un
      -- submit_result : 'oneshot', écrit en toutes lettres, comme toute valeur
      -- d'une migration publiée.
      ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'oneshot';
      -- Ce qu'attend une tâche en waiting_input (chat, question, proposal) ;
      -- NULL dans tout autre statut, donc pour toutes les tâches d'avant.
      ALTER TABLE tasks ADD COLUMN awaiting_input TEXT;
    `,
  },
  {
    version: 10,
    label: 'Slice 7 — un profil déclare que son modèle lit les images',
    sql: `
      -- 1 : le modèle lit les images, 0 : il ne les lit pas, NULL : rien de
      -- déclaré. Ne sert que lorsque le fournisseur ne publie pas la capacité.
      -- NULL pour tous les profils d'avant : personne n'avait rien déclaré.
      ALTER TABLE agents ADD COLUMN vision INTEGER;
    `,
  },
  {
    version: 11,
    label: 'Slice 8 — serveurs MCP déclarés, outils cochés',
    sql: `
      -- Serveurs MCP déclarés par l'humain. Aucun secret ici : secret_env_json
      -- ne porte que des NOMS de variables, dont les valeurs sont au coffre.
      -- catalog_json est le catalogue constaté au dernier test réussi (outils et
      -- empreintes), NULL tant qu'il n'y en a pas : on ne décrit pas un outil
      -- qu'on n'a pas lu chez le serveur.
      CREATE TABLE mcp_servers (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        transport       TEXT NOT NULL,
        command         TEXT NOT NULL,
        args_json       TEXT NOT NULL DEFAULT '[]',
        env_json        TEXT NOT NULL DEFAULT '{}',
        secret_env_json TEXT NOT NULL DEFAULT '[]',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        last_test_json  TEXT,
        catalog_json    TEXT,
        catalog_at      TEXT
      );

      -- Outils cochés libres, avec l'empreinte de ce que l'humain a lu en les
      -- cochant. Un outil dont l'empreinte annoncée ne correspond plus n'est
      -- plus libre. added_by dit qui l'a coché, comme exec_allow.
      --
      -- ON DELETE CASCADE : retirer un serveur retire ce qu'on y avait coché.
      -- Redéclaré plus tard sous le même nom, il ne doit rien hériter.
      CREATE TABLE mcp_tool_allow (
        server_id   TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        tool_name   TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        added_at    TEXT NOT NULL,
        added_by    TEXT NOT NULL,
        PRIMARY KEY (server_id, tool_name)
      );
    `,
  },
  {
    version: 12,
    label: 'Slice 8 — les serveurs MCP d\'un profil',
    sql: `
      -- Serveurs MCP dont les agents du profil reçoivent les outils, en JSON :
      -- des identifiants de mcp_servers. Sans clé étrangère, comme provider_id :
      -- le retrait d'un serveur le retire des profils (le daemon le fait et le
      -- dit), et un JSON ne se contraint pas. '[]' pour les profils d'avant.
      ALTER TABLE agents ADD COLUMN mcp_servers_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 13,
    label: 'Slice 8 — agents créés à la volée par un orchestrateur',
    sql: `
      -- Un agent créé appartient à l'arbre de l'orchestrateur qui l'a créé
      -- (task_id) : il ne sert qu'à ses sous-tâches, et disparaît avec lui
      -- (ON DELETE CASCADE, comme le journal). Ce n'est pas un profil : la
      -- table agents reste celle des profils que l'humain règle.
      CREATE TABLE created_agents (
        id                TEXT PRIMARY KEY,
        task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        base_agent_id     TEXT NOT NULL,
        provider_id       TEXT NOT NULL,
        model             TEXT,
        role              TEXT NOT NULL,
        mcp_servers_json  TEXT NOT NULL DEFAULT '[]',
        limits_json       TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX created_agents_task_idx ON created_agents(task_id);
    `,
  },
  {
    version: 14,
    label: 'Slice 9 — les playbooks d\'un profil',
    sql: `
      -- Playbooks ajoutés à la consigne des agents du profil, en JSON : des
      -- identifiants de fichiers du dossier playbooks/, dans l'ordre. Pas leur
      -- contenu : il se lit au départ de chaque tâche, et la timeline garde
      -- l'empreinte de ce qui a été lu. '[]' pour les profils d'avant.
      ALTER TABLE agents ADD COLUMN playbooks_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 15,
    label: 'Slice 9 — préfixes de la liste blanche exec',
    sql: `
      -- 1 : l'entrée couvre tout argv qui commence par argv_json (mots
      -- comparés un à un). 0 : l'argv exact, comme toutes les entrées d'avant.
      -- La clé reste (repo_dir, argv_json) : un même argv est exact OU préfixe,
      -- et l'élargir se voit comme un changement de cette ligne, journalisé.
      ALTER TABLE exec_allow ADD COLUMN prefix INTEGER NOT NULL DEFAULT 0 CHECK (prefix IN (0, 1));
    `,
  },
  {
    version: 16,
    label: 'Slice 9 — échantillons d\'une tâche',
    sql: `
      -- Échantillons copiés en lecture seule pour la tâche, en JSON : nom de la
      -- copie, SHA-256, taille. Pas le chemin d'origine, qui peut nommer
      -- l'utilisateur ou un dossier de travail : seul le journal du daemon le
      -- cite, à la copie. Les copies vivent sous samplesDir/<tâche> et partent
      -- avec elle. '[]' pour les tâches d'avant.
      ALTER TABLE tasks ADD COLUMN samples_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 17,
    label: 'Slice 9 — VM Windows de test',
    sql: `
      -- Les VM Windows déclarées par l'humain. La clé privée n'est PAS ici :
      -- générée par le daemon, elle va au coffre, sous une référence dérivée
      -- de l'identifiant ; la base ne garde que la clé publique, à poser sur la
      -- VM, et l'empreinte d'hôte épinglée, recopiée depuis sa console.
      -- last_test_json est effacé quand l'adresse, le compte, l'empreinte ou la
      -- clé changent : il ne dirait plus rien de la nouvelle déclaration.
      CREATE TABLE windows_hosts (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        host           TEXT NOT NULL,
        port           INTEGER NOT NULL,
        username       TEXT NOT NULL,
        fingerprint    TEXT NOT NULL,
        public_key     TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        last_test_json TEXT
      );
    `,
  },
  {
    version: 18,
    label: 'Slice 9 — la VM Windows d\'un profil',
    sql: `
      -- La VM Windows de test attachée au profil, par identifiant (une au
      -- plus) ; NULL sans VM, comme tous les profils d'avant. Pas de clé
      -- étrangère : le retrait d'une VM la détache explicitement des profils
      -- qui la portent, et le journal le dit (daemon/src/windows-hosts.ts).
      ALTER TABLE agents ADD COLUMN windows_host TEXT;
    `,
  },
  {
    version: 19,
    label: 'Slice 10 — les findings d\'un arbre d\'orchestrateur',
    sql: `
      -- Une vulnérabilité candidate, suivie dans l'arbre d'un orchestrateur.
      -- tree_task_id est la tâche racine (l'orchestrateur), posée par le daemon
      -- seul : un finding appartient à un arbre, comme un agent créé (Slice 8),
      -- et aucun autre arbre ne le voit. Pas de clé étrangère : l'arbre est
      -- borné par le daemon, et un finding survit à la lecture de l'historique
      -- même si sa tâche racine est purgée un jour.
      --
      -- status va de 'open' (record_finding) à 'rejected' (reject_finding) ou
      -- 'trace_confirmed' (confirm_trace). C'est confirm_trace, et lui seul, qui
      -- pose 'trace_confirmed' avec threat_model et une chaîne taint_path_json
      -- non vide : la porte de traçage est mécanique, pas une consigne.
      CREATE TABLE findings (
        id              TEXT PRIMARY KEY,
        tree_task_id    TEXT NOT NULL,
        title           TEXT NOT NULL,
        vuln_class      TEXT NOT NULL,
        sink            TEXT NOT NULL,
        source          TEXT NOT NULL,
        evidence        TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'open',
        reject_reason   TEXT,
        threat_model    TEXT,
        taint_path_json TEXT NOT NULL DEFAULT '[]',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX findings_tree_idx ON findings(tree_task_id);
    `,
  },
  {
    version: 20,
    label: 'Suite d\'une tâche terminée',
    sql: `
      -- La tâche terminée que celle-ci prolonge ; NULL pour toutes les autres,
      -- donc pour toutes celles d'avant. Posée par le daemon seul.
      --
      -- ON DELETE SET NULL, et non CASCADE comme parent_task_id : une suite
      -- est une tâche de premier niveau à part entière, qui garde son journal
      -- et son résultat même si celle qu'elle prolongeait disparaissait.
      ALTER TABLE tasks ADD COLUMN continues_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
    `,
  },
]

// Pas de table 'usage' : la consommation d'une tâche vit dans 'tasks.usage_json',
// et son historique est déjà dans le journal, où chaque 'usage.updated' porte le
// cumul du moment. Une table de plus n'ajouterait qu'une troisième copie à tenir
// cohérente avec les deux autres. Le plan (§6) la prévoyait ; c'est un écart
// assumé, documenté dans docs/SLICE2.md.

/** Version de schéma attendue par ce code. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version

/**
 * Version de schéma d'une base ouverte, lue sans rien écrire.
 *
 * @param db base ouverte, en lecture seule ou non
 * @returns `0` pour une base vierge, sinon la dernière migration appliquée
 */
export function schemaVersionOf(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

/**
 * Applique les migrations manquantes, chacune dans sa propre transaction.
 *
 * @param db     base ouverte
 * @param log    journalisation facultative, pour tracer les migrations appliquées
 * @returns la liste des versions appliquées pendant cet appel (vide si à jour)
 * @throws si la base est **plus récente** que ce code : une version future a pu
 *         changer le sens de colonnes existantes, et l'ouvrir quand même
 *         risquerait de corrompre des données qu'on ne comprend pas
 */
export function migrate(db: DatabaseSync, log: (msg: string) => void = () => {}): number[] {
  const current = schemaVersionOf(db)
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `base en version de schéma ${current}, ce code en connaît ${SCHEMA_VERSION} : ` +
        'mets à jour Midgaard, ou ouvre une autre base avec MIDGAARD_HOME.',
    )
  }
  const applied: number[] = []
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.sql)
      // `user_version` n'accepte pas de paramètre lié : la valeur vient de notre
      // propre table de migrations, jamais d'une entrée utilisateur.
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    log(`migration ${m.version} appliquée : ${m.label}`)
    applied.push(m.version)
  }
  return applied
}
