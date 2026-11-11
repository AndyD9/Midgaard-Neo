/**
 * @file `@midgaard/mcp-client` (Slice 8, étape 1) : un serveur MCP stdio
 * lancé, interrogé, borné, annulé — et dont **aucun processus ne survit**.
 *
 * Le serveur est `tests/fake-mcp-server.ts`, un vrai serveur du SDK sur un
 * vrai tube, dont seul le comportement est scripté. L'invariant de processus
 * se vérifie en **interrogeant les pid au système**, comme pour `exec` : un
 * invariant de processus se teste en comptant les processus (Slice 1).
 *
 * Le cas du daemon tué net reprend la leçon de la Slice 7 : un serveur stdio
 * quitte souvent seul quand son entrée se ferme, comme Chromium à la mort de
 * son parent. Un test qui ne regarderait que lui passerait sans la garde. On
 * regarde donc aussi un **petit-enfant qui ne lit rien** — il ne meurt que
 * d'un signal au groupe —, et, sous POSIX, on **fige** le serveur
 * (`SIGSTOP`) avant de tuer son lanceur.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { McpClientError, McpConnection, STDERR_TAIL_BYTES, serverEnv, type StdioServerSpec } from '@midgaard/mcp-client'

const FAKE_SERVER = fileURLToPath(new URL('../fake-mcp-server.ts', import.meta.url))

let marks: string
const open: McpConnection[] = []

beforeEach(() => {
  marks = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-mcp-')))
})
afterEach(async () => {
  // Un test qui échoue ne doit pas laisser de serveur derrière lui.
  for (const c of open.splice(0)) await c.close()
  rmSync(marks, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

/** Le faux serveur, dans un mode donné, avec l'environnement que le daemon lui construirait. */
function spec(mode?: string, declared: Record<string, string> = {}): StdioServerSpec {
  return {
    command: process.execPath,
    args: mode ? [FAKE_SERVER, mode] : [FAKE_SERVER],
    env: serverEnv(process.env, { FAKE_MCP_MARKS: marks, ...declared }),
    cwd: marks,
  }
}

/** Ouvre une connexion, retenue pour être fermée même si le test échoue. */
async function connect(mode?: string, declared?: Record<string, string>): Promise<McpConnection> {
  const c = await McpConnection.open(spec(mode, declared))
  open.push(c)
  return c
}

/** Le texte du premier contenu d'un résultat. */
function text(result: { content: unknown }): string {
  const first = (result.content as { type: string; text?: string }[])[0]
  return first?.text ?? ''
}

/** Vrai si le processus existe encore. `kill(pid, 0)` ne tue rien : il demande. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Attend qu'un processus disparaisse — `SIGKILL` est asynchrone — sans dépasser `ms`. */
async function gone(pid: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !alive(pid)
}

/** Tue un processus resté en vie, pour qu'un test qui échoue ne pollue pas les suivants. */
function cleanup(...pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

/** Attend qu'une promesse rejette par une {@link McpClientError} de la raison donnée. */
async function rejectsWith(p: Promise<unknown>, reason: McpClientError['reason'], message?: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof McpClientError, `McpClientError attendue, reçu ${String(e)}`)
    assert.equal(e.reason, reason, e.message)
    if (message) assert.match(e.message, message)
    return true
  })
}

describe('connexion', () => {
  it('fait la poignée de main, lit le catalogue et appelle un outil', async () => {
    const c = await connect()
    assert.equal(c.serverInfo?.name, 'fake-mcp')
    assert.equal(c.instructions, 'Fake server for tests.')
    const tools = await c.listTools()
    const names = tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['echo', 'env', 'exit', 'fail', 'slow', 'spawn_sleeper', 'stderr'])
    // Les annotations arrivent telles que le serveur les annonce : l'humain
    // les verra pour cocher, sans qu'elles décident seules (décision 5).
    assert.equal(tools.find((t) => t.name === 'echo')?.annotations?.readOnlyHint, true)
    assert.equal(text(await c.callTool('echo', { text: 'bonjour' }, { timeoutMs: 5_000 })), 'bonjour')
  })

  it('rend un outil en échec comme un résultat, pas comme une exception', async () => {
    const c = await connect()
    const r = await c.callTool('fail', {}, { timeoutMs: 5_000 })
    assert.equal(r.isError, true)
    assert.equal(text(r), 'it went wrong')
  })

  it('refuse un programme désigné par un chemin relatif, sans rien lancer', async () => {
    await rejectsWith(McpConnection.open({ ...spec(), command: 'node' }), 'start', /absolute path/)
  })

  it('dit qu\'un programme absent ne se lance pas', async () => {
    await rejectsWith(McpConnection.open({ ...spec(), command: join(marks, 'absent') }), 'start', /ENOENT/)
  })

  it('arrête un programme qui ne répond pas au protocole', async () => {
    // Un binaire qui existe mais n'est pas un serveur MCP : « Tester la
    // connexion » doit le dire, pas le croire joignable (leçon de la Slice 2).
    const started = Date.now()
    let failure: unknown
    const attempt = McpConnection.open({ ...spec('--hang') }, { startupTimeoutMs: 500 }).catch((e) => {
      failure = e
    })
    await attempt
    assert.ok(failure instanceof McpClientError && failure.reason === 'start', String(failure))
    assert.match((failure as Error).message, /did not complete the MCP handshake/)
    assert.ok(Date.now() - started < 8_000, 'le démarrage raté doit s\'arrêter, grâce comprise')
  })
})

