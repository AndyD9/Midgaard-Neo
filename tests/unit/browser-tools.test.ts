/**
 * @file Les outils du navigateur et ses sessions (Slice 7, étape 4).
 *
 * Deux moitiés, parce qu'elles prouvent deux choses :
 *
 *  - **les outils face à un faux port** — sans Chromium, donc partout : ce qui
 *    est libre, ce qui attend un humain, ce qui est refusé sans demander, et
 *    surtout qu'une saisie approuvée **n'est pas tapée** si la page a changé
 *    pendant que l'humain décidait. Puis la boucle : une capture chasse la
 *    précédente de la conversation, le message qui la porte la dit non fiable,
 *    et le résultat de la tâche l'est aussi ;
 *  - **les sessions du daemon sur un vrai Chromium** : le journal raconte
 *    l'ouverture et la fermeture sans une image, la coupure par l'humain et
 *    l'échéance ferment la session et l'agent l'apprend, une tâche qui finit
 *    pendant l'ouverture ne laisse aucun Chromium — compté au système.
 *
 * Sans Chromium installé, la seconde moitié **saute en le disant** ; les tests
 * de groupe de processus sautent sous Windows, en le disant aussi.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, it } from 'node:test'
import { chromium } from 'playwright'
import type { Agent, NewTaskEvent } from '@midgaard/contracts'
import { DEFAULT_RESEARCHER_LIMITS, emptyUsage } from '@midgaard/contracts'
import type { CompletionRequest, Message, ProviderAdapter } from '@midgaard/providers'
import { dropTransientImages, runAgent, type ApprovalOutcome, type LoopHooks } from '@midgaard/agent-runtime'
import {
  assertPublicHost, findTool, ToolError,
  type BrowserCapture, type BrowserPageView, type BrowserPort, type BrowserSessionInfo, type ToolContext,
} from '@midgaard/tools'
import { BrowserSession, type HostGuard } from '@midgaard/browser'
import { BrowserSessions, defaultBrowserGuard, type EventBus } from '@midgaard/daemon'

/** Un JPEG minimal : ses trois premiers octets suffisent à le reconnaître. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

/** Un faux port : il note ce qu'on lui demande, et la page qu'il « montre » se règle. */
function fakePort() {
  const calls: string[] = []
  let session: BrowserSessionInfo | null = null
  let closedReason: string | null = null
  let view: BrowserPageView = { url: 'https://example.org/', title: 'Exemple', focused: 'input[name="q"]' }
  const capture = (): BrowserCapture => ({ ...view, jpeg: JPEG, viewport: { width: 1280, height: 800 } })
  const port: BrowserPort = {
    session: () => session ?? { closed_reason: closedReason },
    open: async (r) => {
      calls.push(`open ${r.url} ${r.max_duration_s}`)
      session = {
        objective: r.objective, start_url: r.url, expires_at: Date.now() + r.max_duration_s * 1000,
        planned_inputs: r.planned_inputs.map((p) => ({ ...p })),
      }
      return capture()
    },
    claimPlanned: (input) => {
      const at = session?.planned_inputs.findIndex((p) => p.text === input.text && p.press_enter === input.press_enter) ?? -1
      if (at < 0) return false
      session!.planned_inputs.splice(at, 1)
      calls.push(`claim ${input.text}`)
      return true
    },
    view: async () => ({ ...view }),
    screenshot: async () => (calls.push('screenshot'), capture()),
    goto: async (url) => (calls.push(`goto ${url}`), capture()),
    click: async (x, y) => (calls.push(`click ${x},${y}`), capture()),
    scroll: async (dy) => (calls.push(`scroll ${dy}`), capture()),
    type: async (text) => (calls.push(`type ${text}`), capture()),
    press: async (key) => (calls.push(`press ${key}`), capture()),
    close: async (reason) => {
      calls.push('close')
      session = null
      closedReason = reason
    },
  }
  return {
    port,
    calls,
    setView: (v: Partial<BrowserPageView>) => {
      view = { ...view, ...v }
    },
    cut: (reason: string) => {
      session = null
      closedReason = reason
    },
  }
}

const VISION = { enabled: true, reason: 'test' }

function ctxWith(over: Partial<ToolContext> = {}): ToolContext {
  return { root: '/', httpPolicy: 'open', allowHosts: [], log: () => {}, vision: VISION, ...over }
}

