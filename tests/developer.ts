/**
 * @file Le Developer de bout en bout : un vrai daemon, de vrais dépôts Git, un
 * faux fournisseur de modèle.
 *
 * Le fournisseur est un petit serveur compatible OpenAI (`POST /chat/completions`)
 * qui **joue un scénario** : à chaque tour, il rend l'appel d'outil prévu pour
 * cette tâche. Rien d'autre n'est simulé — le daemon, la boucle, les outils,
 * Git, l'approbation et le redémarrage sont les vrais. C'est ce qui permet
 * d'éprouver le chemin complet du Developer sans réseau et sans dépenser un
 * centime ; `test:live` reste le seul à parler à un vrai modèle.
 *
 * Chaque scénario vérifie un effet **sur le disque ou en base**, jamais une
 * simple réponse : le fichier est sur la branche et pas dans le dépôt de
 * l'utilisateur, le marqueur de la commande existe ou n'existe pas, le worktree
 * survit au redémarrage.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  daemonJson,
  readRuntime,
  type HarnessConfig,
  type RuntimeInfo,
  type TaskEvent,
  type TaskView,
  type ExecAllowResponse,
  type TaskWorkspaceResponse,
  type WorkspacesResponse,
} from '@midgaard/contracts'
import { HarnessStore } from '@midgaard/persistence'
import { startFakeProvider, type Turn } from './fake-provider.ts'
import { childEnv, nodeArgsFor, scenario, summarize, tempHome, type Outcome } from './helpers.ts'

const outcomes: Outcome[] = []
const daemonArgs = nodeArgsFor('@midgaard/daemon/main')

// --- Dépôts et daemon --------------------------------------------------------

/** `git` pour préparer et inspecter les dépôts d'essai, sans dépendre de la machine. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Utilisateur', '-c', 'user.email=utilisateur@example.org', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/** Un dépôt d'utilisateur, avec un commit, et éventuellement du travail en cours. */
function makeRepo(name: string, dirty = false): string {
  const repo = join(scratch, name)
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(scratch, 'init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, 'README.md'), '# Projet\n\nUne API.\n')
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const routes = ["/"]\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'initial')
  if (dirty) writeFileSync(join(repo, 'src', 'en-cours.ts'), 'export {}\n')
  return repo
}

async function startDaemon(config: HarnessConfig, home: string): Promise<{ child: ChildProcess; rt: RuntimeInfo }> {
  const previous = readRuntime(config.runtimeFile)?.pid
  const child = spawn(process.execPath, daemonArgs, { env: childEnv(home), stdio: 'ignore' })
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

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return false
}

/** Délègue au Developer une tâche dont l'objectif porte l'étiquette de son scénario. */
async function delegate(rt: RuntimeInfo, tag: string, projectDir: string, script: Turn[]) {
  provider.scripts.set(tag, script)
  const res = await daemonJson<TaskView & { error?: string }>(rt, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      objective: `${tag} ajouter une route /health`,
      agent_id: 'developer',
      project_dir: projectDir,
      context: 'Le routeur est dans src/app.ts.',
    }),
  })
  if (res.status !== 200 && res.status !== 201) throw new Error(`délégation refusée : ${JSON.stringify(res.body)}`)
  return res.body.task
}

async function view(rt: RuntimeInfo, id: string): Promise<TaskView> {
  return (await daemonJson<TaskView>(rt, `/api/tasks/${id}`)).body
}

async function events(rt: RuntimeInfo, id: string): Promise<TaskEvent[]> {
  return (await daemonJson<{ events: TaskEvent[] }>(rt, `/api/tasks/${id}/events`)).body.events
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'interrupted'])

async function waitFor(rt: RuntimeInfo, id: string, statuses: Set<string>, ms = 20_000): Promise<TaskView> {
  let last = await view(rt, id)
  await until(async () => statuses.has((last = await view(rt, id)).task.status), ms)
  return last
}

const submit = (summary: string) => [{ tool: 'submit_result', args: { summary, details: 'détails' } }]

// ---------------------------------------------------------------------------

// `.native` partout où l'on compare à un chemin rendu par le harness : sous
// Windows, le dossier temporaire s'écrit `RUNNER~1` (nom court) et seul le
// `realpath` natif le développe, comme le fait le harness (CI, SLICE4 étape 5).
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-dev-repos-')))
const main = tempHome('developer')
const provider = await startFakeProvider()
let { child, rt } = await startDaemon(main.config, main.home)

const declared = await daemonJson<{ error?: string }>(rt, '/api/providers', {
  method: 'POST',
  body: JSON.stringify({ id: 'faux', preset: 'custom', base_url: provider.url, default_model: 'faux-1', api_key: 'sk-faux-0000' }),
})
if (declared.status !== 200 && declared.status !== 201) {
  console.error('déclaration du faux fournisseur refusée :', declared.body)
  process.exit(1)
}