describe('environnement', () => {
  it('ne transmet pas les secrets du daemon, mais ce que l\'humain a déclaré', async () => {
    const env = serverEnv(
      { PATH: '/bin', HOME: '/home/u', VENICE_API_KEY: 'sk-secret', MIDGAARD_TOKEN: 'jeton', NODE_OPTIONS: '--require x' },
      { REA_MCP_INPUT_SCHEMA_PROFILE: 'compact', PATH: '/opt/bin' },
    )
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'NO_COLOR', 'PATH', 'REA_MCP_INPUT_SCHEMA_PROFILE'])
    assert.equal(env.PATH, '/opt/bin', 'la déclaration l\'emporte')
  })

  it('lance le serveur avec exactement cet environnement', async () => {
    // Le daemon peut porter une clé dans son environnement ; le serveur ne
    // doit pas la recevoir. On la pose dans la source, pas dans process.env.
    const c = await McpConnection.open({
      ...spec(),
      env: serverEnv({ ...process.env, VENICE_API_KEY: 'sk-secret' }, { FAKE_MCP_MARKS: marks, DECLAREE: '1' }),
    })
    open.push(c)
    const keys = JSON.parse(text(await c.callTool('env', {}, { timeoutMs: 5_000 }))) as string[]
    assert.ok(keys.includes('DECLAREE'))
    assert.ok(!keys.includes('VENICE_API_KEY'), 'une clé du daemon a atteint le serveur')
  })
})

