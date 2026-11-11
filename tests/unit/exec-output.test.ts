/**
 * @file La sortie d'`exec` en direct (Slice 6, étape 4) : le préparateur seul,
 * puis une vraie commande lancée par un Developer dans un vrai daemon.
 *
 * Ce qui compte, et pourquoi :
 *  - **une clé coupée entre deux morceaux est quand même expurgée** : c'est la
 *    raison de découper par ligne avant d'expurger, et le défaut le plus
 *    probable d'une sortie en direct. Prouvé deux fois : avec des morceaux
 *    choisis, puis avec une vraie commande qui écrit la clé en deux fois, à
 *    300 ms d'écart, lue en base octet pour octet ;
 *  - un caractère UTF-8 coupé entre deux morceaux reste un caractère ;
 *  - la sortie est livrée **pendant** la commande, pas à la fin : la première
 *    ligne est en base une seconde avant que la commande ne rende la main ;
 *  - le plafond se **dit**, avec ce qui manque.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createRedactor, loadConfig } from '@midgaard/contracts'
import { MAX_HELD_LINE, OutputBatcher, type OutputBatch } from '@midgaard/agent-runtime'
import { reconcileAgents, startDaemon, type Daemon } from '@midgaard/daemon'
import { startFakeProvider, type FakeProvider } from '../fake-provider.ts'

/** Un préparateur à minuterie manuelle : rien n'est livré tant que le test ne le décide pas. */
function batcher(options: { secrets?: string[]; maxBytes?: number } = {}) {
  const batches: OutputBatch[] = []
  let pending: (() => void) | null = null
  const b = new OutputBatcher({
    redact: createRedactor(options.secrets ?? []),
    emit: (batch) => void batches.push(batch),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    schedule: (fn) => {
      pending = fn
      return { cancel: () => void (pending = null) }
    },
  })
  const tick = () => {
    const fn = pending
    pending = null
    fn?.()
  }
  return { b, batches, tick, armed: () => pending !== null }
}

const buf = (s: string) => Buffer.from(s, 'utf8')

describe('préparation de la sortie', () => {
  it('expurge une clé coupée entre deux morceaux', () => {
    const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
    const { b, batches, tick } = batcher({ secrets: [key] })
    b.write('stdout', buf(`clé ${key.slice(0, 14)}`))
    tick()
    assert.equal(batches.length, 0, 'une ligne incomplète attend la suite')
    b.write('stdout', buf(`${key.slice(14)}\n`))
    tick()
    assert.equal(batches.length, 1)
    assert.doesNotMatch(batches[0]!.text, /abcdefghijklmnop/)
    assert.match(batches[0]!.text, /^clé /)
  })

  it('garde entier un caractère UTF-8 coupé entre deux morceaux', () => {
    const { b, batches, tick } = batcher()
    const bytes = buf('déjà\n')
    b.write('stdout', bytes.subarray(0, 2)) // « d » et le premier octet de « é »
    b.write('stdout', bytes.subarray(2))
    tick()
    assert.equal(batches[0]!.text, 'déjà\n')
  })

  it('livre un lot par flux et par intervalle, pas un événement par ligne', () => {
    const { b, batches, tick, armed } = batcher()
    for (let i = 0; i < 50; i++) b.write('stdout', buf(`ligne ${i}\n`))
    b.write('stderr', buf('attention\n'))
    assert.equal(armed(), true)
    tick()
    assert.deepEqual(batches.map((x) => x.stream), ['stdout', 'stderr'])
    assert.equal(batches[0]!.text.split('\n').length - 1, 50)
    assert.equal(armed(), false, 'rien à livrer, rien de programmé')
  })

  it('livre la dernière ligne à la fermeture, même sans retour à la ligne', () => {
    const { b, batches } = batcher()
    b.write('stdout', buf('fin sans retour'))
    b.close()
    assert.deepEqual(batches, [{ stream: 'stdout', text: 'fin sans retour' }])
    b.write('stdout', buf('après la fin\n'))
    b.close()
    assert.equal(batches.length, 1, 'rien après la fermeture, et fermer deux fois ne relivre rien')
  })

  it('livre par tranches une ligne qui n\'en finit pas', () => {
    const { b, batches, tick } = batcher()
    b.write('stdout', buf('x'.repeat(MAX_HELD_LINE + 10)))
    tick()
    assert.equal(batches[0]!.text.length, MAX_HELD_LINE, 'sans quoi une barre de progression ne s\'afficherait jamais')
    b.close()
    assert.equal(batches[1]!.text.length, 10)
  })

  it('dit ce qu\'il n\'écrit pas au-delà du plafond', () => {
    const { b, batches } = batcher({ maxBytes: 20 })
    b.write('stdout', buf('0123456789\n')) // 11 octets : écrits
    b.write('stdout', buf('0123456789\n')) // 22 au total : omis
    b.write('stderr', buf('abc\n')) // 15 : écrits
    b.close()
    const last = batches.at(-1)!
    assert.equal(last.omitted_bytes, 11)
    assert.match(last.text, /11 octets de sortie non affichés/)
    assert.equal(batches.filter((x) => !x.omitted_bytes).map((x) => x.text).join(''), '0123456789\nabc\n')
  })
})

