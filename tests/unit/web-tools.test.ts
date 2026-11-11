/**
 * @file Le web lu par un navigateur : `search_web` et `read_web_page`, de
 * l'outil au daemon, avec un vrai Chromium devant des pages servies par le
 * test.
 *
 * Aucun de ces tests ne joint l'internet : la page lue et la « page de
 * résultats » d'un moteur sont locales, admises par une garde de test. Ce que
 * les vrais moteurs répondent a été constaté à la main (tableau de
 * `packages/browser/src/search.ts`), et change sans prévenir.
 *
 * Ce qui est prouvé, et pourquoi :
 *  - **fermés par défaut** : sans port, les deux outils refusent ;
 *  - **la politique est celle d'`http_fetch`** : `allowlist` refuse, `approval`
 *    demande, et tous les moteurs d'une recherche sont jugés ;
 *  - **ce qui est rendu est `untrusted`**, cité, et une page de vérification
 *    anti-robot est **annoncée comme telle** au lieu de passer pour un contenu ;
 *  - le navigateur rend le texte **après** les scripts de la page, sans ses
 *    scripts ni ses éléments cachés ;
 *  - une recherche **passe au moteur suivant** quand le premier ne donne rien,
 *    et **échoue en le disant** quand aucun ne répond — jamais une liste vide ;
 *  - **la vraie garde refuse la boucle locale**, par ce chemin aussi ;
 *  - **un seul Chromium par tâche, et aucun après elle** : compté au système ;
 *  - de bout en bout dans un daemon : un Researcher cherche puis lit, sans
 *    aucune approbation, et son résultat est non fiable.
 *
 * Sans Chromium installé, la partie navigateur **saute en le disant**.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, it } from 'node:test'
import { chromium } from 'playwright'
import { daemonJson, loadConfig, readRuntime, type RuntimeInfo, type Task, type ToolCall } from '@midgaard/contracts'
import {
  ORCHESTRATOR_TOOLS, RESEARCHER_AGENT_ID, RESEARCHER_TOOLS, WebReaders, reconcileAgents, startDaemon, type Daemon,
} from '@midgaard/daemon'
import {
  assertPublicHost, findTool, looksLikeBotCheck, toolSpecs, ToolError,
  type ToolContext, type WebPage, type WebPort,
} from '@midgaard/tools'
import { BrowserSession, searchWeb, type BrowserSessionOptions, type HostGuard, type SearchEngine } from '@midgaard/browser'
import { startFakeProvider, type FakeProvider } from '../fake-provider.ts'

const installed = existsSync(chromium.executablePath())
const skipBrowser = !installed && 'Chromium absent : npx playwright install chromium'
const posix = process.platform !== 'win32'

/** La page de test est « l'internet public » ; le reste passe par la vraie garde. */
const testGuard: HostGuard = async (host) => (host === '127.0.0.1' ? ['127.0.0.1'] : assertPublicHost(host))

/** Les processus Chromium descendants de ce processus, comptés au système. */
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

/** Attend qu'aucun Chromium ne descende plus de ce processus. */
async function noChromium(): Promise<number> {
  let left = chromiumDescendants()
  for (let i = 0; i < 100 && left > 0; i++) {
    await sleep(50)
    left = chromiumDescendants()
  }
  return left
}

// --- Les pages du test -----------------------------------------------------

/** Une page dont le contenu n'existe qu'après son script, avec du texte caché. */
const ARTICLE = `<!doctype html><title>Article</title>
<h1>Titre visible</h1><p id="p">avant le script</p>
<p style="display:none">TEXTE CACHÉ</p>
<script>document.getElementById('p').textContent = 'écrit par le script ' + (6 * 7)</script>`

