/**
 * @file Le profil Navigator dans un vrai daemon (Slice 7, étape 5), face au
 * faux fournisseur et à un vrai Chromium.
 *
 * Ce qui est prouvé, de bout en bout, et que les tests des outils ne
 * prouvaient pas :
 *
 *  - **un Navigator aveugle est refusé avec son motif**, avant que la tâche
 *    existe : montré désactivé par `GET /api/agents`, refusé par la création,
 *    jusqu'à ce que la capacité soit déclarée ;
 *  - **le moteur pose le navigateur** : la session passe par l'approbation
 *    humaine (`POST /api/approvals/:id/approve`), la saisie aussi ;
 *  - **la coupure humaine** (`POST /api/tasks/:id/browser/close`) ferme la
 *    session pendant qu'une saisie attend son approbation : approuvée ensuite,
 *    elle n'est pas tapée, et l'agent apprend pourquoi ;
 *  - **une tâche qui finit ferme son navigateur avant de conclure** : le
 *    journal raconte la fermeture puis la fin ;
 *  - **aucun Chromium ne survit** (descendants du processus comptés au
 *    système, vus vivants pendant la session pour prouver que le compte voit
 *    quelque chose), et **aucune capture en base** (base et WAL lus octet pour
 *    octet, à la recherche de l'en-tête JPEG en base64).
 *
 * Sans Chromium installé, la partie navigateur **saute en le disant** ; le
 * compte des processus saute sous Windows, en le disant aussi.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, it } from 'node:test'
import { chromium } from 'playwright'
import { daemonFetch, daemonJson, loadConfig, readRuntime, type Agent, type RuntimeInfo, type Task } from '@midgaard/contracts'
import { NAVIGATOR_AGENT_ID, reconcileAgents, startDaemon, type Daemon } from '@midgaard/daemon'
import { assertPublicHost } from '@midgaard/tools'
import type { HostGuard } from '@midgaard/browser'
import { startFakeProvider, type FakeProvider } from '../fake-provider.ts'

const installed = existsSync(chromium.executablePath())
const skipBrowser = !installed && 'Chromium absent : npx playwright install chromium'
const posix = process.platform !== 'win32'

/** La page de test est « l'internet public » ; le reste passe par la vraie garde. */
const testGuard: HostGuard = async (host) => (host === '127.0.0.1' ? ['127.0.0.1'] : assertPublicHost(host))

/**
 * Les processus Chromium descendants de ce processus, comptés au système :
 * Playwright lance Chromium comme enfant du processus qui tient la session,
 * ici le daemon, qui tourne dans le test.
 */
function chromiumDescendants(): number {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }))
  const mine = new Set([process.pid])
  let grew = true
  while (grew) {
    grew = false
    for (const r of rows) {
      if (!mine.has(r.pid) && mine.has(r.ppid)) {
        mine.add(r.pid)
        grew = true
      }
    }
  }
  return rows.filter((r) => r.pid !== process.pid && mine.has(r.pid) && /chrom/i.test(r.command)).length
}

