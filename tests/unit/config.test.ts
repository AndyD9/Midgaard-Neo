/**
 * @file Configuration : l'injection doit vraiment fonctionner.
 *
 * Le spike lisait l'environnement au niveau module, et les imports ESM étant
 * hissés, la valeur était figée avant qu'un test puisse la changer. Ces
 * vérifications existent pour que la régression soit bruyante.
 */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_PORT, loadConfig } from '@midgaard/contracts'

describe('loadConfig', () => {
  it('place son état dans le dossier utilisateur par défaut', () => {
    const config = loadConfig({})
    assert.equal(config.home, join(homedir(), '.midgaard'))
    assert.equal(config.dbPath, join(homedir(), '.midgaard', 'harness.db'))
    assert.equal(config.port, DEFAULT_PORT)
    assert.equal(config.portIsExplicit, false)
  })

  it('dérive tous les chemins de MIDGAARD_HOME', () => {
    // `join` : sous Windows, les chemins dérivés sont en `\\`.
    const config = loadConfig({ MIDGAARD_HOME: '/tmp/ailleurs' })
    for (const path of [config.dbPath, config.runtimeFile, config.lockFile, config.logFile, config.traceFile]) {
      assert.ok(path.startsWith(join('/tmp/ailleurs', '')), path)
    }
  })

  it('distingue un port choisi d\'un port par défaut', () => {
    // Un port explicitement demandé mais occupé doit être une erreur, pas un repli
    // silencieux sur un autre port.
    assert.equal(loadConfig({ MIDGAARD_PORT: '9001' }).portIsExplicit, true)
    assert.equal(loadConfig({ MIDGAARD_PORT: '9001' }).port, 9001)
    assert.equal(loadConfig({ MIDGAARD_PORT: '' }).portIsExplicit, false)
  })

  it('accepte 0 comme désactivation de l\'arrêt pour inactivité', () => {
    assert.equal(loadConfig({ MIDGAARD_IDLE_SHUTDOWN_S: '0' }).idleShutdownMs, 0)
    assert.equal(loadConfig({ MIDGAARD_IDLE_SHUTDOWN_S: '60' }).idleShutdownMs, 60_000)
  })

  it('ignore une valeur d\'inactivité absurde plutôt que de produire NaN', () => {
    assert.equal(loadConfig({ MIDGAARD_IDLE_SHUTDOWN_S: 'beaucoup' }).idleShutdownMs, 1_800_000)
  })

  it('recalcule les chemins quand une surcharge change le dossier', () => {
    const config = loadConfig({ MIDGAARD_HOME: '/tmp/a' }, { home: '/tmp/b' })
    assert.equal(config.dbPath, join('/tmp/b', 'harness.db'))
    assert.equal(config.lockFile, join('/tmp/b', 'daemon.lock'))
  })

  it('ne lit jamais l\'environnement du processus de lui-même', () => {
    // Appel sans argument : aucune variable du processus ne doit fuiter dedans.
    process.env.MIDGAARD_HOME = '/tmp/ne-doit-pas-etre-lu'
    try {
      assert.notEqual(loadConfig().home, '/tmp/ne-doit-pas-etre-lu')
    } finally {
      delete process.env.MIDGAARD_HOME
    }
  })
})