console.log('Developer de bout en bout (faux fournisseur, vrai daemon, vrais dépôts)\n')

let v1TaskId = ''
let v3TaskId = ''
let v5TaskId = ''

await scenario(outcomes, 'V1 le travail est commité sur la branche, le dépôt de l\'utilisateur intact', async () => {
  const repo = makeRepo('v1')
  const headBefore = git(repo, 'rev-parse', 'HEAD').trim()
  const task = await delegate(rt, '[V1]', repo, [
    [{ tool: 'read_file', args: { path: 'src/app.ts' } }],
    [
      { tool: 'write_file', args: { path: 'src/health.ts', content: 'export const health = () => "ok"\n' } },
      { tool: 'edit_file', args: { path: 'src/app.ts', old_string: '["/"]', new_string: '["/", "/health"]' } },
    ],
    [{ tool: 'git_diff', args: { stat_only: true } }],
    submit('route /health ajoutée'),
  ])
  v1TaskId = task.id
  const done = await waitFor(rt, task.id, TERMINAL)
  const w = done.task.result?.workspace
  const types = (await events(rt, task.id)).map((e) => e.type)
  const problems: string[] = []
  if (done.task.status !== 'completed') problems.push(`statut ${done.task.status} — ${done.task.error}`)
  if (!w?.commit) problems.push('aucun commit dans le résultat')
  if (w && w.files_changed !== 2) problems.push(`${w.files_changed} fichier(s) au lieu de 2`)
  if (w && !w.branch.startsWith('midgaard/')) problems.push(`branche ${w.branch}`)
  if (existsSync(join(repo, 'src', 'health.ts'))) problems.push('fichier écrit dans le dépôt de l\'utilisateur')
  if (git(repo, 'status', '--porcelain') !== '') problems.push('dépôt de l\'utilisateur modifié')
  if (git(repo, 'rev-parse', 'HEAD').trim() !== headBefore) problems.push('HEAD de l\'utilisateur déplacé')
  if (w && !git(repo, 'show', `${w.branch}:src/health.ts`).includes('health')) problems.push('fichier absent de la branche')
  if (w && git(repo, 'log', '-1', '--format=%ae', w.branch).trim() !== 'developer@midgaard.invalid') problems.push('commit à la mauvaise identité')
  if (!types.includes('workspace.created') || !types.includes('workspace.kept')) problems.push(`événements ${types.join(',')}`)
  if (w && !existsSync(w.worktree_path)) problems.push('worktree retiré')
  if (w && !w.worktree_path.startsWith(realpathSync.native(main.home))) problems.push(`worktree hors de MIDGAARD_HOME : ${w.worktree_path}`)
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : `${w!.branch} @ ${w!.commit!.slice(0, 8)}, 2 fichiers, dépôt intact, worktree conservé`,
  }
})