/** Une page de résultats : un lien enveloppé, un doublon, un lien sans titre. */
const RESULTS = (q: string) => `<!doctype html><title>Résultats</title>
<div class="r"><a class="t" href="/go?u=${encodeURIComponent('https://exemple.test/un')}">Premier pour ${q}</a><p class="s">extrait un</p></div>
<div class="r"><a class="t" href="https://exemple.test/deux">Second</a><p class="s">extrait deux</p></div>
<div class="r"><a class="t" href="https://exemple.test/deux">Second, en double</a></div>
<div class="r"><a class="t" href="https://exemple.test/vide"> </a></div>`

const CAPTCHA = `<!doctype html><title>Captcha</title><p>Verifying you are not a bot</p>`

let site: Server
let origin = ''
/** Ce que le serveur de test a reçu. */
const hits: string[] = []

/** Un moteur qui répond, servi par le test : son lien de résultat est enveloppé. */
const fakeEngine = (): SearchEngine => ({
  id: 'faux-moteur',
  url: (q) => `${origin}/cherche?q=${encodeURIComponent(q)}`,
  link: 'a.t',
  container: 'div.r',
  snippet: '.s',
  unwrap: (href) => new URL(href).searchParams.get('u') ?? href,
})
/** Un moteur qui répond par un défi. */
const blockedEngine = (): SearchEngine => ({ ...fakeEngine(), id: 'moteur-bloqué', url: () => `${origin}/captcha` })