describe('une vraie commande, dans un vrai daemon', () => {
  const key = 'sk-faux-exec-direct-0123456789abcdef'
  let home: string
  let repo: string
  let daemon: Daemon
  let provider: FakeProvider

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'midgaard-exec-out-'))
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-exec-out-depot-')))
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@example.org', '-c', 'commit.gpgsign=false', ...a], {
        cwd: repo,
        stdio: 'ignore',
      })
    git('init', '-q', '-b', 'main')
    // Une ligne tout de suite, puis la clé en deux écritures à 300 ms d'écart :
    // deux morceaux sur le tube, que seule la découpe par ligne réunit.
    writeFileSync(
      join(repo, 'parle.js'),
      [
        `process.stdout.write('première ligne\\n')`,
        `setTimeout(() => {`,
        `  process.stdout.write('clé ${key.slice(0, 16)}')`,
        `  setTimeout(() => { process.stdout.write('${key.slice(16)}\\n'); process.stderr.write('fini\\n') }, 300)`,
        `}, 900)`,
      ].join('\n'),
    )
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
    provider = await startFakeProvider()
    // `node parle.js` en liste blanche : la commande tourne sans attendre d'humain.
    const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0', MIDGAARD_EXEC_ALLOW: 'node parle.js' })
    daemon = (await startDaemon(config, {
      log: () => {},
      env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: key },
    }))!
    daemon.store.upsertProvider({
      id: 'faux', name: 'faux', kind: 'openai-compatible', preset: 'custom', baseUrl: provider.url,
      defaultModel: 'faux-1', secretRef: null, webSearch: 'off',
    })
    reconcileAgents(daemon.store)
  })

  after(async () => {
    daemon.close('fin des tests')
    await daemon.stopped
    provider.server.close()
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('écrit la sortie pendant la commande, expurgée, rattachée à son appel', async () => {
    provider.scripts.set('[parle]', [
      [{ tool: 'exec', args: { command: 'node', args: ['parle.js'] } }],
      [{ tool: 'submit_result', args: { summary: 'commande lancée' } }],
    ])
    const created = daemon.tasks.create({
      objective: '[parle] lance la commande', agentId: 'developer', context: null, projectDir: repo,
      durationS: 20, needsApproval: false,
    })
    assert.ok(!('error' in created), JSON.stringify(created))
    const done = await daemon.tasks.wait(created.task.id, 20_000, 0)
    assert.equal(done?.task.status, 'completed', done?.task.error ?? '')

    const events = daemon.store.taskEvents(created.task.id)
    const outputs = events.filter((e) => e.type === 'exec.output')
    const completed = events.find((e) => e.type === 'tool.completed' && e.payload.tool_call_id === outputs[0]?.payload.tool_call_id)
    const call = daemon.store.toolCalls(created.task.id).find((c) => c.name === 'exec')
    assert.ok(call && completed, 'sortie et fin de la même commande')
    assert.ok(outputs.every((e) => e.payload.tool_call_id === call.id), 'chaque lot est rattaché à son appel')

    const all = outputs.map((e) => String(e.payload.text)).join('')
    assert.match(all, /première ligne\n/)
    assert.match(all, /fini\n/)
    // Livrée en direct : la première ligne est écrite bien avant la fin.
    const first = outputs.find((e) => String(e.payload.text).includes('première ligne'))!
    assert.ok(first.seq < completed.seq)
    assert.ok(Date.parse(completed.at) - Date.parse(first.at) >= 800, `${first.at} → ${completed.at}`)
    // Ni la clé, ni sa première moitié, nulle part dans le journal.
    const journal = JSON.stringify(events)
    assert.ok(!journal.includes(key), 'clé entière')
    assert.ok(!journal.includes(key.slice(0, 16)), 'moitié de clé : la ligne a été réunie avant l\'expurgation')
    assert.match(all, /clé /)
  })
})