await scenario(outcomes, 'V2 une commande attend l\'humain, montrée exacte, puis tourne dans le worktree', async () => {
  const repo = makeRepo('v2')
  const task = await delegate(rt, '[V2]', repo, [
    [{ tool: 'exec', args: { command: 'node', args: ['-e', "require('fs').writeFileSync('marqueur.txt', 'a tourné')"] } }],
    submit('commande lancée'),
  ])
  const paused = await waitFor(rt, task.id, new Set(['waiting_approval', ...TERMINAL]))
  const approval = paused.approval
  const detail = approval?.operation_detail as { program?: string; args?: string[]; cwd?: string } | null | undefined
  const problems: string[] = []
  if (paused.task.status !== 'waiting_approval' || !approval) {
    return { verdict: 'FAIL', detail: `pas de pause : ${paused.task.status} — ${paused.task.error}` }
  }
  if (!detail?.program?.startsWith('/') && !/^[A-Za-z]:/.test(detail?.program ?? '')) problems.push(`programme non résolu : ${detail?.program}`)
  if (!detail?.cwd?.includes(join('worktrees'))) problems.push(`dossier hors worktree : ${detail?.cwd}`)
  if (detail?.args?.[1] !== "require('fs').writeFileSync('marqueur.txt', 'a tourné')") problems.push('argv altéré')
  if (existsSync(join(repo, 'marqueur.txt'))) problems.push('a tourné avant l\'approbation, dans le dépôt')

  await daemonJson(rt, `/api/approvals/${approval.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })
  const done = await waitFor(rt, task.id, TERMINAL)
  const w = done.task.result?.workspace
  if (done.task.status !== 'completed') problems.push(`statut ${done.task.status} — ${done.task.error}`)
  if (w && !git(repo, 'show', `${w.branch}:marqueur.txt`).includes('a tourné')) problems.push('marqueur absent de la branche')
  if (existsSync(join(repo, 'marqueur.txt'))) problems.push('marqueur dans le dépôt de l\'utilisateur')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : `approuvée (${detail!.program}), exécutée dans le worktree, commitée`,
  }
})

await scenario(outcomes, 'V3 une tâche qui échoue ne laisse pas une branche qui a l\'air d\'un résultat', async () => {
  const repo = makeRepo('v3')
  const task = await delegate(rt, '[V3]', repo, [
    [{ tool: 'write_file', args: { path: 'src/moitie.ts', content: 'export const a =\n' } }],
    { text: 'je crois avoir fini' },
    { text: 'vraiment fini' },
  ])
  v3TaskId = task.id
  const done = await waitFor(rt, task.id, TERMINAL)
  const ws = (await events(rt, task.id)).find((e) => e.type === 'workspace.created')?.payload as
    | { branch: string; base_commit: string; worktree_path: string }
    | undefined
  const problems: string[] = []
  if (done.task.status !== 'failed') problems.push(`statut ${done.task.status}`)
  if (!ws) return { verdict: 'FAIL', detail: 'aucun worktree créé' }
  if (git(repo, 'rev-parse', ws.branch).trim() !== ws.base_commit) problems.push('la branche a avancé malgré l\'échec')
  if (!existsSync(join(ws.worktree_path, 'src', 'moitie.ts'))) problems.push('travail partiel perdu')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : 'échec, branche au commit de départ, travail partiel lisible dans le worktree',
  }
})

await scenario(outcomes, 'V4 le travail non commité de l\'utilisateur est annoncé, pas recopié', async () => {
  const repo = makeRepo('v4', true)
  const task = await delegate(rt, '[V4]', repo, [submit('rien à faire')])
  const done = await waitFor(rt, task.id, TERMINAL)
  const w = done.task.result?.workspace
  const problems: string[] = []
  if (w?.base_dirty !== 1) problems.push(`base_dirty ${w?.base_dirty}`)
  if (w?.commit !== null) problems.push('commit fait alors que rien n\'a changé')
  if (w && existsSync(join(w.worktree_path, 'src', 'en-cours.ts'))) problems.push('travail en cours recopié')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : '1 chemin non commité annoncé, absent du worktree, aucun commit vide',
  }
})

await scenario(outcomes, 'V5 un dossier hors dépôt Git échoue en disant pourquoi', async () => {
  const plain = join(scratch, 'pas-un-depot')
  mkdirSync(plain)
  const task = await delegate(rt, '[V5]', plain, [submit('jamais atteint')])
  v5TaskId = task.id
  const done = await waitFor(rt, task.id, TERMINAL)
  const ok = done.task.status === 'failed' && /pas dans un dépôt Git/.test(done.task.error ?? '')
  return { verdict: ok ? 'PASS' : 'FAIL', detail: `${done.task.status} — ${done.task.error}` }
})

await scenario(outcomes, 'V6 un redémarrage interrompt la tâche et conserve son worktree', async () => {
  const repo = makeRepo('v6')
  const task = await delegate(rt, '[V6]', repo, [
    [{ tool: 'write_file', args: { path: 'src/en-vol.ts', content: 'export {}\n' } }],
    [{ tool: 'exec', args: { command: 'node', args: ['-v'] } }],
    submit('jamais atteint'),
  ])
  const paused = await waitFor(rt, task.id, new Set(['waiting_approval', ...TERMINAL]))
  if (paused.task.status !== 'waiting_approval') return { verdict: 'FAIL', detail: `pas de pause : ${paused.task.status}` }
  const created = (await events(rt, task.id)).find((e) => e.type === 'workspace.created')?.payload as { worktree_path: string }

  child.kill('SIGKILL')
  await new Promise((r) => child.once('exit', r))
  ;({ child, rt } = await startDaemon(main.config, main.home))

  const after = await view(rt, task.id)
  const kept = (await events(rt, task.id)).find((e) => e.type === 'workspace.kept')
  const problems: string[] = []
  if (after.task.status !== 'interrupted') problems.push(`statut ${after.task.status}`)
  if (!kept || (kept.payload as { reason?: string }).reason !== 'daemon redémarré') problems.push('worktree non marqué conservé')
  if (!existsSync(join(created.worktree_path, 'src', 'en-vol.ts'))) problems.push('travail en vol perdu')
  // La branche ne bouge qu'à submit_result : une tâche interrompue la laisse
  // au commit de départ, jamais avec un commit qui aurait l'air d'un résultat.
  const branch = (created as unknown as { branch: string; base_commit: string })
  if (git(repo, 'rev-parse', branch.branch).trim() !== branch.base_commit) problems.push('branche déplacée par une tâche interrompue')
  // La pause en cours au moment du crash ne doit plus attendre personne : son
  // contexte est mort avec le processus, et l'approuver ne lancerait rien.
  // Lu en base, pas dans la vue : la vue d'une tâche interrompue ne montre plus
  // sa pause, mais `harness status` liste les approbations en attente de la base.
  const store = HarnessStore.openReadOnly(main.config)
  const stillPending = store.pendingApprovals().filter((a) => a.task_id === task.id).length
  const closed = paused.approval ? store.getApproval(paused.approval.id)?.status : undefined
  store.close()
  if (stillPending) problems.push('approbation encore « en attente » en base après le redémarrage')
  const late = paused.approval
    ? await daemonJson(rt, `/api/approvals/${paused.approval.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })
    : null
  if (late && late.status === 200) problems.push('approbation acceptée sur une tâche interrompue')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : `interrupted, workspace.kept « daemon redémarré », fichier en vol présent, branche au départ, approbation close (${closed}), approuver tard → ${late?.status}`,
  }
})