before(async () => {
  site = createServer((req, res) => {
    hits.push(req.url ?? '')
    const url = new URL(req.url ?? '/', 'http://x')
    const body =
      url.pathname === '/cherche' ? RESULTS(url.searchParams.get('q') ?? '') : url.pathname === '/captcha' ? CAPTCHA : ARTICLE
    res.writeHead(url.pathname === '/captcha' ? 403 : 200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  const address = site.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
after(() => site.close())

// --- Les outils, sans navigateur -------------------------------------------

/** Un contexte d'outil minimal, avec ou sans port web. */
function context(over: Partial<ToolContext> = {}): ToolContext {
  return { root: tmpdir(), httpPolicy: 'open', allowHosts: [], log: () => {}, ...over }
}

/** Un faux port : rend ce qu'on lui donne, et note ce qu'on lui demande. */
function fakePort(page: Partial<WebPage> = {}): WebPort & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    searchHosts: () => ['moteur.test', 'autre-moteur.test'],
    search: async (query) => {
      asked.push(query)
      return { engine: 'moteur.test', results: [{ title: 'Un', url: 'https://exemple.test/un', snippet: 'extrait' }] }
    },
    read: async (url) => {
      asked.push(url)
      return { url, title: 'Titre', status: 200, text: 'x'.repeat(2000), truncated: false, ...page }
    },
  }
}

const search = () => findTool('search_web')!
const read = () => findTool('read_web_page')!

describe('search_web et read_web_page — les outils', () => {
  it('fermés par défaut : sans port, la politique refuse et l\'exécution aussi', async () => {
    assert.equal(search().policy({ query: 'q' } as never, context()).decision, 'deny')
    assert.equal(read().policy({ url: 'https://exemple.test/', offset: 0 } as never, context()).decision, 'deny')
    await assert.rejects(() => read().run({ url: 'https://exemple.test/', offset: 0 } as never, context()), ToolError)
  })

  it('la politique est celle d\'http_fetch', () => {
    const web = fakePort()
    const args = { url: 'https://exemple.test/doc', offset: 0 } as never
    assert.equal(read().policy(args, context({ web })).decision, 'allow')
    assert.equal(read().policy(args, context({ web, httpPolicy: 'approval' })).decision, 'approval')
    assert.equal(read().policy(args, context({ web, httpPolicy: 'allowlist' })).decision, 'deny')
    assert.equal(read().policy(args, context({ web, httpPolicy: 'allowlist', allowHosts: ['exemple.test'] })).decision, 'allow')
    assert.equal(read().policy({ url: 'file:///etc/passwd', offset: 0 } as never, context({ web })).decision, 'deny')
    assert.equal(read().policy({ url: 'pas une adresse', offset: 0 } as never, context({ web })).decision, 'deny')
  })

  it('une recherche juge tous ses moteurs : un seul hors liste suffit à refuser', () => {
    const web = fakePort()
    const q = { query: 'q' } as never
    assert.equal(search().policy(q, context({ web })).decision, 'allow')
    assert.equal(search().policy(q, context({ web, httpPolicy: 'approval' })).decision, 'approval')
    assert.equal(search().policy(q, context({ web, httpPolicy: 'allowlist', allowHosts: ['moteur.test'] })).decision, 'deny')
    assert.equal(
      search().policy(q, context({ web, httpPolicy: 'allowlist', allowHosts: ['moteur.test', 'autre-moteur.test'] })).decision,
      'allow',
    )
  })

  it('une recherche rend ses résultats numérotés, non fiables et cités', async () => {
    const web = fakePort()
    const result = await search().run({ query: 'zod' } as never, context({ web }))
    assert.deepEqual(web.asked, ['zod'])
    assert.equal(result.untrusted, true)
    assert.match(result.content, /1\. Un\n {3}https:\/\/exemple\.test\/un\n {3}extrait/)
    assert.deepEqual(result.citations, [{ title: 'Un', url: 'https://exemple.test/un' }])
  })

  it('une page lue porte son adresse, son code, et reprend à l\'offset demandé', async () => {
    const web = fakePort({ text: 'abcdefghij', url: 'https://exemple.test/final' })
    const result = await read().run({ url: 'https://exemple.test/', offset: 4 } as never, context({ web }))
    assert.equal(result.untrusted, true)
    assert.match(result.content, /URL: https:\/\/exemple\.test\/final/)
    assert.match(result.content, /HTTP status: 200/)
    assert.ok(result.content.endsWith('efghij'))
    assert.match(result.summary, /redirigé vers/)
    const past = await read().run({ url: 'https://exemple.test/', offset: 99 } as never, context({ web }))
    assert.match(past.content, /offset 99 is past the end/)
  })

  it('une vérification anti-robot est annoncée, jamais rendue comme un contenu', async () => {
    const web = fakePort({ title: 'Just a moment...', text: 'Performing security verification', status: 403 })
    const result = await read().run({ url: 'https://exemple.test/', offset: 0 } as never, context({ web }))
    assert.match(result.content, /bot-check page, not the content/)
    assert.match(result.content, /does not bypass/)
    assert.match(result.summary, /anti-robot/)
    // Un long article qui parle de captcha n'en est pas un.
    assert.equal(looksLikeBotCheck({ title: 'Les captcha', text: 'captcha '.repeat(400), status: 200 }), false)
  })

  it('décrits au modèle, et donnés au Researcher seulement', () => {
    const specs = toolSpecs(RESEARCHER_TOOLS)
    assert.ok(specs.some((t) => t.name === 'search_web') && specs.some((t) => t.name === 'read_web_page'))
    // L'interrupteur de la recherche native du fournisseur n'est toujours pas un outil.
    assert.ok(!specs.some((t) => t.name === 'web_search'))
    assert.ok(!ORCHESTRATOR_TOOLS.includes('search_web') && !ORCHESTRATOR_TOOLS.includes('read_web_page'))
  })
})

// --- Le navigateur ---------------------------------------------------------

describe('lire et chercher dans un vrai Chromium', { skip: skipBrowser }, () => {
  let session: BrowserSession
  before(async () => {
    session = await BrowserSession.open({ guard: testGuard })
  })
  after(() => session.close())

  it('rend le texte visible après les scripts, sans script ni élément caché', async () => {
    await session.goto(`${origin}/article`)
    const page = await session.readPage()
    assert.equal(page.status, 200)
    assert.equal(page.title, 'Article')
    assert.match(page.text, /Titre visible/)
    assert.match(page.text, /écrit par le script 42/)
    assert.ok(!page.text.includes('TEXTE CACHÉ'), 'un élément caché n\'est pas lu')
    assert.ok(!page.text.includes('getElementById'), 'le script n\'est pas du texte')
    assert.equal(page.truncated, false)
  })

  it('relève les résultats : redirection dépliée, doublon et lien sans titre écartés', async () => {
    const { engine, results } = await searchWeb(session, 'zod & co', [fakeEngine()])
    assert.equal(engine, 'faux-moteur')
    assert.deepEqual(results, [
      { title: 'Premier pour zod & co', url: 'https://exemple.test/un', snippet: 'extrait un' },
      { title: 'Second', url: 'https://exemple.test/deux', snippet: 'extrait deux' },
    ])
    // La requête est partie encodée, entière.
    assert.ok(hits.includes(`/cherche?q=${encodeURIComponent('zod & co')}`))
  })

  it('passe au moteur suivant quand le premier ne donne rien', async () => {
    const { engine, results } = await searchWeb(session, 'q', [blockedEngine(), fakeEngine()], 300)
    assert.equal(engine, 'faux-moteur')
    assert.equal(results.length, 2)
  })

  it('échoue en nommant chaque moteur quand aucun ne répond', async () => {
    await assert.rejects(
      () => searchWeb(session, 'q', [blockedEngine(), { ...blockedEngine(), id: 'second-bloqué' }], 300),
      (e: Error) => /moteur-bloqué/.test(e.message) && /second-bloqué/.test(e.message) && /"Captcha"/.test(e.message) && /does not bypass/.test(e.message),
    )
  })
})

describe('les navigateurs de lecture du daemon (WebReaders)', { skip: skipBrowser }, () => {
  const config: { httpPolicy: 'open'; allowHosts: string[]; webBrowser: 'window' | 'headless' } = {
    httpPolicy: 'open', allowHosts: [], webBrowser: 'headless',
  }

  it('un seul Chromium par tâche, fermé à sa fin, et aucun ne survit', { skip: !posix && 'compte des processus : POSIX seulement' }, async () => {
    assert.equal(await noChromium(), 0, 'aucun Chromium avant le test')
    const opened: BrowserSession[] = []
    const readers = new WebReaders({
      config, log: () => {}, guard: testGuard, engines: [fakeEngine()],
      openSession: async (o) => {
        const s = await BrowserSession.open(o)
        opened.push(s)
        return s
      },
    })
    const port = readers.portFor('tâche-1')
    // Deux appels lancés ensemble : ils passent l'un après l'autre, dans le même navigateur.
    const [page, found] = await Promise.all([port.read(`${origin}/article`), port.search('zod')])
    assert.match(page.text, /écrit par le script 42/)
    assert.equal(found.results.length, 2)
    assert.equal(opened.length, 1, 'un seul navigateur pour deux appels')
    assert.equal(readers.openCount, 1)
    assert.ok(chromiumDescendants() > 0, 'le compte voit le Chromium de la tâche')

    await readers.endTask('tâche-1')
    assert.equal(readers.openCount, 0)
    assert.equal(await noChromium(), 0, 'aucun Chromium après la fin de la tâche')
    // Et plus rien ne s'ouvre pour elle.
    await assert.rejects(() => port.read(`${origin}/article`), ToolError)
    assert.equal(opened.length, 1)
  })

  it('la vraie garde refuse la boucle locale, par ce chemin aussi', async () => {
    const readers = new WebReaders({ config, log: () => {} })
    try {
      const before = hits.length
      await assert.rejects(() => readers.portFor('t').read(`${origin}/article`), ToolError)
      assert.equal(hits.length, before, 'la page locale n\'a pas été atteinte')
    } finally {
      await readers.closeAll()
    }
  })

  it('fermé au repos, rouvert à l\'appel suivant', async () => {
    let opens = 0
    const readers = new WebReaders({
      config, log: () => {}, guard: testGuard, idleMs: 100,
      openSession: (o) => {
        opens++
        return BrowserSession.open(o)
      },
    })
    try {
      const port = readers.portFor('t')
      await port.read(`${origin}/article`)
      for (let i = 0; i < 100 && readers.openCount > 0; i++) await sleep(50)
      assert.equal(readers.openCount, 0, 'fermé après le délai de repos')
      assert.match((await port.read(`${origin}/article`)).text, /Titre visible/)
      assert.equal(opens, 2)
    } finally {
      await readers.closeAll()
    }
  })

  it('sans écran, la fenêtre demandée retombe sans fenêtre, et le journal le dit une fois', async () => {
    const asked: (boolean | undefined)[] = []
    const logs: string[] = []
    const readers = new WebReaders({
      config: { ...config, webBrowser: 'window' },
      log: (...a) => logs.push(a.join(' ')),
      guard: testGuard,
      idleMs: 50,
      openSession: (o: BrowserSessionOptions) => {
        asked.push(o.headless)
        if (o.headless === false) throw new Error('Missing X server or $DISPLAY')
        return BrowserSession.open(o)
      },
    })
    try {
      const port = readers.portFor('t')
      await port.read(`${origin}/article`)
      for (let i = 0; i < 100 && readers.openCount > 0; i++) await sleep(50)
      await port.read(`${origin}/article`)
      // Fenêtre tentée une fois, puis sans fenêtre ; la seconde ouverture ne la retente pas.
      assert.deepEqual(asked, [false, true, true])
      assert.equal(logs.filter((l) => /repli sans fenêtre/.test(l)).length, 1)
    } finally {
      await readers.closeAll()
    }
  })
})

// --- De bout en bout -------------------------------------------------------

describe('un Researcher cherche et lit le web, dans un vrai daemon', { skip: skipBrowser }, () => {
  let home: string
  let repo: string
  let daemon: Daemon
  let provider: FakeProvider
  let rt: RuntimeInfo

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'midgaard-web-'))
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-web-depot-')))
    provider = await startFakeProvider()
    // Sans fenêtre : une suite de tests n'ouvre rien sur l'écran de qui la lance.
    const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0', MIDGAARD_WEB_BROWSER: 'headless' })
    daemon = (await startDaemon(config, {
      log: () => {},
      env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-web' },
      browserGuard: testGuard,
      searchEngines: [fakeEngine()],
      pickDirectory: { available: () => 'test', pick: async () => ({ cancelled: true }) },
    }))!
    rt = readRuntime(config.runtimeFile)!
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
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('cherche puis lit sans aucune approbation ; résultat non fiable, aucun Chromium après', async () => {
    provider.scripts.set('[W1]', [
      [{ tool: 'search_web', args: { query: 'zod schema' } }],
      [{ tool: 'read_web_page', args: { url: `${origin}/article` } }],
      [{ tool: 'submit_result', args: { summary: 'la page dit 42' } }],
    ])
    const created = await daemonJson<{ task: Task }>(rt, '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: RESEARCHER_AGENT_ID, objective: '[W1] cherche zod', project_dir: repo }),
    })
    assert.equal(created.status, 201)
    const id = created.body.task.id
    let task = daemon.store.getTask(id)!
    for (let i = 0; i < 400 && !['completed', 'failed', 'cancelled'].includes(task.status); i++) {
      await sleep(50)
      task = daemon.store.getTask(id)!
      assert.equal(daemon.store.pendingApprovals().filter((a) => a.task_id === id).length, 0, 'aucune approbation demandée')
    }
    assert.equal(task.status, 'completed', task.error ?? '')

    const calls = (await daemonJson<{ tool_calls: ToolCall[] }>(rt, `/api/tasks/${id}/tools`)).body.tool_calls
    const searched = calls.find((c) => c.name === 'search_web')!
    const opened = calls.find((c) => c.name === 'read_web_page')!
    assert.equal(searched.status, 'succeeded')
    assert.match(searched.result_summary ?? '', /2 résultat\(s\) · faux-moteur/)
    assert.equal(opened.status, 'succeeded')
    // Le résultat d'une tâche qui a reçu un contenu du web est non fiable.
    assert.equal(task.result?.untrusted, true)
    if (posix) assert.equal(await noChromium(), 0, 'aucun Chromium après la fin de la tâche')
  })
})