describe('le Navigator dans un vrai daemon', () => {
  let home: string
  let repo: string
  let daemon: Daemon
  let provider: FakeProvider
  let rt: RuntimeInfo
  let page: Server
  let origin = ''

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'midgaard-navigator-'))
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-navigator-depot-')))
    provider = await startFakeProvider()
    page = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Formulaire</title><input id="q" name="q" autofocus>')
    })
    await new Promise<void>((r) => page.listen(0, '127.0.0.1', r))
    const address = page.address()
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`
    const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
    daemon = (await startDaemon(config, {
      log: () => {},
      env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-navigateur' },
      browserGuard: testGuard,
    }))!
    rt = readRuntime(config.runtimeFile)!
    // Un fournisseur `custom` : il ne publie pas la capacité de ses modèles.
    daemon.store.upsertProvider({
      id: 'faux', name: 'faux', kind: 'openai-compatible', preset: 'custom', baseUrl: provider.url,
      defaultModel: 'faux-1', secretRef: null, webSearch: 'off',
    })
    reconcileAgents(daemon.store)
    await daemon.tasks.probeVision()
  })

  after(async () => {
    daemon.close('fin des tests')
    await daemon.stopped
    provider.server.close()
    page.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  const api = <T>(path: string, init?: RequestInit) => daemonJson<T>(rt, path, init)
  const post = <T>(path: string, body: unknown = {}) =>
    api<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  /** Crée une tâche Navigator par l'API, comme le dashboard. */
  const navigate = (objective: string) =>
    post<{ task?: Task; error?: string; reason?: string }>('/api/tasks', {
      agent_id: NAVIGATOR_AGENT_ID, objective, project_dir: repo,
    })

  /** Attend la demande d'approbation suivante d'une tâche, et la rend. */
  async function nextApproval(taskId: string, known: Set<string>) {
    for (let i = 0; i < 200; i++) {
      const pending = daemon.store.pendingApprovals().find((a) => a.task_id === taskId && !known.has(a.id))
      if (pending) {
        known.add(pending.id)
        return pending
      }
      await sleep(50)
    }
    throw new Error(`aucune approbation pour ${taskId} : ${daemon.store.getTask(taskId)?.status}`)
  }

  it('un Navigator dont rien ne dit que le modèle lit les images est refusé avec son motif, puis accepté une fois déclaré', async () => {
    const listed = await api<{ agents: Agent[] }>('/api/agents')
    const navigator = listed.body.agents.find((a) => a.id === NAVIGATOR_AGENT_ID)!
    assert.equal(navigator.kind, 'navigator')
    assert.equal(navigator.enabled, false, 'montré désactivé, même si sa ligne en base est active')
    assert.match(navigator.disabled_reason ?? '', /rien ne dit que le modèle « faux-1 » lit les images/)
    assert.ok(navigator.tools.includes('browser_open') && !navigator.tools.includes('exec') && !navigator.tools.includes('http_fetch'))

    const before = daemon.store.countTasks()
    const refused = await navigate('[aveugle] regarde la page')
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error, 'agent_disabled')
    assert.match(refused.body.reason ?? '', /rien ne dit/)
    assert.deepEqual(daemon.store.countTasks(), before, 'aucune tâche créée')

    const declared = await api<{ agent: Agent }>(`/api/agents/${NAVIGATOR_AGENT_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vision: true }),
    })
    assert.equal(declared.status, 200)
    assert.equal(declared.body.agent.enabled, true, 'la réponse au réglage montre déjà le profil utilisable')
    assert.equal(declared.body.agent.disabled_reason, null)
  })

  it('session et saisie approuvées ; la coupure humaine empêche une saisie approuvée ensuite ; rien ne survit', { skip: skipBrowser }, async () => {
    const tag = '[coupure]'
    provider.scripts.set(tag, [
      [{ tool: 'browser_open', args: { objective: 'remplir le champ', url: origin, max_duration_s: 120 } }],
      [{ tool: 'browser_type', args: { text: 'bonjour' } }],
      [{ tool: 'submit_result', args: { summary: 'session coupée par l\'humain' } }],
    ])
    const created = await navigate(`${tag} remplis le champ`)
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const taskId = (created.body as unknown as { task: Task }).task.id
    const known = new Set<string>()

    const session = await nextApproval(taskId, known)
    assert.match(session.operation, /^browser_open — ouvrir un navigateur isolé sur http:\/\/127\.0\.0\.1:\d+\/, 2 min au plus — objectif : remplir le champ — clics libres pendant la session, envoi de formulaire compris ; tout autre texte, et Entrée seule, approuvés chacun$/)
    assert.equal((await post(`/api/approvals/${session.id}/approve`, { by: 'test' })).status, 200)

    const typing = await nextApproval(taskId, known)
    assert.match(typing.operation, /^browser_type — saisir "bonjour" dans input#q\[name="q"\] de http:\/\/127\.0\.0\.1/)
    const open = await api<{ session: { objective: string; start_url: string } | null; frame: { title: string } | null }>(
      `/api/tasks/${taskId}/browser`,
    )
    assert.equal(open.body.session?.objective, 'remplir le champ')
    assert.equal(open.body.frame?.title, 'Formulaire', 'ce que montre la dernière capture, sans elle')
    // La capture, depuis la mémoire du daemon, servie sans pouvoir devenir une page.
    const frame = await daemonFetch(rt, `/api/tasks/${taskId}/browser/frame`)
    assert.equal(frame.status, 200)
    assert.equal(frame.headers.get('content-type'), 'image/jpeg')
    assert.equal(frame.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(Buffer.from(await frame.arrayBuffer()).subarray(0, 3).toString('hex'), 'ffd8ff')
    if (posix) assert.ok(chromiumDescendants() > 0, 'Chromium vit pendant la session : le compte voit quelque chose')

    // L'humain coupe pendant que la saisie attend sa décision…
    assert.equal((await post(`/api/tasks/${taskId}/browser/close`)).status, 200)
    assert.equal((await post(`/api/tasks/${taskId}/browser/close`)).status, 409, 'plus rien à couper')
    assert.equal((await daemonFetch(rt, `/api/tasks/${taskId}/browser/frame`)).status, 404, 'session coupée : plus de capture')
    // … puis l'approuve par erreur : elle ne doit pas partir.
    assert.equal((await post(`/api/approvals/${typing.id}/approve`, { by: 'test' })).status, 200)

    const done = (await daemon.tasks.wait(taskId, 15_000, known.size))!.task
    assert.equal(done.status, 'completed', done.error ?? '')
    assert.equal(done.result?.untrusted, true, 'la tâche a vu une page web')
    const typed = daemon.store.toolCalls(taskId).find((c) => c.name === 'browser_type')
    assert.equal(typed?.status, 'failed')
    assert.match(typed?.error ?? '', /cut by the human operator/)
    const conversation = JSON.stringify(provider.received.get(tag) ?? [])
    assert.match(conversation, /the browser session is closed \(cut by the human operator\)/, 'l\'agent a appris pourquoi')

    const browserEvents = daemon.store.taskEvents(taskId).filter((e) => e.type.startsWith('browser.'))
    assert.deepEqual(browserEvents.map((e) => [e.type, e.payload.reason ?? null]), [
      ['browser.opened', null], ['browser.closed', 'cut by the human operator'],
    ])
    if (posix) assert.equal(chromiumDescendants(), 0, 'aucun Chromium ne survit à la coupure')
  })

  it('une tâche qui finit ferme son navigateur avant de conclure, et aucune capture n\'est en base', { skip: skipBrowser }, async () => {
    const tag = '[fin]'
    provider.scripts.set(tag, [
      [{ tool: 'browser_open', args: { objective: 'regarder', url: origin } }],
      [{ tool: 'browser_screenshot', args: {} }],
      [{ tool: 'submit_result', args: { summary: 'vu, sans fermer' } }],
    ])
    const created = await navigate(`${tag} regarde la page`)
    const taskId = (created.body as unknown as { task: Task }).task.id
    const known = new Set<string>()
    await post(`/api/approvals/${(await nextApproval(taskId, known)).id}/approve`, { by: 'test' })
    const done = (await daemon.tasks.wait(taskId, 15_000, known.size))!.task
    assert.equal(done.status, 'completed', done.error ?? '')

    const events = daemon.store.taskEvents(taskId)
    const closed = events.find((e) => e.type === 'browser.closed')
    const completed = events.find((e) => e.type === 'task.completed')
    assert.equal(closed?.payload.reason, 'the task ended')
    assert.ok(closed!.task_seq < completed!.task_seq, 'la session est close avant la fin de la tâche')
    if (posix) assert.equal(chromiumDescendants(), 0, 'aucun Chromium ne survit à la tâche')

    // Les captures sont arrivées au modèle…
    const conversation = JSON.stringify(provider.received.get(tag) ?? [])
    assert.ok(conversation.includes('data:image/jpeg;base64,/9j/'), 'une capture JPEG est arrivée au modèle')
    // … et rien d'elles n'est en base : l'en-tête JPEG en base64 n'y figure pas.
    const db = loadConfig({ MIDGAARD_HOME: home }).dbPath
    for (const file of [db, `${db}-wal`]) {
      if (!existsSync(file)) continue
      assert.ok(!readFileSync(file).includes(Buffer.from('/9j/')), `aucune capture dans ${file}`)
    }
  })
})