await scenario(outcomes, 'V7 le diff se lit par l\'API, et le résultat porte la branche et le commit', async () => {
  const problems: string[] = []
  const withDiff = (await daemonJson<TaskWorkspaceResponse>(rt, `/api/tasks/${v1TaskId}/workspace`)).body
  if (withDiff.diff?.files.length !== 2) problems.push(`diff : ${withDiff.diff?.files.length} fichier(s) — ${withDiff.unavailable}`)
  if (!withDiff.diff?.patch.includes('+export const health')) problems.push('patch sans le fichier créé')
  const without = (await daemonJson<TaskWorkspaceResponse>(rt, `/api/tasks/${v5TaskId}/workspace`)).body
  if (without.workspace !== null || !/pas de worktree/.test(without.unavailable ?? '')) problems.push('tâche sans worktree mal décrite')

  // Ce que l'orchestrateur et le dashboard lisent : le résultat de la tâche
  // porte la branche et le commit, et la branche existe dans le dépôt. (La
  // note de merge en anglais était composée par l'ancienne façade MCP.)
  const w = (await view(rt, v1TaskId)).task.result?.workspace
  if (!w?.branch || !w.commit) problems.push(`résultat sans branche ni commit : ${JSON.stringify(w)}`)
  else if (w.branch !== withDiff.workspace?.branch) problems.push(`branche du résultat ${w.branch} ≠ celle du worktree ${withDiff.workspace?.branch}`)
  if (w && w.files_changed !== 2) problems.push(`résultat : ${w.files_changed} fichier(s) au lieu de 2`)
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : `diff par l'API (2 fichiers), résultat sur ${w!.branch} (commit ${w!.commit!.slice(0, 12)})`,
  }
})

/** Le worktree d'une tâche, tel que `GET /api/workspaces` le liste. */
async function listing(taskId: string) {
  const body = (await daemonJson<WorkspacesResponse>(rt, '/api/workspaces')).body
  return { body, entry: body.workspaces.find((l) => l.workspace.task_id === taskId) }
}

async function removeWs(id: string, force = false) {
  return daemonJson<{ error?: string; reason?: string; outcome?: string }>(rt, `/api/workspaces/${id}/remove`, {
    method: 'POST',
    body: JSON.stringify({ force, by: 'test' }),
  })
}

