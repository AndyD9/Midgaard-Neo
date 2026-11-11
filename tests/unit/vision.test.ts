/**
 * @file Lire une image (Slice 7, étape 2) : l'outil `read_image`, la boucle
 * qui joint l'image, et le moteur qui décide si le modèle lit les images.
 *
 * Ce qui est prouvé, et pourquoi :
 *  - **le type se lit dans les octets** : une extension qui ment ne trompe pas
 *    l'outil, et un texte déguisé en PNG est refusé ;
 *  - **la taille est plafonnée**, le chemin vérifié comme `read_file` ;
 *  - **sans modèle qui lit les images, l'outil refuse avec son motif**, et le
 *    moteur ne le propose même pas ;
 *  - **le catalogue l'emporte sur la déclaration**, qui tombe quand le modèle
 *    change ;
 *  - **l'image arrive au modèle, et aucun de ses octets n'est écrit en base**
 *    — lue octet pour octet, comme `test:security`.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { daemonJson, loadConfig, readRuntime, type Agent, type RuntimeInfo, type TaskView } from '@midgaard/contracts'
import { reconcileAgents, startDaemon, visionOf, type Daemon } from '@midgaard/daemon'
import { findTool, MAX_IMAGE_BYTES, sniffImageType, ToolError, type ToolContext } from '@midgaard/tools'
import { startFakeProvider, type FakeProvider } from '../fake-provider.ts'

const ICON = readFileSync(new URL('../../apps/desktop/src-tauri/icons/icon.png', import.meta.url))

describe('le type d\'une image, lu dans ses octets', () => {
  it('reconnaît PNG, JPEG, GIF et WebP, et rien d\'autre', () => {
    assert.equal(sniffImageType(ICON), 'image/png')
    assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg')
    assert.equal(sniffImageType(Buffer.from('GIF89a......')), 'image/gif')
    assert.equal(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp')
    assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null, 'un SVG est du texte : il porterait un script')
    assert.equal(sniffImageType(Buffer.from('RIFF....WAVE')), null)
    assert.equal(sniffImageType(Buffer.alloc(0)), null)
  })
})

describe('read_image', () => {
  let root: string
  const tool = findTool('read_image')!
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    root, httpPolicy: 'open', allowHosts: [], log: () => {}, vision: { enabled: true, reason: 'test' }, ...over,
  })
  /** Comme la boucle : la politique, puis `run`. */
  const call = async (path: string, context = ctx()) => {
    const verdict = tool.policy({ path } as never, context)
    if (verdict.decision !== 'allow') return { verdict }
    return { verdict, result: await tool.run({ path } as never, context) }
  }

  before(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-image-')))
    writeFileSync(join(root, 'icone.png'), ICON)
    writeFileSync(join(root, 'menteur.jpg'), ICON)
    writeFileSync(join(root, 'texte.png'), 'ceci n\'est pas une image\n')
    writeFileSync(join(root, 'enorme.png'), Buffer.concat([ICON.subarray(0, 8), Buffer.alloc(MAX_IMAGE_BYTES)]))
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('rend l\'image au modèle, et seulement son empreinte au journal', async () => {
    const { result } = await call('icone.png')
    assert.equal(result!.images?.[0]?.mediaType, 'image/png')
    assert.equal(result!.images?.[0]?.data, ICON.toString('base64'))
    assert.match(result!.summary, /icone\.png · image\/png · 1401 octets · sha256 [0-9a-f]{16}/)
    assert.ok(!result!.content.includes(ICON.toString('base64').slice(0, 40)), 'le texte rendu ne contient pas l\'image')
    assert.ok(!result!.summary.includes(ICON.toString('base64').slice(0, 40)), 'le résumé journalisé non plus')
    assert.equal(result!.untrusted, false, 'une image du projet n\'est pas plus suspecte que le dépôt')
  })

  it('lit le type dans les octets, pas dans le nom', async () => {
    const { result } = await call('menteur.jpg')
    assert.equal(result!.images?.[0]?.mediaType, 'image/png')
    await assert.rejects(call('texte.png'), (e: Error) => e instanceof ToolError && /not a PNG, JPEG, WebP or GIF/.test(e.message))
  })

  it('refuse une image trop grosse', async () => {
    await assert.rejects(call('enorme.png'), (e: Error) => e instanceof ToolError && /image too large/.test(e.message))
  })

  it('refuse un chemin hors du projet', async () => {
    await assert.rejects(call('../ailleurs.png'), (e: Error) => e instanceof ToolError)
  })

  it('refuse un lien qui sort du projet', { skip: process.platform === 'win32' && 'liens symboliques réservés aux administrateurs sous Windows' }, async () => {
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-image-dehors-')))
    try {
      writeFileSync(join(outside, 'secret.png'), ICON)
      symlinkSync(join(outside, 'secret.png'), join(root, 'lien.png'))
      await assert.rejects(call('lien.png'), (e: Error) => e instanceof ToolError && /escapes the allowed project root/.test(e.message))
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuse, avec son motif, à un modèle qui ne lit pas les images — et sans contexte de vision', async () => {
    const blind = await call('icone.png', ctx({ vision: { enabled: false, reason: 'model "x" cannot read images' } }))
    assert.equal(blind.verdict.decision, 'deny')
    assert.match(blind.verdict.reason, /cannot read images/)
    const unset = await call('icone.png', ctx({ vision: undefined }))
    assert.equal(unset.verdict.decision, 'deny', 'fermé par défaut, comme writable')
    await assert.rejects(tool.run({ path: 'icone.png' } as never, ctx({ vision: undefined })), ToolError)
  })
})