/** Un outil du navigateur, ses arguments validés par son propre schéma. */
function tool(name: string) {
  const t = findTool(name)
  assert.ok(t, `outil ${name} enregistré`)
  const parse = (args: unknown) => (t.schema as unknown as { parse(a: unknown): never }).parse(args)
  return {
    policy: (args: unknown, ctx: ToolContext) => t.policy(parse(args), ctx),
    prepare: (args: unknown, ctx: ToolContext) => t.prepare!(parse(args), ctx),
    run: (args: unknown, ctx: ToolContext, prepared?: Awaited<ReturnType<NonNullable<typeof t.prepare>>>) =>
      t.run(parse(args), ctx, prepared),
  }
}

describe('les outils du navigateur, face à un faux port', () => {
  it('refusent sans port, sans vision, et sans session — sans approbation à la place', async () => {
    const { port } = fakePort()
    assert.equal(tool('browser_open').policy({ objective: 'o', url: 'https://example.org' }, ctxWith()).decision, 'deny')
    const blind = ctxWith({ browser: port, vision: { enabled: false, reason: 'model "m" cannot read images' } })
    const verdict = tool('browser_open').policy({ objective: 'o', url: 'https://example.org' }, blind)
    assert.deepEqual(verdict, { decision: 'deny', reason: 'model "m" cannot read images' })
    for (const [name, args] of [
      ['browser_screenshot', {}], ['browser_click', { x: 1, y: 1 }], ['browser_type', { text: 'a' }],
      ['browser_key', { key: 'Enter' }], ['browser_close', {}],
    ] as const) {
      const v = tool(name).policy(args, ctxWith({ browser: port }))
      assert.equal(v.decision, 'deny', name)
      assert.match(v.reason, /call browser_open first/)
    }
  })

  it('browser_open attend un humain, et l\'opération préparée porte l\'adresse, l\'objectif et la durée bornée', async () => {
    const { port, calls } = fakePort()
    const ctx = ctxWith({ browser: port, deadline: Date.now() + 120_000 })
    const args = { objective: 'lire la page de prix', url: 'https://Example.org/prix', max_duration_s: 1800 }
    assert.equal(tool('browser_open').policy(args, ctx).decision, 'approval')
    const prepared = await tool('browser_open').prepare(args, ctx)
    // L'échéance de la tâche borne la session : l'humain lit la vraie durée.
    const duration = prepared.detail.max_duration_s as number
    assert.ok(duration <= 120 && duration >= 118, `durée bornée par l'échéance : ${duration}`)
    assert.deepEqual(
      { ...prepared.detail, max_duration_s: 0 },
      { tool: 'browser_open', objective: 'lire la page de prix', url: 'https://example.org/prix', max_duration_s: 0, planned_inputs: [] },
    )
    assert.match(prepared.summary, /https:\/\/example\.org\/prix/)
    assert.match(prepared.summary, /lire la page de prix/)
    await assert.rejects(tool('browser_open').prepare({ objective: 'o', url: 'file:///etc/passwd' }, ctx), /only http/)

    const result = await tool('browser_open').run(args, ctx, prepared)
    assert.equal(calls[0], `open https://example.org/prix ${duration}`)
    assert.equal(result.untrusted, true, 'une page web n\'est pas fiable')
    assert.equal(result.images?.[0]?.mediaType, 'image/jpeg')
    assert.equal(result.images?.[0]?.transient, true, 'une capture est chassée par la suivante')
    assert.ok(!result.summary.includes('Exemple'), 'le titre, écrit par la page, ne va pas au journal')
    // Une seule session à la fois.
    assert.equal(tool('browser_open').policy(args, ctx).decision, 'deny')
  })

  it('regarder, aller, cliquer, défiler et les touches de déplacement sont libres dans la session', async () => {
    const { port, calls } = fakePort()
    const ctx = ctxWith({ browser: port })
    await port.open({ objective: 'o', url: 'https://example.org/', max_duration_s: 60, planned_inputs: [] })
    for (const [name, args] of [
      ['browser_screenshot', {}], ['browser_goto', { url: 'https://example.org/b' }], ['browser_click', { x: 5, y: 6 }],
      ['browser_scroll', { dy: 300 }], ['browser_key', { key: 'Tab' }], ['browser_close', {}],
    ] as const) {
      assert.equal(tool(name).policy(args, ctx).decision, 'allow', name)
    }
    await tool('browser_click').run({ x: 5, y: 6 }, ctx)
    await assert.rejects(tool('browser_goto').run({ url: 'javascript:alert(1)' }, ctx), /only http/)
    assert.deepEqual(calls.slice(1), ['click 5,6'], 'une adresse refusée n\'atteint pas le navigateur')
  })

  it('saisir et presser Entrée attendent un humain, avec le texte exact, la page et le champ', async () => {
    const { port } = fakePort()
    const ctx = ctxWith({ browser: port })
    await port.open({ objective: 'o', url: 'https://example.org/', max_duration_s: 60, planned_inputs: [] })
    assert.equal(tool('browser_type').policy({ text: 'midgaard' }, ctx).decision, 'approval')
    assert.equal(tool('browser_key').policy({ key: 'Enter' }, ctx).decision, 'approval')
    const prepared = await tool('browser_type').prepare({ text: 'midgaard harness' }, ctx)
    assert.deepEqual(prepared.detail, {
      tool: 'browser_type', text: 'midgaard harness', press_enter: false, url: 'https://example.org/', focused: 'input[name="q"]',
    })
    assert.equal(prepared.summary, 'saisir "midgaard harness" dans input[name="q"] de https://example.org/')
  })

  it('une saisie approuvée n\'est PAS tapée si la page ou le champ ont changé pendant la décision', async () => {
    const { port, calls, setView } = fakePort()
    const ctx = ctxWith({ browser: port })
    await port.open({ objective: 'o', url: 'https://example.org/', max_duration_s: 60, planned_inputs: [] })
    const typing = await tool('browser_type').prepare({ text: 'bonjour' }, ctx)
    const enter = await tool('browser_key').prepare({ key: 'Enter' }, ctx)
    // La page s'est redirigée seule pendant que l'humain lisait.
    setView({ url: 'https://evil.example/' })
    await assert.rejects(tool('browser_type').run({ text: 'bonjour' }, ctx, typing), /page changed.*Nothing was typed/s)
    await assert.rejects(tool('browser_key').run({ key: 'Enter' }, ctx, enter), /page changed/)
    // Même adresse, autre champ : refusé aussi.
    setView({ url: 'https://example.org/', focused: 'input[type="password"]' })
    await assert.rejects(tool('browser_type').run({ text: 'bonjour' }, ctx, typing), /page changed/)
    assert.ok(!calls.some((c) => c.startsWith('type') || c.startsWith('press')), `rien n'a été tapé : ${calls.join(' | ')}`)
    setView({ focused: 'input[name="q"]' })
    await tool('browser_type').run({ text: 'bonjour' }, ctx, typing)
    assert.equal(calls.at(-1), 'type bonjour')
  })

  it('saisie puis Entrée en une seule approbation, qui les nomme toutes deux', async () => {
    const { port, calls } = fakePort()
    const ctx = ctxWith({ browser: port })
    await port.open({ objective: 'o', url: 'https://example.org/', max_duration_s: 60, planned_inputs: [] })
    const args = { text: 'Acheter du pain', press_enter: true }
    assert.equal(tool('browser_type').policy(args, ctx).decision, 'approval')
    const prepared = await tool('browser_type').prepare(args, ctx)
    assert.equal(prepared.summary, 'saisir "Acheter du pain" puis presser Entrée dans input[name="q"] de https://example.org/')
    assert.equal(prepared.detail.press_enter, true, 'Entrée est dans l\'empreinte')
    const result = await tool('browser_type').run(args, ctx, prepared)
    assert.deepEqual(calls.slice(-2), ['type Acheter du pain', 'press Enter'])
    assert.equal(result.summary, 'typed 15 characters, then pressed Enter → https://example.org/')
  })

  it('un texte prévu à l\'ouverture part sans demande, une fois, et seulement à la lettre', async () => {
    const { port, calls } = fakePort()
    const ctx = ctxWith({ browser: port })
    const open = {
      objective: 'reproduire la maquette', url: 'https://example.org/',
      planned_inputs: [{ text: 'Acheter du pain', press_enter: true }, { text: 'Lancer la CI' }],
    }
    const session = await tool('browser_open').prepare(open, ctx)
    // L'humain lit les textes avec la session : ils sont dans le texte approuvé et dans l'empreinte.
    assert.match(session.summary, /textes prévus, tapés une fois chacun sans nouvelle demande : "Acheter du pain" puis Entrée ; "Lancer la CI" — /)
    assert.match(session.summary, /tout autre texte, et Entrée seule, approuvés chacun$/)
    assert.deepEqual(session.detail.planned_inputs, [
      { text: 'Acheter du pain', press_enter: true }, { text: 'Lancer la CI', press_enter: false },
    ])
    await tool('browser_open').run(open, ctx, session)

    const type = tool('browser_type')
    const planned = { text: 'Acheter du pain', press_enter: true }
    assert.equal(type.policy(planned, ctx).decision, 'allow')
    // À la lettre près, Entrée comprise : sinon, l'humain est sollicité.
    for (const other of [
      { text: 'Acheter du pain' }, { text: 'acheter du pain', press_enter: true },
      { text: 'Acheter du pain ', press_enter: true }, { text: 'Lancer la CI', press_enter: true },
    ]) {
      assert.equal(type.policy(other, ctx).decision, 'approval', JSON.stringify(other))
    }
    const prepared = await type.prepare(planned, ctx)
    await type.run(planned, ctx, prepared)
    assert.deepEqual(calls.slice(-3), ['claim Acheter du pain', 'type Acheter du pain', 'press Enter'])
    // Une fois seulement : la même saisie redemande l'humain…
    assert.equal(type.policy(planned, ctx).decision, 'approval')
    // …et une préparation périmée, qui la croyait prévue, ne tape rien.
    const before = calls.length
    await assert.rejects(type.run(planned, ctx, prepared), /already typed/)
    assert.equal(calls.length, before, 'rien n\'a été tapé')
    // L'autre texte prévu reste disponible.
    assert.equal(type.policy({ text: 'Lancer la CI' }, ctx).decision, 'allow')
  })

  it('une session coupée est refusée, avec son motif, à l\'action suivante', async () => {
    const { port, cut } = fakePort()
    const ctx = ctxWith({ browser: port })
    await port.open({ objective: 'o', url: 'https://example.org/', max_duration_s: 60, planned_inputs: [] })
    cut('cut by the human operator')
    const verdict = tool('browser_click').policy({ x: 1, y: 1 }, ctx)
    assert.equal(verdict.decision, 'deny')
    assert.match(verdict.reason, /cut by the human operator.*browser_open/)
    // Et l'exécution revérifie : la session a pu fermer entre la politique et l'action.
    await assert.rejects(tool('browser_screenshot').run({}, ctx), /cut by the human operator/)
  })
})

