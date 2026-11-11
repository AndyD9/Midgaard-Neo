/**
 * @file Une image d'une tâche, en lecture seule (Slice 7), par HTTP comme le
 * dashboard : un vrai daemon, un vrai dépôt, un Developer dans son worktree et
 * un Researcher sur le dossier du projet.
 *
 * Ce qui est prouvé :
 *  - l'image qu'un agent a lue se relit en octets, type lu dans les octets,
 *    avec son empreinte, sous des en-têtes qui l'empêchent de devenir une page ;
 *  - un SVG, un texte déguisé en PNG et un fichier absent sont refusés ;
 *  - **aucun chemin hostile ne passe** : `..`, absolu, `.git` en toute casse,
 *    et surtout un lien posé dans le worktree, vers l'extérieur ou vers `.git`
 *    — ce dernier reste sous la racine, et n'est arrêté que par la relecture du
 *    chemin réel ;
 *  - c'est la seule lecture de fichier de l'API : ni arbre, ni contenu, ni
 *    méthode d'écriture sur ces chemins.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  daemonFetch,
  daemonJson,
  loadConfig,
  readRuntime,
  type RuntimeInfo,
  type Task,
} from '@midgaard/contracts'
import { reconcileAgents, startDaemon, type Daemon } from '@midgaard/daemon'
import { startFakeProvider, type FakeProvider } from '../fake-provider.ts'

let home: string
let repo: string
let daemon: Daemon
let provider: FakeProvider
let rt: RuntimeInfo
let developer: Task
let researcher: Task
let worktree: string

const ICON = readFileSync(new URL('../../apps/desktop/src-tauri/icons/icon.png', import.meta.url))

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'midgaard-files-'))
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-files-depot-')))
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@example.org', '-c', 'commit.gpgsign=false', ...a], {
      cwd: repo,
      stdio: 'ignore',
    })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), '# Projet\n')
  // Les images du fil (Slice 7) : une vraie, un SVG qui porte un script, un
  // texte déguisé en PNG.
  writeFileSync(join(repo, 'maquette.png'), ICON)
  writeFileSync(join(repo, 'dessin.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  writeFileSync(join(repo, 'faux.png'), 'pas une image')
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')

  provider = await startFakeProvider()
  const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
  daemon = (await startDaemon(config, {
    log: () => {},
    env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-fichiers' },
  }))!
  rt = readRuntime(config.runtimeFile)!
  daemon.store.upsertProvider({
    id: 'faux', name: 'faux', kind: 'openai-compatible', preset: 'custom', baseUrl: provider.url,
    defaultModel: 'faux-1', secretRef: null, webSearch: 'off',
  })
  reconcileAgents(daemon.store)

  provider.scripts.set('[fichiers]', [
    [{ tool: 'write_file', args: { path: 'src/nouveau.ts', content: 'export const n = 0\n' } }],
    [{ tool: 'submit_result', args: { summary: 'un fichier créé' } }],
  ])
  const created = daemon.tasks.create({
    objective: '[fichiers] crée un fichier', agentId: 'developer', context: null, projectDir: repo,
    durationS: 20, needsApproval: false,
  })
  assert.ok(!('error' in created), JSON.stringify(created))
  const done = await daemon.tasks.wait(created.task.id, 20_000, 0)
  assert.equal(done?.task.status, 'completed', done?.task.error ?? '')
  developer = done!.task
  worktree = daemon.store.workspaceForTask(developer.id)!.worktree_path
  // Ce que l'agent ne peut pas faire avec ses outils, mais qu'une commande
  // approuvée pourrait : des liens.
  if (process.platform !== 'win32') {
    symlinkSync('/etc', join(worktree, 'dehors'))
    symlinkSync('.git', join(worktree, 'lien-git'))
  }

  provider.scripts.set('[lecteur]', [[{ tool: 'submit_result', args: { summary: 'lu' } }]])
  const read = daemon.tasks.create({
    objective: '[lecteur] lis', agentId: 'researcher', context: null, projectDir: repo,
    durationS: 20, needsApproval: false,
  })
  assert.ok(!('error' in read))
  researcher = (await daemon.tasks.wait(read.task.id, 20_000, 0))!.task
})

after(async () => {
  daemon.close('fin des tests')
  await daemon.stopped
  provider.server.close()
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('une image lue par un agent, pour le fil (Slice 7)', () => {
  /** L'image d'une tâche, en octets. */
  const image = (task: Task, path: string) =>
    daemonFetch(rt, `/api/tasks/${task.id}/files/image?path=${encodeURIComponent(path)}`)

  it('rend les octets, le type lu dans les octets, l\'empreinte, et rien qui puisse devenir une page', async () => {
    const res = await image(researcher, 'maquette.png')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'")
    assert.equal(res.headers.get('x-midgaard-sha256'), createHash('sha256').update(ICON).digest('hex'))
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(ICON))
  })

  it('refuse un SVG, un texte déguisé, un absent, et les chemins hostiles', async () => {
    assert.equal((await image(researcher, 'dessin.svg')).status, 415, 'un SVG est du texte, qui peut porter un script')
    assert.equal((await image(researcher, 'faux.png')).status, 415, 'le type se lit dans les octets')
    assert.equal((await image(researcher, 'absente.png')).status, 404)
    for (const path of ['../maquette.png', 'src/../../maquette.png', '/etc/hosts', 'C:/Windows/win.ini', '..\\maquette.png', '.git', '.git/config', '.GIT/config', 'src/.git/x', '']) {
      const res = await image(developer, path)
      assert.equal(res.status, 400, path)
      assert.equal(((await res.json()) as { error?: string }).error, 'path_refused')
    }
  })

  it('lit dans le worktree d\'un Developer comme dans le dossier du projet', async () => {
    assert.equal((await image(developer, 'maquette.png')).status, 200)
  })

  const unix = process.platform === 'win32' && 'liens symboliques réservés aux administrateurs sous Windows'

  it('refuse un lien du worktree qui mène dehors, sans dire où', { skip: unix }, async () => {
    const res = await image(developer, 'dehors/hosts')
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error?: string }
    assert.equal(body.error, 'path_refused')
    assert.doesNotMatch(JSON.stringify(body), /\/etc/, 'le message ne révèle pas la cible du lien')
  })

  it('refuse un lien du worktree qui mène sous .git, bien qu\'il reste sous la racine', { skip: unix }, async () => {
    // `lien-git` → `.git`, un fichier qui désigne le dépôt de l'utilisateur.
    const res = await image(developer, 'lien-git')
    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as { error?: string }).error, 'path_refused')
  })

  it('n\'expose ni arbre, ni contenu de fichier, ni méthode d\'écriture', async () => {
    assert.equal((await daemonJson(rt, `/api/tasks/${developer.id}/files`)).status, 404)
    assert.equal((await daemonJson(rt, `/api/tasks/${developer.id}/files/content?path=README.md`)).status, 404)
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await daemonJson(rt, `/api/tasks/${developer.id}/files/image?path=maquette.png`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'DELETE' ? undefined : '{}',
      })
      assert.equal(r.status, 405, method)
    }
  })
})