await scenario(outcomes, 'V8 un retrait ne perd jamais rien sans qu\'on le demande', async () => {
  const problems: string[] = []
  // Un dossier que rien ne référence : il doit être montré, jamais retiré.
  const orphan = join(main.config.worktreesDir, 'depot-orphelin', 'abcd1234')
  mkdirSync(orphan, { recursive: true })

  const v1 = await listing(v1TaskId)
  const v3 = await listing(v3TaskId)
  if (!v1.entry || v1.entry.dirty !== 0 || v1.entry.task_status !== 'completed') problems.push(`V1 mal listé : ${JSON.stringify(v1.entry && { dirty: v1.entry.dirty, s: v1.entry.task_status })}`)
  if (!v3.entry || !(v3.entry.dirty! > 0)) problems.push('V3 devrait être listé avec du travail non commité')
  if (!v1.body.orphans.includes(realpathSync.native(orphan))) problems.push(`orphelin non signalé : ${v1.body.orphans.join(', ')}`)

  // Tâche en cours : jamais retirée sous l'agent.
  const repo = makeRepo('v8')
  const active = await delegate(rt, '[V8]', repo, [[{ tool: 'exec', args: { command: 'node', args: ['-v'] } }], submit('x')])
  await waitFor(rt, active.id, new Set(['waiting_approval', ...TERMINAL]))
  const activeWs = (await listing(active.id)).entry!
  const refusedActive = await removeWs(activeWs.workspace.id, true)
  if (refusedActive.status !== 409 || refusedActive.body.error !== 'task_active') problems.push(`tâche active retirée : ${refusedActive.status}`)
  await daemonJson(rt, `/api/tasks/${active.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'test' }) })

  // Travail non commité : refusé sans force, retiré avec, la branche reste.
  const w3 = v3.entry!.workspace
  const refusedDirty = await removeWs(w3.id)
  if (refusedDirty.status !== 409 || refusedDirty.body.error !== 'worktree_dirty') problems.push(`worktree sale retiré sans force : ${refusedDirty.status}`)
  if (!existsSync(w3.worktree_path)) problems.push('worktree sale supprimé malgré le refus')
  const forced = await removeWs(w3.id, true)
  if (forced.status !== 200) problems.push(`retrait forcé refusé : ${forced.body.reason}`)
  if (existsSync(w3.worktree_path)) problems.push('worktree forcé toujours présent')
  if (!git(w3.repo_dir, 'branch', '--list', w3.branch).includes(w3.branch)) problems.push('branche supprimée avec le worktree')
  if (!(await events(rt, v3TaskId)).some((e) => e.type === 'workspace.removed')) problems.push('aucun workspace.removed au journal')

  // Propre : retiré sans force.
  const clean = await removeWs(v1.entry!.workspace.id)
  if (clean.status !== 200) problems.push(`worktree propre refusé : ${clean.body.reason}`)
  if (!existsSync(orphan)) problems.push('orphelin supprimé')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : 'actif refusé, sale refusé puis forcé (branche gardée), propre retiré, orphelin montré et laissé',
  }
})

await scenario(outcomes, 'V9 la liste blanche d\'un dépôt dispense de l\'approbation l\'argv exact, et lui seul', async () => {
  const repo = makeRepo('v9')
  const script = "require('fs').writeFileSync('autorise.txt', 'sans approbation')"
  const problems: string[] = []
  const added = await daemonJson<ExecAllowResponse>(rt, '/api/exec-allow', {
    method: 'POST',
    // Un sous-dossier du dépôt : la liste est rangée sous la racine canonique.
    body: JSON.stringify({ project_dir: join(repo, 'src'), argv: ['node', '-e', script], by: 'test' }),
  })
  if (added.status !== 200 || added.body.repo_dir !== repo) problems.push(`ajout : ${added.status} ${added.body.repo_dir}`)
  const notRepo = await daemonJson(rt, '/api/exec-allow', {
    method: 'POST',
    body: JSON.stringify({ project_dir: join(scratch, 'pas-un-depot'), argv: ['make'] }),
  })
  if (notRepo.status !== 400) problems.push(`hors dépôt accepté : ${notRepo.status}`)

  const task = await delegate(rt, '[V9]', repo, [
    [{ tool: 'exec', args: { command: 'node', args: ['-e', script] } }],
    // Le même programme, un argument de plus : la liste ne le couvre plus.
    [{ tool: 'exec', args: { command: 'node', args: ['-e', script, 'en-plus'] } }],
    submit('fait'),
  ])
  const paused = await waitFor(rt, task.id, new Set(['waiting_approval', ...TERMINAL]))
  const requested = (await events(rt, task.id)).filter((e) => e.type === 'approval.requested')
  if (paused.task.status !== 'waiting_approval') problems.push(`l'argv élargi n'a pas demandé d'approbation : ${paused.task.status}`)
  if (requested.length !== 1) problems.push(`${requested.length} demande(s) au lieu d'une`)
  if (!String((paused.approval?.operation_detail as { args?: string[] })?.args?.at(-1)).includes('en-plus')) problems.push('la demande ne porte pas sur l\'argv élargi')
  await daemonJson(rt, `/api/approvals/${paused.approval!.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })
  const done = await waitFor(rt, task.id, TERMINAL)
  const w = done.task.result?.workspace
  if (!w || !git(repo, 'show', `${w.branch}:autorise.txt`).includes('sans approbation')) problems.push('la commande autorisée n\'a pas tourné')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : 'argv en liste lancé sans demande, argv élargi soumis à l\'humain, hors dépôt refusé',
  }
})

await scenario(outcomes, 'V10 la CLI liste, retire, et n\'ajoute rien à la liste blanche sans confirmation', async () => {
  const repo = makeRepo('v10')
  const cli = (...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      // Entrée standard fermée : c'est le cas d'un script, ou d'un agent qui
      // lancerait la CLI. Aucun terminal ne peut confirmer.
      const child = spawn(process.execPath, [...nodeArgsFor('@midgaard/cli/main'), ...args], {
        env: childEnv(main.home),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout!.on('data', (c) => (out += c))
      child.stderr!.on('data', (c) => (out += c))
      child.on('close', (code) => resolve({ code, out }))
    })
  const problems: string[] = []
  const list = await cli('workspaces')
  const v2 = (await daemonJson<WorkspacesResponse>(rt, '/api/workspaces')).body.workspaces.find((l) => l.workspace.status !== 'removed')
  if (list.code !== 0 || !v2 || !list.out.includes(v2.workspace.branch)) problems.push(`liste : ${list.code}`)
  if (!list.out.includes('depot-orphelin')) problems.push('orphelin absent de la liste')

  const unconfirmed = await cli('exec', 'allow', '--dir', repo, '--', 'node', '-v')
  if (unconfirmed.code === 0) problems.push('ajout accepté sans terminal ni --yes')
  if (!/sans approbation/.test(unconfirmed.out)) problems.push('avertissement absent')
  const after = (await daemonJson<ExecAllowResponse>(rt, `/api/exec-allow?project_dir=${encodeURIComponent(repo)}`)).body
  if (after.entries.length !== 0) problems.push('une entrée a été ajoutée malgré le refus')

  const confirmed = await cli('exec', 'allow', '--yes', '--dir', repo, '--', 'node', '-v')
  const listed = await cli('exec', 'list', '--dir', repo)
  const revoked = await cli('exec', 'revoke', '--dir', repo, '--', 'node', '-v')
  if (confirmed.code !== 0 || !listed.out.includes('node -v') || revoked.code !== 0) problems.push('allow --yes / list / revoke')
  if (v2) {
    const removed = await cli('workspaces', 'remove', v2.workspace.branch)
    if (removed.code !== 0 || !/la branche reste/.test(removed.out)) problems.push(`remove : ${removed.out.trim()}`)
  }

  // `clean` sans --force : les worktrees propres des tâches finies partent, le
  // worktree de V6 — tâche interrompue, fichier en vol non commité — reste.
  const v6 = (await daemonJson<WorkspacesResponse>(rt, '/api/workspaces')).body.workspaces.find(
    (l) => l.workspace.status !== 'removed' && l.dirty !== null && l.dirty > 0,
  )
  const cleaned = await cli('workspaces', 'clean')
  const left = (await daemonJson<WorkspacesResponse>(rt, '/api/workspaces')).body.workspaces.filter(
    (l) => l.workspace.status !== 'removed',
  )
  if (!v6) problems.push('aucun worktree sale pour éprouver clean')
  else if (left.length !== 1 || left[0]!.workspace.id !== v6.workspace.id) {
    problems.push(`clean a laissé ${left.map((l) => l.workspace.branch).join(', ') || 'rien'} au lieu du seul worktree sale`)
  }
  if (v6 && !existsSync(v6.workspace.worktree_path)) problems.push('clean a supprimé le worktree sale')
  if (!/non commité/.test(cleaned.out)) problems.push('clean ne dit pas pourquoi il laisse le worktree sale')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : 'liste, orphelin montré, ajout refusé sans confirmation, --yes/list/revoke, remove, clean laisse le sale',
  }
})

/** Vrai si un processus de ce pid existe encore (signal 0 : rien n'est envoyé). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

await scenario(outcomes, 'V12 un daemon tué en pleine commande n\'en laisse pas tourner une orpheline', async () => {
  // La commande écrit son pid, puis, trois secondes plus tard, un fichier : si
  // ce fichier apparaît après la mort du daemon, la commande lui a survécu et
  // a continué d'écrire dans le worktree sans que personne le voie.
  const repo = makeRepo('v12')
  const script = "const fs=require('fs');fs.writeFileSync('pid',String(process.pid));setTimeout(()=>fs.writeFileSync('apres-crash','x'),3000)"
  const task = await delegate(rt, '[V12]', repo, [
    [{ tool: 'exec', args: { command: 'node', args: ['-e', script], timeout_s: 30 } }],
    submit('jamais atteint'),
  ])
  const paused = await waitFor(rt, task.id, new Set(['waiting_approval', ...TERMINAL]))
  if (!paused.approval) return { verdict: 'FAIL', detail: `pas de pause : ${paused.task.status}` }
  const created = (await events(rt, task.id)).find((e) => e.type === 'workspace.created')?.payload as { worktree_path: string }
  await daemonJson(rt, `/api/approvals/${paused.approval.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })
  const pidFile = join(created.worktree_path, 'pid')
  if (!(await until(() => existsSync(pidFile), 10_000))) return { verdict: 'FAIL', detail: 'la commande n\'a pas démarré' }
  const pid = Number(readFileSync(pidFile, 'utf8'))

  child.kill('SIGKILL')
  await new Promise((r) => child.once('exit', r))
  ;({ child, rt } = await startDaemon(main.config, main.home))
  await sleep(4_000)

  const problems: string[] = []
  if (alive(pid)) {
    problems.push(`commande ${pid} encore vivante`)
    try {
      process.kill(pid, 'SIGKILL') // ne pas la laisser derrière le test
    } catch {}
  }
  if (existsSync(join(created.worktree_path, 'apres-crash'))) problems.push('la commande a écrit dans le worktree après la mort du daemon')
  if ((await view(rt, task.id)).task.status !== 'interrupted') problems.push('tâche non interrompue')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? problems.join(' ; ') : `commande ${pid} morte avec le daemon, rien écrit après`,
  }
})