describe('un daemon fermé en pleine tâche', () => {
  it('ne tue pas le processus qui l\'héberge : la tâche finit après la base, sans erreur non rattrapée', async () => {
    // Constaté en CI sous Windows (Slice 7, étape 6) : le test fermait son
    // daemon pendant qu'une tâche attendait une approbation, la boucle finissait
    // après la fermeture de la base, et « database is not open » tuait le
    // processus. On compte ici les rejets non rattrapés pendant la fermeture.
    const home = mkdtempSync(join(tmpdir(), 'midgaard-arret-'))
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-arret-depot-')))
    const provider = await startFakeProvider()
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => void unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
      const daemon = (await startDaemon(config, {
        log: () => {},
        env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-arret' },
      }))!
      daemon.store.upsertProvider({
        id: 'faux', name: 'faux', kind: 'openai-compatible', preset: 'custom', baseUrl: provider.url,
        defaultModel: 'faux-1', secretRef: null, webSearch: 'off',
      })
      reconcileAgents(daemon.store)
      daemon.store.setAgentModel(NAVIGATOR_AGENT_ID, 'faux', null, true)
      provider.scripts.set('[arret]', [
        [{ tool: 'browser_open', args: { objective: 'o', url: 'https://example.org/' } }],
      ])
      const created = daemon.tasks.create({
        objective: '[arret] attends', agentId: NAVIGATOR_AGENT_ID, context: null, projectDir: repo,
        durationS: 20, needsApproval: false,
      })
      assert.ok(!('error' in created), JSON.stringify(created))
      for (let i = 0; i < 100 && daemon.store.getTask(created.task.id)?.status !== 'waiting_approval'; i++) await sleep(50)
      assert.equal(daemon.store.getTask(created.task.id)?.status, 'waiting_approval')

      daemon.close('fermé en pleine tâche')
      await daemon.stopped
      // Laisse la boucle interrompue finir, après la base.
      await sleep(500)
      assert.deepEqual(unhandled.map((e) => String(e)), [], 'aucun rejet non rattrapé')
    } finally {
      process.off('unhandledRejection', onUnhandled)
      provider.server.close()
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
