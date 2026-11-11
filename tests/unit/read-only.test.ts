/**
 * @file Ce qui constate ne change rien : la base ouverte en lecture seule, et
 * `harness doctor` et `harness status` lancés pour de vrai sur une base qu'ils
 * n'ont pas le droit de migrer.
 *
 * Né de docs/SLICE3.md, leçon n° 17 : `doctor` ouvrait la base par
 * `HarnessStore.open`, qui migre, et l'a fait passer du schéma 3 au schéma 6
 * sous un daemon plus ancien encore en marche. Les tests comparent donc la base
 * **octet pour octet** avant et après, plutôt que de se fier à ce que la
 * commande affiche.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { loadConfig } from '@midgaard/contracts'
import { HarnessStore, MIGRATIONS, SCHEMA_VERSION, schemaVersionOf } from '@midgaard/persistence'
import { schemaCheck } from '@midgaard/cli'

let home: string
let dbPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'midgaard-ro-'))
  dbPath = loadConfig({ MIDGAARD_HOME: home }).dbPath
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

/**
 * Fabrique une base arrêtée au schéma `version`, comme l'aurait laissée une
 * version plus ancienne du harness : en WAL, migrations appliquées jusque-là.
 */
function baseAt(version: number): void {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) db.exec(m.sql)
  db.exec(`PRAGMA user_version = ${version}`)
  db.close()
}

/**
 * Lance la vraie CLI sur le dossier jetable. La condition `midgaard-dev` ne
 * s'hérite pas d'un processus à son fils : on la repasse quand on vise les
 * sources (voir `nodeArgsFor` dans `tests/helpers.ts`).
 */
function harness(...args: string[]) {
  const entry = fileURLToPath(import.meta.resolve('@midgaard/cli/main'))
  const node = entry.endsWith('.ts') ? ['--conditions=midgaard-dev', entry] : [entry]
  return spawnSync(process.execPath, [...node, ...args], {
    // `MIDGAARD_VAULT=file` : le coffre système est par utilisateur, pas par
    // dossier runtime ; `doctor` n'a pas à sonder celui du poste de test.
    env: { ...process.env, MIDGAARD_HOME: home, MIDGAARD_PORT: '0', MIDGAARD_VAULT: 'file', NO_COLOR: '1' },
    cwd: home,
    encoding: 'utf8',
    timeout: 30_000,
  })
}

describe('HarnessStore.openReadOnly', () => {
  it('ne migre pas une base ancienne, et en dit la version', () => {
    baseAt(3)
    const before = readFileSync(dbPath)
    const store = HarnessStore.openReadOnly({ dbPath })
    assert.equal(store.schemaVersion, 3)
    store.close()
    assert.ok(Buffer.compare(before, readFileSync(dbPath)) === 0, 'le fichier de la base doit rester intact')
  })

  it('refuse toute écriture : c\'est SQLite qui l\'interdit, pas une convention', () => {
    HarnessStore.open({ dbPath }).close()
    const store = HarnessStore.openReadOnly({ dbPath })
    try {
      assert.throws(() => store.addExecAllow('/depot', ['npm', 'test'], 'test'), /readonly/)
      assert.equal(store.countTasks().total, 0, 'la lecture, elle, fonctionne')
    } finally {
      store.close()
    }
  })

  it('ne crée pas une base absente', () => {
    assert.throws(() => HarnessStore.openReadOnly({ dbPath }))
    assert.equal(existsSync(dbPath), false)
  })
})

describe('schemaCheck', () => {
  it('distingue une base à jour, à migrer, et trop récente', () => {
    assert.equal(schemaCheck(SCHEMA_VERSION, { total: 2, active: 0 }).level, 'ok')
    const stale = schemaCheck(SCHEMA_VERSION - 1, null)
    assert.equal(stale.level, 'warn', 'une base ancienne n\'est pas une panne : le daemon la migrera')
    assert.match(stale.detail, /à migrer/)
    assert.match(stale.fix ?? '', /harness -- start/)
    assert.equal(schemaCheck(SCHEMA_VERSION + 1, null).level, 'fail')
  })
})

describe('doctor et status, lancés pour de vrai', () => {
  it('doctor diagnostique une base ancienne sans la migrer', () => {
    baseAt(3)
    const before = readFileSync(dbPath)
    const r = harness('doctor')
    assert.match(r.stdout, /schéma v3, ce code attend v\d+ : à migrer/, r.stdout + r.stderr)
    // Les contrôles qui lisent la base sont omis : sur le schéma 3, leurs
    // requêtes viseraient des tables qui n'existent pas encore.
    assert.doesNotMatch(r.stdout, /Fournisseurs|Worktrees/)
    assert.equal(r.status, 0, 'une base à migrer est un avertissement, pas un échec')
    assert.ok(Buffer.compare(before, readFileSync(dbPath)) === 0, 'doctor a écrit dans la base')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    assert.equal(schemaVersionOf(db), 3)
    db.close()
  })

  it('doctor lit une base à jour sans l\'écrire, et ne crée pas une base absente', () => {
    assert.equal(harness('doctor').status, 0)
    assert.equal(existsSync(dbPath), false, 'doctor a créé la base')

    HarnessStore.open({ dbPath }).close()
    const before = readFileSync(dbPath)
    const r = harness('doctor')
    assert.match(r.stdout, new RegExp(`schéma v${SCHEMA_VERSION}, 0 tâche`), r.stdout + r.stderr)
    assert.match(r.stdout, /Fournisseurs/, 'sur le bon schéma, les contrôles qui lisent la base ont lieu')
    assert.ok(Buffer.compare(before, readFileSync(dbPath)) === 0)
  })

  it('status refuse de lire une base ancienne, sans la migrer', () => {
    baseAt(3)
    const before = readFileSync(dbPath)
    const r = harness('status')
    assert.equal(r.status, 1, 'l\'historique demandé n\'a pas été affiché')
    assert.match(r.stdout, /à migrer/, r.stdout + r.stderr)
    assert.ok(Buffer.compare(before, readFileSync(dbPath)) === 0, 'status a écrit dans la base')
  })
})