await scenario(outcomes, 'V13 deux Developer sur le même dépôt, en même temps, ne se mélangent pas', async () => {
  const repo = makeRepo('v13')
  const headBefore = git(repo, 'rev-parse', 'HEAD').trim()
  const script = (name: string): Turn[] => [
    [{ tool: 'write_file', args: { path: `src/${name}.ts`, content: `export const ${name} = 1\n` } }],
    [{ tool: 'edit_file', args: { path: 'src/app.ts', old_string: '["/"]', new_string: `["/", "/${name}"]` } }],
    [{ tool: 'git_diff', args: { stat_only: true } }],
    submit(`${name} ajouté`),
  ]
  // Délégués ensemble : les deux `git worktree add` et les deux commits de fin
  // visent le même dépôt au même moment.
  const [a, b] = await Promise.all([delegate(rt, '[V13-a]', repo, script('alpha')), delegate(rt, '[V13-b]', repo, script('beta'))])
  const [da, db] = await Promise.all([waitFor(rt, a.id, TERMINAL), waitFor(rt, b.id, TERMINAL)])
  const problems: string[] = []
  for (const [done, mine, theirs] of [[da, 'alpha', 'beta'], [db, 'beta', 'alpha']] as const) {
    const w = done.task.result?.workspace
    if (done.task.status !== 'completed' || !w?.commit) {
      problems.push(`${mine} : ${done.task.status} — ${done.task.error}`)
      continue
    }
    const files = git(repo, 'diff', '--name-only', w.base_commit, w.branch).trim().split('\n').sort()
    if (files.join(',') !== ['src/app.ts', `src/${mine}.ts`].sort().join(',')) problems.push(`${mine} : fichiers ${files.join(',')}`)
    if (git(repo, 'show', `${w.branch}:src/app.ts`).includes(theirs)) problems.push(`${mine} contient le travail de ${theirs}`)
  }
  if (da.task.result?.workspace?.branch === db.task.result?.workspace?.branch) problems.push('même branche pour les deux')
  if (git(repo, 'rev-parse', 'HEAD').trim() !== headBefore || git(repo, 'status', '--porcelain') !== '') {
    problems.push('dépôt de l\'utilisateur modifié')
  }
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : `${da.task.result!.workspace!.branch} et ${db.task.result!.workspace!.branch}, chacune son seul travail, dépôt intact`,
  }
})