describe('délais et annulation', () => {
  it('borne un appel par son délai, prévient le serveur, et reste utilisable', async () => {
    const c = await connect()
    await rejectsWith(c.callTool('slow', { ms: 10_000 }, { timeoutMs: 300 }), 'timeout', /did not answer within/)
    // Le SDK envoie `notifications/cancelled` : le serveur l'a reçue.
    const until = Date.now() + 3_000
    while (!existsSync(join(marks, 'cancelled')) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    assert.ok(existsSync(join(marks, 'cancelled')), 'le serveur n\'a pas été prévenu')
    assert.equal(text(await c.callTool('echo', { text: 'encore' }, { timeoutMs: 5_000 })), 'encore')
  })

  it('annule un appel au signal de la tâche', async () => {
    const c = await connect()
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 200)
    await rejectsWith(c.callTool('slow', { ms: 10_000 }, { timeoutMs: 30_000, signal: abort.signal }), 'cancelled')
    const until = Date.now() + 3_000
    while (!existsSync(join(marks, 'cancelled')) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    assert.ok(existsSync(join(marks, 'cancelled')), 'le serveur n\'a pas été prévenu')
  })

  it('transmet la progression sans prolonger le délai', async () => {
    const c = await connect()
    const seen: number[] = []
    // La progression arrive toutes les 50 ms ; le délai de 400 ms tient quand même.
    await rejectsWith(
      c.callTool('slow', { ms: 10_000 }, { timeoutMs: 400, onProgress: (p) => seen.push(p.progress) }),
      'timeout',
    )
    assert.ok(seen.length >= 2, `progression reçue : ${seen.length}`)
  })
})

describe('mort du serveur', () => {
  it('dit qu\'un serveur est sorti en cours d\'appel, et refuse la suite', async () => {
    const c = await connect()
    await rejectsWith(c.callTool('exit', { code: 3 }, { timeoutMs: 5_000 }), 'exited', /exited with code 3/)
    assert.equal(c.isClosed, true)
    await rejectsWith(c.callTool('echo', { text: 'x' }, { timeoutMs: 5_000 }), 'exited')
  })

  it('garde la fin de la sortie d\'erreur, bornée, hors de toute sortie du daemon', async () => {
    const c = await connect()
    await c.callTool('stderr', { text: 'x'.repeat(20_000) + 'FIN' }, { timeoutMs: 5_000 })
    const until = Date.now() + 2_000
    while (!c.stderrTail().endsWith('FIN') && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
    const tail = c.stderrTail()
    assert.ok(tail.endsWith('FIN'))
    assert.ok(Buffer.byteLength(tail) <= STDERR_TAIL_BYTES)
  })
})

describe('aucun processus ne survit', () => {
  it('tue le serveur et ce qu\'il a lancé à la fermeture', async () => {
    const c = await connect()
    const server = c.pid!
    const child = Number(text(await c.callTool('spawn_sleeper', {}, { timeoutMs: 5_000 })))
    assert.ok(alive(server) && alive(child))
    await c.close()
    try {
      assert.equal(await gone(server), true, `le serveur ${server} a survécu`)
      assert.equal(await gone(child), true, `le petit-enfant ${child} a survécu`)
    } finally {
      cleanup(server, child)
    }
  })

  it('va jusqu\'à SIGKILL pour un serveur qui ignore la fin de son entrée et SIGTERM', async () => {
    const c = await connect('--stubborn')
    const server = c.pid!
    const started = Date.now()
    await c.close()
    try {
      assert.equal(await gone(server), true, `le serveur ${server} a survécu`)
      // Deux grâces de 2 s, puis le SIGKILL : la fermeture ne traîne pas au-delà.
      assert.ok(Date.now() - started < 8_000, `fermeture en ${Date.now() - started} ms`)
    } finally {
      cleanup(server)
    }
  })

  it('tue le serveur et ce qu\'il a lancé quand le daemon meurt net', async () => {
    // Le « daemon » est un processus Node qui ouvre la connexion, fait lancer
    // un petit-enfant au serveur, écrit les deux pid, puis est tué. Il n'est
    // tué qu'une fois le groupe **inscrit** à la garde, ce qui est fait avant
    // même la poignée de main (voir le test d'`exec` du même sujet).
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-mcp-garde-')))
    const pidsFile = join(dir, 'pids')
    const entry = fileURLToPath(import.meta.resolve('@midgaard/mcp-client'))
    const parentScript =
      `import { McpConnection, serverEnv } from ${JSON.stringify(pathToFileURL(entry).href)};` +
      `import { writeFileSync } from 'node:fs';` +
      `const c = await McpConnection.open({ command: process.execPath, args: [${JSON.stringify(FAKE_SERVER)}],` +
      ` env: serverEnv(process.env), cwd: ${JSON.stringify(dir)} });` +
      `const r = await c.callTool('spawn_sleeper', {}, { timeoutMs: 10000 });` +
      `writeFileSync(${JSON.stringify(pidsFile)}, c.pid + ' ' + r.content[0].text);` +
      `setInterval(() => {}, 1000)`
    const parent = spawn(
      process.execPath,
      [...(entry.endsWith('.ts') ? ['--conditions=midgaard-dev'] : []), '--input-type=module', '-e', parentScript],
      { stdio: 'ignore' },
    )
    let server = 0
    let child = 0
    try {
      const deadline = Date.now() + 15_000
      while (!existsSync(pidsFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      assert.ok(existsSync(pidsFile), 'le lanceur n\'a pas ouvert la connexion')
      ;[server, child] = readFileSync(pidsFile, 'utf8').split(' ').map(Number) as [number, number]
      // Figé, le serveur ne peut pas quitter de lui-même à la fermeture de
      // son entrée : s'il meurt, c'est la garde. Pas de SIGSTOP sous Windows ;
      // le petit-enfant, qui ne lit rien, y prouve la garde à lui seul.
      if (process.platform !== 'win32') process.kill(server, 'SIGSTOP')
      parent.kill('SIGKILL')
      await once(parent, 'exit')
      // Grâce de la garde (2 s) plus une marge.
      assert.equal(await gone(child, 6_000), true, `le petit-enfant ${child} a survécu à son daemon`)
      assert.equal(await gone(server, 6_000), true, `le serveur ${server} a survécu à son daemon`)
    } finally {
      cleanup(server, child)
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
})
