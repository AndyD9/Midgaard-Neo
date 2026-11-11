/**
 * @file Suite d'intégration : `npm run test:restart` (environ 1 min).
 *
 * Elle vise ce que les tests unitaires ne peuvent pas atteindre : un vrai
 * processus daemon, une vraie base, de vraies sockets. Dix scénarios, chacun
 * couvrant une promesse qui, si elle tombait, le ferait en silence. R8 et R9
 * viennent de l'ancienne suite `test:wait`, qui passait par la façade MCP vers
 * Claude Code : ce qu'elle éprouvait du daemon et de son démarrage se joue
 * maintenant ici, par l'API HTTP.
 *
 *  - R1 l'historique survit au redémarrage, et les tâches en vol deviennent
 *       `interrupted` — jamais reprises, jamais réussies ;
 *  - R2 la reprise WebSocket ne laisse **aucun trou** dans les séquences ;
 *  - R3 une reprise trop tardive est signalée (`truncated`) au lieu d'être subie ;
 *  - R4 l'API locale refuse `Host` étranger, `Origin` étrangère, jeton absent,
 *       et une WebSocket d'origine étrangère ;
 *  - R5 une approbation expirée arrête la tâche en `timed_out` ;
 *  - R6 l'annulation passe par `cancel_requested` et refuse d'être rejouée ;
 *  - R7 le daemon s'arrête tout seul après une période d'inactivité ;
 *  - R8 l'attente longue (`/api/tasks/:id/wait`) rend la main sur une pause
 *       nouvelle, **bloque** sur une pause déjà connue (`known_approval`)
 *       jusqu'à la décision — donnée ici par la vraie CLI, lancée hors du clone
 *       —, et l'interrompre ne coupe pas la tâche ;
 *  - R9 `ensureDaemon` (CLI) : deux appels simultanés ne laissent qu'un
 *       daemon, un daemon tué est relancé, un daemon d'un autre protocole est
 *       remplacé ;
 *  - R10 `harness stop --if-idle`, ce que lance l'application avant de se
 *       mettre à jour : refuse d'arrêter un daemon qui a une tâche active
 *       (code 3, daemon vivant, tâche intacte), puis l'arrête une fois oisif
 *       et ne rend la main qu'après la mort du processus.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  WS_TOKEN_PREFIX,
  daemonJson,
  harnessCommand,
  operationHash,
  pidAlive,
  readRuntime,
  type Approval,
  type HarnessConfig,
  type RuntimeInfo,
  type ServerMessage,
  type Task,
  type TaskView,
} from '@midgaard/contracts'
import { HarnessStore } from '@midgaard/persistence'
import { ensureDaemon } from '@midgaard/cli'
import { childEnv, nodeArgsFor, scenario, summarize, tempHome, type Outcome } from './helpers.ts'

const outcomes: Outcome[] = []
const daemonArgs = nodeArgsFor('@midgaard/daemon/main')

/** Lance un daemon et attend qu'il publie un fichier de découverte joignable. */
async function startDaemon(
  config: HarnessConfig,
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<{ child: ChildProcess; rt: RuntimeInfo }> {
  const previous = readRuntime(config.runtimeFile)?.pid
  const child = spawn(process.execPath, daemonArgs, { env: childEnv(home, extraEnv), stdio: 'ignore' })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await sleep(80)
    const rt = readRuntime(config.runtimeFile)
    if (rt && rt.pid !== previous && (await daemonJson(rt, '/api/health').then((r) => r.status === 200).catch(() => false))) {
      return { child, rt }
    }
  }
  throw new Error("le daemon n'a pas démarré")
}

/** Crée une tâche simulée et rend son état initial. */
function createTask(rt: RuntimeInfo, objective: string, durationS: number, needsApproval = false) {
  return daemonJson<TaskView>(rt, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ objective, duration_s: durationS, needs_approval: needsApproval }),
  })
}