describe('qui décide qu\'un modèle lit les images', () => {
  const caps = (vision: boolean | null) => ({ vision, source: vision === null ? ('unknown' as const) : ('catalog' as const) })
  it('le catalogue, quand il le publie, contre une déclaration contraire', () => {
    assert.equal(visionOf(caps(true), false, 'venice', 'm').enabled, true)
    assert.equal(visionOf(caps(false), true, 'venice', 'm').enabled, false)
    assert.match(visionOf(caps(false), true, 'venice', 'm').reason, /cannot read images \(catalogue/)
  })
  it('la déclaration, quand le fournisseur ne publie rien ; sinon non, en disant pourquoi', () => {
    assert.equal(visionOf(caps(null), true, 'openai', 'm').enabled, true)
    assert.equal(visionOf(caps(null), false, 'openai', 'm').enabled, false)
    const unknown = visionOf(caps(null), null, 'openai', 'm')
    assert.equal(unknown.enabled, false)
    assert.match(unknown.reason, /does not say whether model "m" reads images, and this profile does not declare it/)
  })
})

describe('dans un vrai daemon', () => {
  let home: string
  let repo: string
  let daemon: Daemon
  let provider: FakeProvider
  let rt: RuntimeInfo

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'midgaard-vision-'))
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-vision-depot-')))
    writeFileSync(join(repo, 'maquette.png'), ICON)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    provider = await startFakeProvider()
    const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
    daemon = (await startDaemon(config, { log: () => {}, env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-vision' } }))!
    rt = readRuntime(config.runtimeFile)!
    // Un fournisseur `custom` : il ne publie pas la capacité de ses modèles.
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

  /** Lance un Researcher et attend sa fin. */
  async function research(tag: string): Promise<TaskView['task']> {
    provider.scripts.set(tag, [
      [{ tool: 'read_image', args: { path: 'maquette.png' } }],
      [{ tool: 'submit_result', args: { summary: 'vu' } }],
    ])
    const created = daemon.tasks.create({
      objective: `${tag} regarde la maquette`, agentId: 'researcher', context: null, projectDir: repo, durationS: 20, needsApproval: false,
    })
    assert.ok(!('error' in created), JSON.stringify(created))
    return (await daemon.tasks.wait(created.task.id, 15_000, 0))!.task
  }

  /** `PATCH /api/agents/:id`. */
  function patch(id: string, body: unknown) {
    return daemonJson<{ agent?: Agent; error?: string }>(rt, `/api/agents/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
  }

  it('ne propose pas read_image quand rien ne dit que le modèle lit les images, et le dit', async () => {
    const done = await research('[sans-vision]')
    assert.ok(!provider.tools.get('[sans-vision]')?.includes('read_image'), 'l\'outil n\'est pas proposé')
    assert.ok(provider.tools.get('[sans-vision]')?.includes('read_file'))
    const note = daemon.store.taskEvents(done.id).find((e) => e.type === 'agent.message' && /read_image retiré/.test(String(e.payload.message)))
    assert.match(String(note?.payload.message), /does not say whether model "faux-1" reads images/)
    const refused = daemon.store.toolCalls(done.id).find((c) => c.name === 'read_image')
    assert.equal(refused?.decision, 'deny', 'appelé quand même : refusé, sans approbation')
  })

  it('montre l\'image au modèle une fois la capacité déclarée, sans rien en écrire en base', async () => {
    const declared = await patch('researcher', { vision: true })
    assert.equal(declared.status, 200, JSON.stringify(declared.body))
    assert.equal(declared.body.agent?.vision, true)

    const done = await research('[avec-vision]')
    assert.equal(done.status, 'completed', done.error ?? '')
    assert.ok(provider.tools.get('[avec-vision]')?.includes('read_image'))
    const conversation = JSON.stringify(provider.received.get('[avec-vision]') ?? [])
    assert.ok(conversation.includes(`data:image/png;base64,${ICON.toString('base64')}`), 'l\'image est arrivée au modèle')

    const call = daemon.store.toolCalls(done.id).find((c) => c.name === 'read_image')
    assert.match(call?.result_summary ?? '', /maquette\.png · image\/png · 1401 octets · sha256/)
    // La base et son WAL, lus octet pour octet : ni l'image, ni un morceau.
    const probe = ICON.toString('base64').slice(30, 90)
    for (const name of ['harness.db', 'harness.db-wal']) {
      try {
        assert.ok(!readFileSync(join(home, name)).includes(probe), `image dans ${name}`)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    }
  })

  it('oublie la déclaration quand le modèle change : elle portait sur l\'ancien', async () => {
    await patch('researcher', { vision: true })
    const changed = await patch('researcher', { model: 'faux-2' })
    assert.equal(changed.body.agent?.model, 'faux-2')
    assert.equal(changed.body.agent?.vision, null)
    const both = await patch('researcher', { model: 'faux-3', vision: false })
    assert.equal(both.body.agent?.vision, false, 'déclarée avec le nouveau modèle, elle tient')
  })
})
