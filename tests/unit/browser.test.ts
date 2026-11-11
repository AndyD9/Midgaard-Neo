/**
 * @file Le navigateur isolé (Slice 7, étape 3) : un vrai Chromium, derrière le
 * proxy gardé, sur une page servie par le test.
 *
 * Ce qui est prouvé, et pourquoi :
 *  - la session navigue, capture, clique, saisit et presse Entrée ;
 *  - **la vraie garde refuse la boucle locale** — Chromium ne contourne pas le
 *    proxy pour `127.0.0.1`, comme il le fait d'office —, **même quand la
 *    variable de Playwright qui le permettrait est posée**, et le service de
 *    métadonnées du cloud appelé depuis une page ;
 *  - `file:`, `javascript:` et les touches hors liste sont refusés, une fenêtre
 *    surgissante est fermée ;
 *  - **aucun processus Chromium ne survit**, ni à la fermeture, ni au
 *    processus qui tenait la session tué net (`SIGKILL`) : compté au système,
 *    pas supposé.
 *
 * Sans Chromium installé, la suite **saute en le disant** (`npx playwright
 * install chromium`) ; la CI de bout en bout l'installe avant `test:unit`.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, it } from 'node:test'
import { chromium } from 'playwright'
import { assertPublicHost } from '@midgaard/tools'
import { BrowserError, BrowserSession, splitHostPort, type HostGuard } from '@midgaard/browser'

const installed = existsSync(chromium.executablePath())
const skip = !installed && 'Chromium absent : npx playwright install chromium'
const posix = process.platform !== 'win32'

let server: Server
let origin = ''
/** Ce que le serveur de test a reçu, pour voir ce qui l'a atteint. */
const hits: string[] = []

const PAGE = `<!doctype html><title>Accueil</title>
<button id="b" style="position:absolute;left:10px;top:10px;width:120px;height:40px"
  onclick="document.title='Cliqué'">Clic</button>
<form action="/cherche" style="position:absolute;left:10px;top:80px">
  <input id="q" name="q" autofocus style="width:200px;height:30px">
</form>`

/** Une page qui tente de joindre le service de métadonnées du cloud. */
const SNOOP = `<!doctype html><title>Curieuse</title><img src="http://169.254.169.254/latest/meta-data/">`
const POPUP = `<!doctype html><title>Surgissante</title><script>window.open('/')</script>`

/**
 * La garde des tests : le serveur de test est « l'internet public », tout le
 * reste passe par la vraie garde, qui refuse les adresses privées.
 */
const testGuard: HostGuard = async (host) => (host === '127.0.0.1' ? ['127.0.0.1'] : assertPublicHost(host))