await scenario(outcomes, 'V11 un sous-module vide est annoncé, et rien ne s\'y écrit en silence', async () => {
  // Le lien de sous-module est posé dans l'index, sans réseau : `git worktree
  // add` laissera le dossier vide, comme pour un vrai sous-module.
  const repo = makeRepo('v11')
  const head = git(repo, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(repo, '.gitmodules'), '[submodule "lib"]\n\tpath = vendor/lib\n\turl = https://example.invalid/lib.git\n')
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${head},vendor/lib`)
  git(repo, 'add', '.gitmodules')
  git(repo, 'commit', '-q', '-m', 'sous-module')
  const task = await delegate(rt, '[V11]', repo, [
    [{ tool: 'write_file', args: { path: 'vendor/lib/health.ts', content: 'export {}\n' } }],
    [{ tool: 'write_file', args: { path: 'src/health.ts', content: 'export const health = 1\n' } }],
    submit('route ajoutée hors du sous-module'),
  ])
  const done = await waitFor(rt, task.id, TERMINAL)
  const w = done.task.result?.workspace
  const refusal = (await events(rt, task.id)).find(
    (e) => e.type === 'tool.completed' && /git submodule vendor\/lib/.test(String(e.payload.error ?? '')),
  )
  const created = (await events(rt, task.id)).find((e) => e.type === 'workspace.created')
  const system = provider.systems.get('[V11]') ?? ''
  const problems: string[] = []
  if (done.task.status !== 'completed') problems.push(`statut ${done.task.status} — ${done.task.error}`)
  if (JSON.stringify(w?.submodules) !== '["vendor/lib"]') problems.push(`résultat : submodules ${JSON.stringify(w?.submodules)}`)
  if (JSON.stringify(created?.payload.submodules) !== '["vendor/lib"]') problems.push('workspace.created sans les sous-modules')
  if (!/submodules are EMPTY directories in your workspace: vendor\/lib/.test(system)) problems.push('consigne de l\'agent muette')
  if (!refusal) problems.push('écriture dans le sous-module non refusée')
  if (w && existsSync(join(w.worktree_path, 'vendor', 'lib', 'health.ts'))) problems.push('fichier écrit dans le sous-module')
  if (w && w.files_changed !== 1) problems.push(`${w.files_changed} fichier(s) au lieu de 1`)
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : 'annoncé à l\'agent, dans le journal et le résultat ; écriture refusée, le reste commité',
  }
})

await scenario(outcomes, 'V14 un préfixe couvre la suite de l\'argv, un préfixe ouvert est refusé, un préfixe en base rejugé', async () => {
  const repo = makeRepo('v14')
  const problems: string[] = []
  const post = (argv: string[], prefix: boolean) =>
    daemonJson<ExecAllowResponse & { error?: string; reason?: string }>(rt, '/api/exec-allow', {
      method: 'POST',
      body: JSON.stringify({ project_dir: repo, argv, prefix, by: 'test' }),
    })

  // La route rejuge, même sans la CLI : `python -c` en préfixe, c'est tout code.
  const open = await post(['python', '-c'], true)
  if (open.status !== 400 || open.body.error !== 'prefix_refused' || !/module nommé/.test(open.body.reason ?? '')) {
    problems.push(`préfixe python -c : ${open.status} ${open.body.error}`)
  }
  const added = await post(['git', 'rev-parse'], true)
  if (added.status !== 200 || added.body.outcome !== 'added') problems.push(`préfixe git rev-parse : ${added.status} ${added.body.outcome}`)
  if (added.body.entries?.length !== 1 || !added.body.entries[0]!.prefix) problems.push('entrée absente, ou pas en préfixe')

  // Un préfixe que la règle refuse, glissé en base comme s'il datait d'avant
  // un durcissement : le moteur doit l'écarter au départ, pas l'appliquer.
  const direct = HarnessStore.open(main.config)
  try {
    direct.addExecAllow(repo, ['node', '-e'], 'ancien', true)
  } finally {
    direct.close()
  }

  const script = "require('fs').writeFileSync('approuve.txt', 'par un humain')"
  const task = await delegate(rt, '[V14]', repo, [
    [{ tool: 'exec', args: { command: 'git', args: ['rev-parse', 'HEAD'] } }],
    // Un argument différent derrière le même préfixe : toujours sans humain.
    [{ tool: 'exec', args: { command: 'git', args: ['rev-parse', '--show-toplevel'] } }],
    [{ tool: 'exec', args: { command: 'node', args: ['-e', script] } }],
    submit('fait'),
  ])
  const paused = await waitFor(rt, task.id, new Set(['waiting_approval', ...TERMINAL]))
  const log = await events(rt, task.id)
  const requested = log.filter((e) => e.type === 'approval.requested')
  const freed = log.filter(
    (e) => e.type === 'tool.requested' && e.payload.decision === 'allow' && /préfixe « git rev-parse … »/.test(String(e.payload.allow_reason)),
  )
  if (paused.task.status !== 'waiting_approval') problems.push(`node -e n'a pas attendu d'humain : ${paused.task.status}`)
  if (requested.length !== 1) problems.push(`${requested.length} demande(s) au lieu d'une`)
  if (freed.length !== 2) problems.push(`${freed.length} appel(s) git rev-parse passés par le préfixe au lieu de 2`)
  if (!log.some((e) => e.type === 'agent.message' && /préfixe exec écarté.*node -e/.test(String(e.payload.message)))) {
    problems.push('le préfixe écarté n\'est pas dit à la timeline')
  }
  if (paused.approval) {
    await daemonJson(rt, `/api/approvals/${paused.approval.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })
  }
  const done = await waitFor(rt, task.id, TERMINAL)
  const w = done.task.result?.workspace
  if (!w || !git(repo, 'show', `${w.branch}:approuve.txt`).includes('par un humain')) problems.push('la commande approuvée n\'a pas tourné')

  // La CLI refuse avant de demander confirmation, et la liste dit l'écarté.
  const cli = (...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [...nodeArgsFor('@midgaard/cli/main'), ...args], {
        env: childEnv(main.home),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout!.on('data', (c) => (out += c))
      child.stderr!.on('data', (c) => (out += c))
      child.on('close', (code) => resolve({ code, out }))
    })
  const refused = await cli('exec', 'allow', '--yes', '--prefix', '--dir', repo, '--', 'bash', 'run.sh')
  if (refused.code === 0 || !/préfixe refusé.*shell/.test(refused.out)) problems.push(`CLI bash en préfixe : ${refused.out.trim()}`)
  if (/sans approbation/.test(refused.out)) problems.push('la CLI a averti avant de refuser')
  const listed = await cli('exec', 'list', '--dir', repo)
  if (!/git rev-parse …/.test(listed.out) || !/node -e …[\s\S]*écarté au départ/.test(listed.out)) {
    problems.push(`liste : ${listed.out.trim()}`)
  }
  const after = (await daemonJson<ExecAllowResponse>(rt, `/api/exec-allow?project_dir=${encodeURIComponent(repo)}`)).body
  if (after.entries.length !== 2) problems.push(`${after.entries.length} entrée(s) au lieu de 2 : un refus a ajouté quelque chose`)
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : 'git rev-parse … libre sur deux argv, python -c et bash refusés (route et CLI), node -e en base écarté et soumis à l\'humain',
  }
})

// --- Démontage ---------------------------------------------------------------

await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r(null)))
provider.server.close()
main.cleanup()
rmSync(scratch, { recursive: true, force: true })
process.exit(summarize(outcomes, 'Developer de bout en bout'))