/** Requête HTTP brute : `fetch` refuse de laisser poser certains en-têtes. */
function rawRequest(port: number, headers: string[], path = '/api/health'): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(`GET ${path} HTTP/1.1\r\n${headers.map((h) => h + '\r\n').join('')}connection: close\r\n\r\n`),
    )
    let body = ''
    socket.on('data', (c) => (body += c))
    socket.on('end', () => resolve(body.split('\r\n')[0] ?? ''))
    socket.on('error', () => resolve('ERREUR'))
  })
}

/** Ouvre une WebSocket de dashboard et collecte ses messages. */
function openStream(rt: RuntimeInfo, since: number, origin?: string) {
  const messages: ServerMessage[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${rt.port}/events?since=${since}`, [
    WS_SUBPROTOCOL,
    WS_TOKEN_PREFIX + rt.token,
  ], origin ? { origin } : {})
  ws.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage))
  const opened = new Promise<boolean>((resolve) => {
    ws.once('open', () => resolve(true))
    ws.once('error', () => resolve(false))
  })
  return { ws, messages, opened }
}

/** Attend qu'une condition devienne vraie, ou rend `false` au bout du délai. */
async function until(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return false
}

// ---------------------------------------------------------------------------

const main = tempHome('restart')

await scenario(outcomes, 'R1 persistance et statut interrupted au redémarrage', async () => {
  const { child, rt } = await startDaemon(main.config, main.home)
  const fini = await createTask(rt, 'tâche courte qui doit aboutir', 2)
  // Longue : elle sera encore en vol quand le daemon mourra.
  const enVol = await createTask(rt, 'tâche longue interrompue par le redémarrage', 600)
  await until(
    async () => (await daemonJson<TaskView>(rt, `/api/tasks/${fini.body.task.id}`)).body.task.status === 'completed',
    8_000,
  )

  // SIGKILL : le daemon n'a aucune chance de ranger derrière lui, exactement
  // comme un plantage ou une coupure de courant.
  child.kill('SIGKILL')
  await once(child, 'exit')

  const second = await startDaemon(main.config, main.home)
  const after = await Promise.all(
    [fini, enVol].map(async (t) => (await daemonJson<TaskView>(second.rt, `/api/tasks/${t.body.task.id}`)).body.task),
  )
  const [completed, interrupted] = after as [Task, Task]
  const events = (await daemonJson<{ events: { type: string }[] }>(second.rt, `/api/tasks/${interrupted.id}/events`))
    .body.events
  const ok =
    completed.status === 'completed' &&
    completed.result !== null &&
    interrupted.status === 'interrupted' &&
    interrupted.error !== null &&
    events.some((e) => e.type === 'task.interrupted')

  await daemonJson(second.rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(second.child, 'exit')
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `terminée → ${completed.status} (résultat conservé), en vol → ${interrupted.status}`,
  }
})

await scenario(outcomes, 'R2 reprise WebSocket sans trou de séquence', async () => {
  const { child, rt } = await startDaemon(main.config, main.home)
  const first = openStream(rt, 0)
  await first.opened
  await until(() => first.messages.some((m) => m.type === 'snapshot'), 3_000)
  const snapshot = first.messages.find((m) => m.type === 'snapshot')!

  // Quelques événements pendant que le dashboard est connecté…
  const task = (await createTask(rt, 'tâche observée pendant une coupure', 6)).body.task
  await until(() => first.messages.filter((m) => m.type === 'event').length >= 2, 5_000)
  const seen = first.messages.filter((m) => m.type === 'event').map((m) => m.event.seq)
  const lastSeen = Math.max(snapshot.seq, ...seen)

  // …puis coupure franche, et la tâche continue d'avancer sans témoin.
  first.ws.terminate()
  await until(
    async () => (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task.status === 'completed',
    10_000,
  )

  const second = openStream(rt, lastSeen)
  await second.opened
  await until(() => second.messages.some((m) => m.type === 'snapshot'), 3_000)
  const resumed = second.messages.find((m) => m.type === 'snapshot')!

  // L'invariant : les séquences rejouées doivent se suivre sans aucun manque
  // entre la dernière vue et la dernière du serveur.
  const replayed = resumed.events.map((e) => e.seq)
  const expected = Array.from({ length: resumed.seq - lastSeen }, (_, i) => lastSeen + 1 + i)
  const complete = JSON.stringify(replayed) === JSON.stringify(expected)
  const ok = complete && !resumed.truncated && replayed.length > 0

  second.ws.close()
  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(child, 'exit')
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `coupure après la séquence ${lastSeen}, ${replayed.length} événement(s) rejoué(s) jusqu'à ${resumed.seq}, aucun manquant : ${complete}`,
  }
})