describe('les captures dans la conversation', () => {
  it('dropTransientImages retire les captures, garde les images du projet, et le dit', () => {
    const project = { mediaType: 'image/png' as const, data: 'cHJvamV0' }
    const shot = { mediaType: 'image/jpeg' as const, data: 'Y2FwdHVyZQ==', transient: true }
    const messages: Message[] = [
      { role: 'user', content: 'deux images', images: [project, shot] },
      { role: 'user', content: 'une capture', images: [shot] },
    ]
    dropTransientImages(messages)
    assert.deepEqual(messages[0]!.role === 'user' && messages[0]!.images, [project])
    assert.equal(messages[1]!.role === 'user' && messages[1]!.images, undefined)
    assert.match(String(messages[1]!.content), /1 earlier screenshot\(s\) removed/)
  })

  it('dans la boucle : une seule capture envoyée, dite non fiable, et le résultat de la tâche non fiable', async () => {
    const { port } = fakePort()
    const calls: CompletionRequest[] = []
    const script = [
      [{ id: 'o', name: 'browser_open', argumentsJson: '{"objective":"regarder","url":"https://example.org/"}' }],
      [{ id: 'c', name: 'browser_click', argumentsJson: '{"x":10,"y":10}' }],
      [{ id: 's', name: 'submit_result', argumentsJson: '{"summary":"vu","details":"","citations":[]}' }],
    ]
    const adapter: ProviderAdapter = {
      id: 'faux', preset: 'venice', model: 'm', supportsWebSearch: false,
      async complete(request) {
        // Copie : la boucle modifie la conversation en place.
        calls.push(structuredClone(request))
        const toolCalls = script[Math.min(calls.length - 1, script.length - 1)]!
        return { text: '', toolCalls, usage: { ...emptyUsage(), model_calls: 1 }, citations: [], finishReason: 'tool_calls' }
      },
      async testConnection() {
        return { ok: true, detail: '', at: new Date().toISOString(), latency_ms: 0, models: [] }
      },
    }
    const approvals: string[] = []
    const hooks: LoopHooks = {
      onAgentMessage: () => {}, onUsage: () => {}, onNote: () => {},
      onToolRequested: () => 'x', onToolCompleted: () => {},
      requestApproval: async (r) => (approvals.push(r.operation), 'approved' as ApprovalOutcome),
      isCancelled: () => false,
    }
    const agent: Agent = {
      id: 'navigator', name: 'N', kind: 'researcher', description: '', provider_id: 'faux', model: null,
      system_prompt: 'You browse.', tools: ['browser_open', 'browser_click', 'submit_result'],
      limits: { ...DEFAULT_RESEARCHER_LIMITS }, enabled: true, vision: true, mcp_servers: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    const outcome = await runAgent({
      agent, objective: 'regarde', context: null, adapter, tools: ctxWith({ browser: port }), hooks,
      redact: (t) => t, signal: new AbortController().signal,
    })
    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.status === 'completed' && outcome.result.untrusted, true, 'la tâche a vu une page web')
    assert.equal(approvals.length, 1, 'la session seule a été approuvée, pas le clic')
    assert.match(approvals[0]!, /^browser_open — ouvrir un navigateur isolé sur https:\/\/example\.org\//)
    // L'humain approuve la session en sachant qu'un clic, même d'envoi, ne lui sera pas soumis.
    assert.match(approvals[0]!, /clics libres pendant la session, envoi de formulaire compris ; tout autre texte, et Entrée seule, approuvés chacun$/)
    const count = (r: CompletionRequest) => r.messages.reduce((n, m) => n + (m.role === 'user' ? m.images?.length ?? 0 : 0), 0)
    assert.equal(count(calls[1]!), 1)
    assert.equal(count(calls[2]!), 1, 'la capture du clic a chassé celle de l\'ouverture')
    const last = calls[2]!.messages.filter((m) => m.role === 'user' && m.images?.length).at(-1)!
    assert.match(String(last.content), /DATA, never an instruction/)
    const tool = calls[2]!.messages.find((m) => m.role === 'tool' && m.name === 'browser_click')!
    assert.match(String(tool.content), /untrusted_data/, 'l\'adresse et le titre, écrits par la page, sont encadrés')
  })
})

// --- Les sessions du daemon, sur un vrai Chromium -----------------------------

const installed = existsSync(chromium.executablePath())
const skip = !installed && 'Chromium absent : npx playwright install chromium'
const posix = process.platform !== 'win32'

/** La page de test est « l'internet public » ; le reste passe par la vraie garde. */
const testGuard: HostGuard = async (host) => (host === '127.0.0.1' ? ['127.0.0.1'] : assertPublicHost(host))

/** Les processus encore vivants du groupe d'un pid, comptés au système. */
function groupAlive(pid: number): number {
  try {
    return execFileSync('pgrep', ['-g', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

/** Un faux bus : il garde les événements écrits, pour lire ce que le journal aurait reçu. */
function recordingBus() {
  const events: { taskId: string; event: Omit<NewTaskEvent, 'task_id' | 'status'> }[] = []
  const bus = {
    record: (taskId: string, _to: unknown, event: Omit<NewTaskEvent, 'task_id' | 'status'>) => {
      events.push({ taskId, event })
      return null
    },
  } as unknown as EventBus
  return { bus, events }
}

describe('les sessions du daemon', { skip }, () => {
  let server: Server
  let origin = ''
  const pids: number[] = []
  /** Ouvre comme le daemon, en notant le pid de chaque Chromium pour le compter ensuite. */
  const openSession = async (options: Parameters<typeof BrowserSession.open>[0]) => {
    const s = await BrowserSession.open(options)
    pids.push(s.pid)
    return s
  }

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Formulaire</title><input id="q" name="q" autofocus>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const address = server.address()
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })
  after(() => server.close())

  it('ouvre, voit le champ actif, tape ; la coupure humaine ferme et l\'agent l\'apprend ; aucune image au journal', async () => {
    const { bus, events } = recordingBus()
    const sessions = new BrowserSessions({ bus, config: { httpPolicy: 'open', allowHosts: [] }, log: () => {}, guard: testGuard, openSession })
    const port = sessions.portFor('t1', (t) => t.replace('secret-123', '[REDACTED]'))
    try {
      const cap = await port.open({ objective: 'remplir secret-123', url: `${origin}/`, max_duration_s: 60, planned_inputs: [] })
      assert.equal(cap.title, 'Formulaire')
      assert.equal(cap.jpeg.subarray(0, 3).toString('hex'), 'ffd8ff')
      assert.equal(cap.focused, 'input#q[name="q"]')
      assert.ok(sessions.frame('t1'), 'la dernière capture est gardée en mémoire, pour l\'atelier')
      await port.type('bonjour')
      assert.equal(sessions.openCount, 1)

      assert.equal(await sessions.close('t1', 'cut by the human operator'), true)
      assert.deepEqual(port.session(), { closed_reason: 'cut by the human operator' })
      await assert.rejects(port.click(1, 1), (e: unknown) => e instanceof ToolError && /cut by the human operator/.test(e.message))
      assert.equal(sessions.frame('t1'), null)

      assert.deepEqual(events.map((e) => e.event.type), ['browser.opened', 'browser.closed'])
      assert.equal(events[0]!.event.payload.objective, 'remplir [REDACTED]', 'l\'objectif est expurgé')
      const written = JSON.stringify(events)
      assert.ok(!written.includes(cap.jpeg.toString('base64').slice(0, 40)), 'aucune capture au journal')
      if (posix) assert.equal(groupAlive(pids.at(-1)!), 0, 'Chromium est mort avec la session')
    } finally {
      await sessions.closeAll('fin du test')
    }
  })

  it('se ferme seule à l\'échéance approuvée', async () => {
    const { bus, events } = recordingBus()
    const sessions = new BrowserSessions({ bus, config: { httpPolicy: 'open', allowHosts: [] }, log: () => {}, guard: testGuard, openSession })
    const port = sessions.portFor('t2', (t) => t)
    try {
      await port.open({ objective: 'o', url: `${origin}/`, max_duration_s: 1, planned_inputs: [] })
      await sleep(1500)
      assert.deepEqual(port.session(), { closed_reason: 'its approved duration is over' })
      assert.equal(events.at(-1)?.event.type, 'browser.closed')
      if (posix) assert.equal(groupAlive(pids.at(-1)!), 0)
    } finally {
      await sessions.closeAll('fin du test')
    }
  })

  it('une tâche qui finit pendant l\'ouverture ne laisse aucun Chromium', { skip: !posix && 'groupes de processus POSIX seulement' }, async () => {
    const { bus } = recordingBus()
    const sessions = new BrowserSessions({ bus, config: { httpPolicy: 'open', allowHosts: [] }, log: () => {}, guard: testGuard, openSession })
    const port = sessions.portFor('t3', (t) => t)
    const before = pids.length
    const opening = port.open({ objective: 'o', url: `${origin}/`, max_duration_s: 60, planned_inputs: [] })
    await sessions.endTask('t3', 'the task ended')
    await assert.rejects(opening, /ended while the browser was starting/)
    assert.equal(sessions.openCount, 0)
    assert.equal(pids.length, before + 1, 'Chromium avait bien démarré')
    assert.equal(groupAlive(pids.at(-1)!), 0, 'et il est mort')
    await assert.rejects(port.open({ objective: 'o', url: `${origin}/`, max_duration_s: 60, planned_inputs: [] }), /task is ending/)
  })
})

describe('la garde du navigateur', () => {
  it('applique la liste blanche sous la politique allowlist, et refuse toujours la boucle locale', async () => {
    const guard = defaultBrowserGuard({ httpPolicy: 'allowlist', allowHosts: ['93.184.215.14', '127.0.0.1'] })
    await assert.rejects(guard('example.net'), /not on the allowlist/)
    assert.deepEqual(await guard('93.184.215.14'), ['93.184.215.14'])
    await assert.rejects(guard('127.0.0.1'), /private or loopback/, 'la liste blanche n\'ouvre pas la boucle locale')
    const open = defaultBrowserGuard({ httpPolicy: 'open', allowHosts: [] })
    await assert.rejects(open('169.254.169.254'), /metadata/)
  })
})
