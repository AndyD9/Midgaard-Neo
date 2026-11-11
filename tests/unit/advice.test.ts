/**
 * @file Commandes conseillées : leur forme, et l'option `--home` qui les relie
 * au bon dossier runtime.
 *
 * Constaté à la Slice 4, étape 8 (leçon n° 31) : la consigne d'approbation
 * disait `cd <clone> && npm run harness -- approve …`. Un client qui la
 * reformulait perdait le `cd` ; et même intacte, elle cherchait la demande
 * dans `~/.midgaard`, faute de redire `MIDGAARD_HOME`. Le scénario R8 de
 * `test:restart` lance la commande pour de vrai ; ces tests en fixent la forme.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { harnessCommand, loadConfig, pidAlive, readRuntime } from '@midgaard/contracts'
import { cmd, extractHome, portFallbackNote, setAdviceHome } from '@midgaard/cli'

describe('harnessCommand', () => {
  it('garde la forme courte depuis le clone et sur le runtime par défaut', () => {
    assert.equal(harnessCommand('status'), 'npm run harness -- status')
  })

  it('se lance hors du clone par --prefix, sans cd', () => {
    const c = harnessCommand('approve a1', { repoRoot: '/x/Midgaard' })
    assert.equal(c, 'npm --prefix "/x/Midgaard" run harness -- approve a1')
    assert.doesNotMatch(c, /\bcd\b|&&/)
  })

  it('place --home avant la commande, pour qu’un -- ne l’avale pas', () => {
    assert.equal(
      harnessCommand('exec revoke -- npm test', { home: '/x/runtime' }),
      'npm run harness -- --home "/x/runtime" exec revoke -- npm test',
    )
  })

  it('dans l’application autonome, passe par le lanceur embarqué, jamais par npm', () => {
    const launcher = '"/Applications/Midgaard.app/Contents/Resources/runtime/app/bin/harness"'
    // `repoRoot` n'a plus de sens : il n'y a pas de clone, et le lanceur est absolu.
    assert.equal(
      harnessCommand('mcp add rea -- node rea.mjs', { launcher, repoRoot: '/x/Midgaard', home: '/x/runtime' }),
      `${launcher} --home "/x/runtime" mcp add rea -- node rea.mjs`,
    )
    assert.doesNotMatch(harnessCommand('status', { launcher }), /npm/)
    assert.equal(loadConfig({}).launcher, null)
    assert.equal(loadConfig({ MIDGAARD_LAUNCHER: '  ' }).launcher, null, 'une variable vide n’est pas un lanceur')
    assert.equal(loadConfig({ MIDGAARD_LAUNCHER: launcher }).launcher, launcher)
  })

  it('ne double pas les barres obliques inverses d’un chemin Windows', () => {
    assert.equal(
      harnessCommand('approve a1', { repoRoot: 'C:\\Users\\me\\Midgaard' }),
      'npm --prefix "C:\\Users\\me\\Midgaard" run harness -- approve a1',
    )
  })
})

describe('extractHome', () => {
  it('retire --home où qu’il soit avant --, et le rend absolu', () => {
    // `resolve` et non `join` pour l'attendu : sous Windows, un chemin sans
    // lecteur prend celui du dossier courant (`D:\\w\\rt`) — constaté en CI.
    assert.deepEqual(extractHome(['--home', 'rt', 'approve', 'a1'], '/w'), {
      home: resolve('/w', 'rt'),
      rest: ['approve', 'a1'],
    })
    assert.deepEqual(extractHome(['approve', '--home=/abs', 'a1'], '/w'), {
      home: resolve('/abs'),
      rest: ['approve', 'a1'],
    })
  })

  it('ne lit rien après --', () => {
    // `exec allow -- outil --home x` met en liste blanche l'argv exact.
    assert.deepEqual(extractHome(['exec', 'allow', '--', 'outil', '--home', 'x'], '/w'), {
      home: null,
      rest: ['exec', 'allow', '--', 'outil', '--home', 'x'],
    })
  })

  it('refuse un --home sans dossier', () => {
    assert.throws(() => extractHome(['--home'], '/w'), /attend un dossier/)
  })
})

describe('le dossier runtime dans les conseils', () => {
  it('loadConfig dit si le dossier a été désigné', () => {
    assert.equal(loadConfig({}).homeIsExplicit, false)
    assert.equal(loadConfig({ MIDGAARD_HOME: '/x' }).homeIsExplicit, true)
  })

  it('cmd() le redit une fois posé, et seulement alors', () => {
    setAdviceHome('/x/runtime')
    assert.equal(cmd('agents'), 'npm run harness -- --home "/x/runtime" agents')
    setAdviceHome(null)
    assert.equal(cmd('agents'), 'npm run harness -- agents')
  })

  it('une commande conseillée hors du clone le porte', () => {
    // C'était la consigne d'approbation de l'ancienne façade MCP ; la forme
    // reste celle que le daemon donne à ses agents (`harnessCommand`).
    assert.equal(
      harnessCommand('approve a1', { repoRoot: '/x/Midgaard', home: '/x/runtime' }),
      'npm --prefix "/x/Midgaard" run harness -- --home "/x/runtime" approve a1',
    )
    assert.doesNotMatch(harnessCommand('approve a1', { repoRoot: '/x/Midgaard' }), /--home/)
  })
})

describe('port de repli', () => {
  // Leçon n° 33 : un autre daemon tenait 7777, et rien ne le disait.
  it('le signale quand le daemon n’écoute pas sur le port attendu', () => {
    assert.match(portFallbackNote({ port: 7777, portIsExplicit: false }, 54345) ?? '', /7777 occupé.*54345/)
  })

  it('se tait quand le port est le bon, ou qu’il a été imposé', () => {
    assert.equal(portFallbackNote({ port: 7777, portIsExplicit: false }, 7777), null)
    // Imposé par MIDGAARD_PORT, un port pris fait échouer le démarrage : il
    // n'y a pas de repli à expliquer.
    assert.equal(portFallbackNote({ port: 7000, portIsExplicit: true }, 54345), null)
  })
})

describe('--home de bout en bout', () => {
  // Trouvé en vérifiant la leçon n° 33 à la main : `--home x start` lançait un
  // daemon qui ne recevait pas le dossier, retombait sur `~/.midgaard`, y
  // trouvait le verrou d'un autre daemon et sortait. La vraie CLI, sans
  // `MIDGAARD_HOME` dans son environnement : seul `--home` désigne le dossier.
  it('démarre et arrête le daemon du dossier désigné', () => {
    const home = mkdtempSync(join(tmpdir(), 'midgaard-home-flag-'))
    const entry = fileURLToPath(import.meta.resolve('@midgaard/cli/main'))
    const node = entry.endsWith('.ts') ? ['--conditions=midgaard-dev', entry] : [entry]
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MIDGAARD_'))),
      // Port 0 : ne pas disputer 7777 à un daemon de développement.
      MIDGAARD_PORT: '0',
      MIDGAARD_VAULT: 'file',
      NO_COLOR: '1',
    }
    const harness = (...args: string[]) =>
      spawnSync(process.execPath, [...node, ...args], { env, cwd: tmpdir(), encoding: 'utf8', timeout: 30_000 })
    try {
      const started = harness('--home', home, 'start')
      assert.equal(started.status, 0, started.stderr)
      const rt = readRuntime(join(home, 'daemon.json'))
      assert.ok(rt && pidAlive(rt.pid), 'le daemon doit tourner sur le dossier désigné')
      assert.ok(existsSync(join(home, 'harness.db')), 'et y avoir créé sa base')
      const stopped = harness('--home', home, 'stop')
      assert.equal(stopped.status, 0, stopped.stderr)
    } finally {
      const rt = readRuntime(join(home, 'daemon.json'))
      if (rt && pidAlive(rt.pid)) process.kill(rt.pid)
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