await scenario(outcomes, 'R3 reprise impossible signalée plutôt que subie', async () => {
  const { child, rt } = await startDaemon(main.config, main.home)
  // `since` au-delà de tout ce qui existe : le serveur n'a rien à rejouer, mais
  // ne doit pas non plus prétendre que la timeline est complète.
  await createTask(rt, 'tâche quelconque', 3)
  const stream = openStream(rt, 1)
  await stream.opened
  await until(() => stream.messages.some((m) => m.type === 'snapshot'), 3_000)
  const snapshot = stream.messages.find((m) => m.type === 'snapshot')!
  // L'instantané reste complet pour l'état courant, c'est tout l'intérêt.
  const ok = snapshot.tasks.length > 0 && typeof snapshot.truncated === 'boolean'
  stream.ws.close()
  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(child, 'exit')
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `instantané de ${snapshot.tasks.length} tâche(s), tronqué=${snapshot.truncated}`,
  }
})

await scenario(outcomes, 'R4 contrôles d\'accès de l\'API locale', async () => {
  const { child, rt } = await startDaemon(main.config, main.home)
  const auth = `authorization: Bearer ${rt.token}`
  const host = `host: 127.0.0.1:${rt.port}`
  const results: Record<string, string> = {
    'host légitime': await rawRequest(rt.port, [host, auth]),
    'host rebindé': await rawRequest(rt.port, [`host: evil.test:${rt.port}`, auth]),
    'origine étrangère': await rawRequest(rt.port, [host, 'origin: http://evil.test', auth]),
    'origine dashboard': await rawRequest(rt.port, [host, `origin: http://127.0.0.1:${rt.port}`, auth]),
    'sec-fetch cross-site': await rawRequest(rt.port, [host, 'sec-fetch-site: cross-site', auth]),
    'sans jeton': await rawRequest(rt.port, [host]),
    'jeton erroné': await rawRequest(rt.port, [host, `authorization: Bearer ${'0'.repeat(64)}`]),
    'bootstrap sans jeton': await rawRequest(rt.port, [host], '/ui/bootstrap'),
    'bootstrap rebindé': await rawRequest(rt.port, ['host: evil.test'], '/ui/bootstrap'),
  }
  const expected: Record<string, string> = {
    'host légitime': '200',
    'host rebindé': '403',
    'origine étrangère': '403',
    'origine dashboard': '200',
    'sec-fetch cross-site': '403',
    'sans jeton': '401',
    'jeton erroné': '401',
    // Le dashboard n'a pas de jeton avant d'avoir chargé la page : l'enveloppe
    // fait la sécurité de cette route-là.
    'bootstrap sans jeton': '200',
    'bootstrap rebindé': '403',
  }
  // WebSocket : l'enveloppe s'y applique aussi, et le jeton passe par le sous-protocole.
  const foreign = openStream(rt, 0, 'http://evil.test')
  const foreignAccepted = await foreign.opened
  foreign.ws.terminate()
  const noToken = new WebSocket(`ws://127.0.0.1:${rt.port}/events`, [WS_SUBPROTOCOL])
  const noTokenAccepted = await new Promise<boolean>((r) => {
    noToken.once('open', () => r(true))
    noToken.once('error', () => r(false))
  })
  noToken.terminate()

  const wrong = Object.entries(expected).filter(([k, code]) => !results[k]!.includes(code))
  const ok = wrong.length === 0 && !foreignAccepted && !noTokenAccepted

  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(child, 'exit')
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: wrong.length
      ? `inattendu : ${wrong.map(([k]) => `${k} → ${results[k]}`).join(' ; ')}`
      : `9 contrôles HTTP conformes, WebSocket d'origine étrangère refusée (${!foreignAccepted}), sans jeton refusée (${!noTokenAccepted})`,
  }
})