/** Les processus encore vivants du groupe d'un pid, comptés au système. */
function groupAlive(pid: number): number {
  try {
    return execFileSync('pgrep', ['-g', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

before(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    const body = req.url === '/curieuse' ? SNOOP : req.url === '/surgit' ? POPUP : PAGE
    const title = req.url?.startsWith('/cherche') ? `<title>Résultats ${new URL(req.url, 'http://x').searchParams.get('q')}</title>` : ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(title || body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
after(() => server.close())

describe('le proxy gardé', () => {
  it('lit hôte et port d\'un CONNECT, IPv6 compris, et refuse le reste', () => {
    assert.deepEqual(splitHostPort('example.org:443'), { host: 'example.org', port: 443 })
    assert.deepEqual(splitHostPort('[::1]:8443'), { host: '::1', port: 8443 })
    assert.equal(splitHostPort('example.org'), null)
    assert.equal(splitHostPort('example.org:99999'), null)
  })
})

describe('une session', { skip }, () => {
  let session: BrowserSession
  before(async () => {
    session = await BrowserSession.open({ guard: testGuard })
  })
  after(async () => {
    await session.close()
  })

  it('navigue, capture en JPEG, clique, saisit et presse Entrée', async () => {
    const opened = await session.goto(`${origin}/`)
    assert.equal(opened.title, 'Accueil')
    const shot = await session.screenshot()
    assert.equal(shot.jpeg[0], 0xff, 'JPEG')
    assert.equal(shot.jpeg[1], 0xd8)
    assert.ok(shot.jpeg.length > 1000)
    assert.equal((await session.click(60, 30)).title, 'Cliqué')
    await session.click(100, 95)
    await session.type('chat')
    const submitted = await session.press('Enter')
    assert.match(submitted.url, /\/cherche\?q=chat$/)
    assert.equal(submitted.title, 'Résultats chat')
  })

  it('refuse file:, javascript:, une touche hors liste et un clic hors de la page', async () => {
    await assert.rejects(session.goto('file:///etc/passwd'), (e: Error) => e instanceof BrowserError && /only http/.test(e.message))
    await assert.rejects(session.goto('javascript:alert(1)'), BrowserError)
    await assert.rejects(session.press('F12'), (e: Error) => e instanceof BrowserError && /key not allowed/.test(e.message))
    await assert.rejects(session.click(5000, 5), (e: Error) => e instanceof BrowserError && /outside the page/.test(e.message))
  })

  it('ferme une fenêtre surgissante : une seule page', async () => {
    await session.goto(`${origin}/surgit`)
    await sleep(500)
    assert.equal(session.pageCount(), 1)
  })

  it('refuse ce qu\'une page tente de joindre hors de l\'internet public, et le dit', async () => {
    await session.goto(`${origin}/curieuse`)
    await sleep(500)
    const imds = session.refused().find((r) => r.host === '169.254.169.254')
    assert.match(imds?.reason ?? '', /cloud metadata service/)
  })
})

describe('la vraie garde', { skip }, () => {
  it('refuse la boucle locale : Chromium ne contourne pas le proxy', async () => {
    const before = hits.length
    const session = await BrowserSession.open()
    try {
      await assert.rejects(session.goto(`${origin}/`), (e: Error) => e instanceof BrowserError && /private or loopback/.test(e.message))
      assert.equal(hits.length, before, 'la page n\'a pas été servie')
    } finally {
      await session.close()
    }
  })
})

describe('la vraie garde, même quand Playwright est désarmé', { skip }, () => {
  // Playwright fait passer la boucle locale par le proxy, sauf si cette
  // variable est posée ; le daemon hérite de l'environnement de qui le lance.
  // Sans le drapeau explicite de la session, ce test échoue : vu.
  const VAR = 'PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK'
  it('refuse encore la boucle locale', async () => {
    const before = hits.length
    const saved = process.env[VAR]
    process.env[VAR] = '1'
    const session = await BrowserSession.open()
    try {
      await assert.rejects(session.goto(`${origin}/`), (e: Error) => e instanceof BrowserError && /private or loopback/.test(e.message))
      assert.equal(hits.length, before, 'la page n\'a pas été servie')
    } finally {
      await session.close()
      if (saved === undefined) delete process.env[VAR]
      else process.env[VAR] = saved
    }
  })
})

describe('aucun processus ne survit', { skip }, () => {
  it('à la fermeture : le groupe de Chromium est mort', { skip: !posix && 'groupes de processus POSIX' }, async () => {
    const session = await BrowserSession.open({ guard: testGuard })
    const pid = session.pid
    assert.ok(groupAlive(pid) > 0, 'Chromium tourne')
    await session.close()
    await session.close()
    assert.equal(groupAlive(pid), 0)
    await assert.rejects(session.goto(`${origin}/`), (e: Error) => /closed/.test(e.message))
  })

  it('au processus qui tenait la session tué net : la garde emporte Chromium', { skip: !posix && 'groupes de processus POSIX' }, async () => {
    // Un processus à part ouvre une session et donne le pid de Chromium ;
    // il est ensuite tué par SIGKILL, sans rien pouvoir fermer.
    const script =
      "import { BrowserSession } from '@midgaard/browser';" +
      "const s = await BrowserSession.open({ guard: async () => ['127.0.0.1'] });" +
      "console.log(s.pid); setInterval(() => {}, 1000)"
    const child = spawn(process.execPath, ['--conditions=midgaard-dev', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const pid = await new Promise<number>((resolve, reject) => {
      child.stdout!.on('data', (c: Buffer) => resolve(Number(c.toString().trim())))
      child.on('exit', () => reject(new Error('le processus a fini avant d\'ouvrir la session')))
    })
    assert.ok(groupAlive(pid) > 0, 'Chromium tourne')
    // Figé, Chromium ne voit pas se fermer le canal qui le relie au processus
    // mort ; sans cela, il quitte de lui-même, et ce test passait aussi
    // **sans la garde** (constaté en la retirant, Slice 7, étape 7).
    process.kill(pid, 'SIGSTOP')
    child.kill('SIGKILL')
    let left = groupAlive(pid)
    for (let i = 0; i < 50 && left > 0; i++) {
      await sleep(100)
      left = groupAlive(pid)
    }
    assert.equal(left, 0, `${left} processus Chromium vivants après la mort de leur parent`)
  })
})