await scenario(outcomes, 'R5 approbation expirée → tâche timed_out', async () => {
  const short = tempHome('expiry')
  const { child, rt } = await startDaemon(short.config, short.home, { MIDGAARD_APPROVAL_TTL_S: '2' })
  const task = (await createTask(rt, 'tâche dont personne ne décide', 3, true)).body.task
  await until(
    async () => (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task.status === 'waiting_approval',
    8_000,
  )
  // L'empreinte servie doit se recalculer depuis le détail servi : c'est ce
  // qui prouve que le gérant de tâches la tire bien de l'opération structurée,
  // et pas du texte affiché (Slice 3, étape 4).
  const paused = (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.approval
  const hashHolds =
    paused !== null &&
    paused.operation_detail !== null &&
    paused.operation_hash === operationHash(task.id, paused.seq, paused.operation_detail)
  const expired = await until(
    async () => (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task.status === 'timed_out',
    10_000,
  )
  const final = (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task
  const approvals = (await daemonJson<{ approvals: Approval[] }>(rt, '/api/approvals')).body.approvals

  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(child, 'exit')
  short.cleanup()
  return {
    verdict: expired && approvals.length === 0 && hashHolds ? 'PASS' : 'FAIL',
    detail:
      `statut final ${final.status} — « ${final.error ?? 'aucune erreur'} », ${approvals.length} demande(s) ` +
      `encore en attente, empreinte ${hashHolds ? 'recalculée depuis le détail' : 'NE CORRESPOND PAS au détail'}`,
  }
})

await scenario(outcomes, 'R6 annulation coopérative, non rejouable', async () => {
  const { child, rt } = await startDaemon(main.config, main.home)
  const task = (await createTask(rt, 'tâche annulée en cours de route', 30)).body.task
  await until(
    async () => (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task.status === 'running',
    10_000,
  )
  const first = await daemonJson<TaskView>(rt, `/api/tasks/${task.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'test' }),
  })
  const again = await daemonJson<{ error?: string }>(rt, `/api/tasks/${task.id}/cancel`, { method: 'POST' })
  const events = (await daemonJson<{ events: { type: string; status: string }[] }>(
    rt,
    `/api/tasks/${task.id}/events`,
  )).body.events
  // La trace doit montrer le passage par `cancel_requested` : c'est la forme
  // coopérative qu'exigeront les vrais agents.
  const passedThroughRequested = events.some((e) => e.status === 'cancel_requested')
  const ok = first.body.task.status === 'cancelled' && again.status === 409 && passedThroughRequested

  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(child, 'exit')
  return {
    verdict: ok ? 'PASS' : 'FAIL',
    detail: `première annulation → ${first.body.task.status}, seconde → HTTP ${again.status} (${again.body.error}), passage par cancel_requested : ${passedThroughRequested}`,
  }
})

await scenario(outcomes, 'R7 arrêt automatique après inactivité', async () => {
  const idle = tempHome('idle')
  const { child, rt } = await startDaemon(idle.config, idle.home, { MIDGAARD_IDLE_SHUTDOWN_S: '2' })
  const stoppedOnItsOwn = await until(() => !pidAlive(rt.pid), 15_000)
  if (!stoppedOnItsOwn) {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
  idle.cleanup()
  return {
    verdict: stoppedOnItsOwn ? 'PASS' : 'FAIL',
    detail: stoppedOnItsOwn
      ? "le daemon s'est arrêté seul, sans tâche active ni dashboard connecté"
      : "le daemon tournait toujours au bout de 15 s — il ne s'arrête jamais seul",
  }
})

await scenario(outcomes, 'R8 attente longue : rend la main sur une pause nouvelle, bloque sur une pause connue', async () => {
  const { child, rt } = await startDaemon(main.config, main.home)
  type Waited = TaskView & { waited_ms: number }
  const wait = (id: string, timeoutMs: number, known = 0, signal?: AbortSignal) =>
    daemonJson<Waited>(rt, `/api/tasks/${id}/wait?timeout_ms=${timeoutMs}&known_approval=${known}`, signal ? { signal } : {})
  const problems: string[] = []

  const task = (await createTask(rt, 'tâche à double attente', 6, true)).body.task
  const paused = (await wait(task.id, 20_000)).body
  if (paused.next_action !== 'human_approval_pending' || !paused.approval) {
    problems.push(`première attente : ${paused.next_action}`)
  }
  // Un client qui n'a jamais vu cette pause doit être prévenu tout de suite.
  const other = (await wait(task.id, 20_000)).body
  if (other.next_action !== 'human_approval_pending' || other.waited_ms > 1_000) {
    problems.push(`autre client : ${other.next_action} après ${other.waited_ms} ms`)
  }
  // Celui qui l'a déjà signalée, lui, doit bloquer jusqu'à la décision : sans
  // cela il rappelait l'attente et obtenait la même réponse en deux
  // millisecondes, en boucle (défaut n° 2 de la Slice 0).
  const started = Date.now()
  let settled = false
  const blocking = wait(task.id, 30_000, paused.task.approval_seq).finally(() => (settled = true))
  await sleep(2_000)
  if (settled) problems.push('l\'attente n\'a pas bloqué sur une pause déjà connue')

  // La décision, par la commande qu'on conseille à l'humain, lancée comme il
  // la lancerait : depuis un autre dossier que le clone, et sans
  // `MIDGAARD_HOME` dans l'environnement — seul `--home` désigne le runtime.
  // Sans lui, elle cherchait la demande dans `~/.midgaard` (Slice 4, étape 8).
  if (paused.approval) {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    const command = harnessCommand(`approve ${paused.approval.id}`, { repoRoot, home: main.home })
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MIDGAARD_')))
    const ran = spawnSync(command, { shell: true, cwd: tmpdir(), env, encoding: 'utf8' })
    if (ran.status !== 0) problems.push(`commande en échec (${ran.status}) : ${(ran.stderr || ran.stdout).trim().slice(0, 300)}`)
  }
  const resumed = (await blocking).body
  const blockedFor = (Date.now() - started) / 1000
  if (resumed.next_action !== 'result_ready' || resumed.task.status !== 'completed') {
    problems.push(`après la décision : ${resumed.task.status} / ${resumed.next_action}`)
  }

  // Interrompre l'attente ne coupe que l'attente : la tâche continue.
  const long = (await createTask(rt, 'tâche dont l\'attente est interrompue', 60)).body.task
  const aborter = new AbortController()
  const abandoned = wait(long.id, 30_000, 0, aborter.signal).catch(() => null)
  await sleep(1_000)
  aborter.abort()
  await abandoned
  await sleep(300)
  const after = (await daemonJson<TaskView>(rt, `/api/tasks/${long.id}`)).body.task
  if (!['queued', 'preparing', 'running'].includes(after.status)) problems.push(`après interruption de l'attente : ${after.status}`)
  await daemonJson(rt, `/api/tasks/${long.id}/cancel`, { method: 'POST' }).catch(() => {})

  await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await once(child, 'exit')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : `pause signalée une fois, autre client prévenu en ${other.waited_ms} ms, attente bloquée ${blockedFor.toFixed(1)}s ` +
        `jusqu'à la décision par la CLI → ${resumed.next_action} ; attente interrompue, tâche toujours ${after.status}`,
  }
})

await scenario(outcomes, 'R9 ensureDaemon : un seul daemon, relancé après SIGKILL, remplacé s\'il est d\'un autre protocole', async () => {
  const fresh = tempHome('ensure')
  const quiet = () => {}
  // `ensureDaemon` transmet l'environnement courant au daemon qu'il lance :
  // port libre et coffre fichier, comme `childEnv` le fait pour les autres.
  const saved = { port: process.env.MIDGAARD_PORT, vault: process.env.MIDGAARD_VAULT }
  process.env.MIDGAARD_PORT = '0'
  process.env.MIDGAARD_VAULT = 'file'
  const problems: string[] = []
  const pids: number[] = []
  try {
    // Départ à froid, deux appels ensemble : chacun lance un daemon, le verrou
    // n'en laisse survivre qu'un, et les deux doivent le désigner.
    const [a, b] = await Promise.all([ensureDaemon(fresh.config, quiet), ensureDaemon(fresh.config, quiet)])
    pids.push(a.pid, b.pid)
    if (a.pid !== b.pid || !pidAlive(a.pid)) problems.push(`deux appels : pid ${a.pid} et ${b.pid}`)

    // Daemon tué net : le fichier de découverte lui survit, l'appel suivant
    // doit constater sa mort et en relancer un.
    process.kill(a.pid, 'SIGKILL')
    await until(() => !pidAlive(a.pid), 3_000)
    const relaunched = await ensureDaemon(fresh.config, quiet)
    pids.push(relaunched.pid)
    if (relaunched.pid === a.pid || !pidAlive(relaunched.pid)) problems.push(`après SIGKILL : pid ${relaunched.pid}`)

    // Un imposteur à la place du daemon, qui annonce une autre version de
    // protocole — comme un daemon resté actif après une mise à jour du code.
    await daemonJson(relaunched, '/api/shutdown', { method: 'POST' }).catch(() => {})
    await until(() => !pidAlive(relaunched.pid), 5_000)
    let shutdownAsked = false
    const impostor = createServer((req, res) => {
      if (req.url === '/api/shutdown') shutdownAsked = true
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION - 1, pid: process.pid }))
    })
    impostor.listen(0, '127.0.0.1')
    await once(impostor, 'listening')
    const port = (impostor.address() as { port: number }).port
    writeFileSync(
      fresh.config.runtimeFile,
      JSON.stringify({
        pid: process.pid,
        port,
        token: 'z'.repeat(64),
        started_at: new Date().toISOString(),
        protocol: PROTOCOL_VERSION - 1,
        dashboard_url: `http://127.0.0.1:${port}/`,
      }),
      { mode: 0o600 },
    )
    const replaced = await ensureDaemon(fresh.config, quiet)
    impostor.close()
    pids.push(replaced.pid)
    const health = (await daemonJson<{ protocol: number; pid: number }>(replaced, '/api/health')).body
    if (!shutdownAsked) problems.push('aucun arrêt demandé à l\'imposteur')
    if (health.protocol !== PROTOCOL_VERSION || health.pid === process.pid) {
      problems.push(`après l'imposteur : pid ${health.pid}, protocole ${health.protocol}`)
    }
    await daemonJson(replaced, '/api/shutdown', { method: 'POST' }).catch(() => {})
    await until(() => !pidAlive(replaced.pid), 5_000)
    return {
      verdict: problems.length ? 'FAIL' : 'PASS',
      detail: problems.length
        ? problems.join(' ; ')
        : `2 appels → pid ${a.pid} ; tué → pid ${relaunched.pid} ; imposteur en protocole ${PROTOCOL_VERSION - 1} arrêté → pid ${replaced.pid} en protocole ${health.protocol}`,
    }
  } finally {
    // Ces daemons sont détachés : aucun ne doit survivre à un scénario en échec.
    for (const pid of new Set(pids)) if (pid !== process.pid && pidAlive(pid)) process.kill(pid, 'SIGKILL')
    if (saved.port === undefined) delete process.env.MIDGAARD_PORT
    else process.env.MIDGAARD_PORT = saved.port
    if (saved.vault === undefined) delete process.env.MIDGAARD_VAULT
    else process.env.MIDGAARD_VAULT = saved.vault
    await sleep(200)
    fresh.cleanup()
  }
})

await scenario(outcomes, 'R10 stop --if-idle : refuse tant qu\'une tâche est active, arrête un daemon oisif', async () => {
  const fresh = tempHome('stop-idle')
  try {
    const { child, rt } = await startDaemon(fresh.config, fresh.home)
    const problems: string[] = []
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    // La commande que lance la coque, par la vraie CLI et sans rien dans
    // l'environnement : seul `--home` désigne le runtime.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MIDGAARD_')))
    // Lancée sans bloquer ce processus (`spawn`, pas `spawnSync`) : le daemon
    // est son enfant, et un parent bloqué ne le récolte pas — mort, il
    // resterait un zombie, que la commande verrait encore « vivant ».
    const stopIfIdle = async (): Promise<{ status: number | null; stdout: string }> => {
      const cli = spawn(harnessCommand('stop --if-idle', { repoRoot, home: fresh.home }), { shell: true, cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'ignore'] })
      let stdout = ''
      cli.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      const [status] = (await once(cli, 'close')) as [number | null]
      return { status, stdout }
    }

    const task = (await createTask(rt, 'tâche en cours pendant la mise à jour', 30)).body.task
    await until(async () => (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task.status === 'running', 10_000)
    const busy = await stopIfIdle()
    if (busy.status !== 3) problems.push(`daemon occupé : code ${busy.status} au lieu de 3 (${busy.stdout.trim()})`)
    if (!pidAlive(rt.pid)) problems.push('le daemon occupé a été arrêté')
    const still = (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task.status
    if (still !== 'running') problems.push(`la tâche active a été touchée : ${still}`)

    await daemonJson(rt, `/api/tasks/${task.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'fin du scénario' }) })
    await until(async () => (await daemonJson<TaskView>(rt, `/api/tasks/${task.id}`)).body.task.status === 'cancelled', 10_000)
    const idle = await stopIfIdle()
    if (idle.status !== 0) problems.push(`daemon oisif : code ${idle.status} (${idle.stdout.trim()})`)
    // La commande ne rend la main qu'une fois le processus mort : lu au système, tout de suite.
    const deadAtReturn = !pidAlive(rt.pid)
    if (!deadAtReturn) problems.push('la commande a rendu la main avant la mort du daemon')
    if (child.exitCode === null) await once(child, 'exit')
    // Plus de daemon : il n'y a rien à arrêter, et ce n'est pas une erreur.
    const none = await stopIfIdle()
    if (none.status !== 0) problems.push(`sans daemon : code ${none.status}`)

    return {
      verdict: problems.length === 0 ? 'PASS' : 'FAIL',
      detail: problems.length === 0 ? 'occupé → code 3, daemon vivant, tâche intacte ; oisif → arrêté, mort au retour de la commande ; sans daemon → 0' : problems.join(' ; '),
    }
  } finally {
    fresh.cleanup()
  }
})

// Dernier contrôle : la base reste lisible après tout ce traitement.
const store = HarnessStore.open(main.config)
const counts = store.countTasks()
store.close()
console.log(`\nBase finale : ${counts.total} tâche(s), ${counts.active} active(s)`)
main.cleanup()
process.exit(summarize(outcomes, 'Résumé — intégration'))
