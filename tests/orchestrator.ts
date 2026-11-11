/**
 * @file L'orchestrateur de bout en bout (Slice 5, étape 6) : `npm run
 * test:orchestrator`. Un vrai daemon, de vrais dépôts Git, un faux fournisseur.
 *
 * Le fournisseur joue un scénario par étiquette (`tests/fake-provider.ts`), et
 * reprend l'identifiant des sous-tâches qu'il vient de déléguer
 * (`{{task_id:N}}`) — c'est ce qui permet à un orchestrateur scripté
 * d'attendre. Rien d'autre n'est simulé : le daemon, la boucle, le port de
 * délégation, les worktrees, les approbations et le redémarrage sont les vrais.
 *
 * Chaque scénario vérifie un effet **en base**, lue directement, pas ce qu'un
 * client en voit : c'est ainsi qu'un bug de verrou était passé inaperçu
 * (Slice 1), et c'est ce que `docs/SLICE5.md` demande à l'étape 3.
 *
 *  - O1 délégation **en parallèle**, et l'approbation d'un enfant attend
 *       l'humain : l'orchestrateur attend avec elle, sans rien approuver, et
 *       l'attente ne lui coûte aucune étape ;
 *  - O2 annuler l'orchestrateur annule **toutes** ses sous-tâches actives,
 *       pauses d'approbation comprises : aucune tâche active en base ;
 *  - O3 un daemon tué net (`SIGKILL`) laisse un arbre entièrement
 *       `interrupted` au redémarrage — jamais repris, approbations expirées ;
 *  - O4 ni profondeur 2, ni limite relevée : déléguer à un orchestrateur est
 *       refusé, et une délégation qui demande plus que le profil reçoit le profil ;
 *  - O5 une **conversation** pilote une **revue**, de bout en bout par l'API
 *       (Slice 6) : l'orchestrateur délègue, demande l'avis de l'utilisateur,
 *       renvoie la proposition, l'accepte au second passage, puis conclut quand
 *       on le lui demande. Un seul commit, qui contient les deux passes ;
 *  - O6 un daemon tué net pendant que **tout l'arbre attend** — l'orchestrateur
 *       l'utilisateur, le Developer son verdict : au redémarrage, tout est
 *       `interrupted`, rien n'a été commité, rien n'attend plus, et un message de
 *       l'utilisateur est refusé.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  daemonJson,
  readRuntime,
  type Agent,
  type Approval,
  type HarnessConfig,
  type RuntimeInfo,
  type Task,
  type TaskEvent,
  type TaskView,
  type ToolCall,
} from '@midgaard/contracts'
import { HarnessStore } from '@midgaard/persistence'
import { startFakeProvider, type Turn } from './fake-provider.ts'
import { childEnv, nodeArgsFor, scenario, summarize, tempHome, type Outcome } from './helpers.ts'

const outcomes: Outcome[] = []
const daemonArgs = nodeArgsFor('@midgaard/daemon/main')
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'interrupted'])

// --- Dépôts, daemon, lecture ---------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Utilisateur', '-c', 'user.email=utilisateur@example.org', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/** Un dépôt d'utilisateur avec un commit : le Developer enfant y crée son worktree. */
function makeRepo(name: string): string {
  const repo = join(scratch, name)
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(scratch, 'init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, 'README.md'), '# Projet\n\nUne API.\n')
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const routes = ["/"]\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'initial')
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

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return false
}

/**
 * Lance un orchestrateur sur un dépôt, comme le formulaire du dashboard : par
 * `POST /api/tasks`, avec un dossier de projet tapé — le daemon le vérifie.
 */
async function orchestrate(tag: string, repo: string, script: Turn[]): Promise<Task> {
  provider.scripts.set(tag, script)
  const res = await daemonJson<TaskView & { error?: string }>(rt, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ objective: `${tag} orchestre`, agent_id: 'orchestrator', project_dir: repo }),
  })
  if (res.status !== 201) throw new Error(`orchestrateur refusé : ${JSON.stringify(res.body)}`)
  return res.body.task
}

async function task(id: string): Promise<Task> {
  return (await daemonJson<TaskView>(rt, `/api/tasks/${id}`)).body.task
}

async function events(id: string): Promise<TaskEvent[]> {
  return (await daemonJson<{ events: TaskEvent[] }>(rt, `/api/tasks/${id}/events`)).body.events
}

async function toolCalls(id: string): Promise<ToolCall[]> {
  return (await daemonJson<{ tool_calls: ToolCall[] }>(rt, `/api/tasks/${id}/tools`)).body.tool_calls
}

async function approvals(): Promise<Approval[]> {
  return (await daemonJson<{ approvals: Approval[] }>(rt, '/api/approvals')).body.approvals
}

/**
 * Les sous-tâches d'un parent, **lues dans la base**, sur une connexion en
 * lecture seule : la vérité, indépendante de ce que l'API en dit.
 */
function childrenInDb(parentId: string, filter: { active?: boolean } = {}): Task[] {
  const store = HarnessStore.openReadOnly(main.config)
  try {
    return store.childTasks(parentId, filter)
  } finally {
    store.close()
  }
}

/**
 * Le worktree d'une sous-tâche Developer, d'après son `workspace.created` :
 * c'est là, et pas dans le dépôt de l'utilisateur, qu'une commande écrirait.
 */
async function worktreeOf(taskId: string): Promise<string | null> {
  const created = (await events(taskId)).find((e) => e.type === 'workspace.created')
  return (created?.payload as { worktree_path?: string } | undefined)?.worktree_path ?? null
}

/** Une commande qui attend l'humain : le Developer enfant reste en pause tant qu'on ne décide pas. */
const execTurn = (marker: string): Turn => [
  { tool: 'exec', args: { command: 'node', args: ['-e', `require('fs').writeFileSync('${marker}','x')`] } },
]
const submit = (summary: string): Turn => [{ tool: 'submit_result', args: { summary, details: 'détails' } }]

// --- Mise en place -------------------------------------------------------------

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-orch-repos-')))
const main = tempHome('orchestrator')
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

console.log('Orchestrateur de bout en bout (faux fournisseur, vrai daemon, vrais dépôts)\n')

// --- O1 ----------------------------------------------------------------------

await scenario(outcomes, 'O1 délégation parallèle ; l\'approbation d\'un enfant attend l\'humain, et l\'orchestrateur avec elle', async () => {
  const repo = makeRepo('o1')
  provider.scripts.set('[O1-dev]', [execTurn('fait'), submit('marqueur écrit')])
  provider.scripts.set('[O1-res]', [submit('le README parle d\'une API')])
  const parent = await orchestrate('[O1]', repo, [
    // Les deux délégations dans la même étape : c'est ce que la consigne demande.
    [
      { tool: 'delegate_task', args: { agent_id: 'developer', objective: '[O1-dev] écris un marqueur' } },
      { tool: 'delegate_task', args: { agent_id: 'researcher', objective: '[O1-res] lis le README' } },
    ],
    [{ tool: 'wait_for_task', args: { task_id: '{{task_id:1}}' } }],
    [{ tool: 'wait_for_task', args: { task_id: '{{task_id:0}}' } }],
    // Le Developer propose (Slice 6) : rien n'est commité avant l'acceptation.
    [{ tool: 'accept_result', args: { task_id: '{{task_id:0}}' } }],
    submit('synthèse'),
  ])

  const problems: string[] = []
  let dev: Task | undefined
  let res: Task | undefined
  const both = await until(async () => {
    const kids = childrenInDb(parent.id)
    dev = kids.find((k) => k.agent_id === 'developer')
    res = kids.find((k) => k.agent_id === 'researcher')
    return dev?.status === 'waiting_approval' && res?.status === 'completed'
  })
  if (!both || !dev || !res) {
    return { verdict: 'FAIL', detail: `enfants : ${childrenInDb(parent.id).map((k) => `${k.agent_id}=${k.status}`).join(', ')}` }
  }

  // Parallèle : le Researcher a fini pendant que le Developer attendait l'humain.
  const delegations = (await toolCalls(parent.id)).filter((c) => c.name === 'delegate_task')
  if (new Set(delegations.map((c) => c.step)).size !== 1) problems.push('les deux délégations ne sont pas de la même étape')

  // L'orchestrateur attend le Developer, sans rien approuver, et le dit.
  if (!(await until(async () => (await events(parent.id)).some((e) => e.type === 'subtask.waiting' && e.payload.task_id === dev!.id), 5000))) {
    problems.push('aucun subtask.waiting désignant le Developer')
  }
  await sleep(1500)
  const stillWaiting = await task(parent.id)
  if (stillWaiting.status !== 'running') problems.push(`orchestrateur ${stillWaiting.status} pendant la pause de son enfant`)
  const pending = await approvals()
  if (pending.some((a) => a.task_id === parent.id)) problems.push('une approbation a été demandée au nom de l\'orchestrateur')
  const devApproval = pending.find((a) => a.task_id === dev!.id)
  if (!devApproval) return { verdict: 'FAIL', detail: [...problems, 'aucune approbation pour le Developer'].join(' ; ') }

  // L'humain décide ; tout l'arbre se termine.
  await daemonJson(rt, `/api/approvals/${devApproval.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })
  if (!(await until(async () => TERMINAL.has((await task(parent.id)).status)))) problems.push('orchestrateur jamais terminé')
  const done = await task(parent.id)
  const devDone = await task(dev.id)
  if (done.status !== 'completed') problems.push(`orchestrateur ${done.status} — ${done.error}`)
  if (devDone.status !== 'completed') problems.push(`Developer ${devDone.status} — ${devDone.error}`)
  const branch = devDone.result?.workspace?.branch
  if (!branch) problems.push('aucune branche pour le Developer')
  else if (!git(repo, 'ls-tree', '--name-only', branch).split('\n').includes('fait')) {
    problems.push('le marqueur de la commande approuvée n\'est pas sur la branche')
  }
  // Attendre ne coûte pas d'étape : cinq tours scriptés, cinq appels de modèle.
  if (done.usage.model_calls !== 5) problems.push(`${done.usage.model_calls} appels de modèle pour 5 tours`)
  if (done.result?.untrusted !== true) problems.push('le résultat de l\'orchestrateur n\'est pas marqué non fiable')
  // Chaque tâche de l'arbre a démarré avant de finir, et aucun enfant avant son
  // parent. Lu en base pour les enfants : `started_at` a longtemps été transmis
  // sans jamais être écrit.
  for (const t of [done, ...childrenInDb(parent.id)]) {
    if (!t.started_at) problems.push(`${t.agent_id} sans started_at`)
    else if (t.ended_at && t.started_at > t.ended_at) problems.push(`${t.agent_id} finie avant d'avoir démarré`)
    else if (t.id !== done.id && done.started_at && t.started_at < done.started_at) problems.push(`${t.agent_id} démarrée avant son parent`)
  }
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : `Researcher fini pendant la pause du Developer ; orchestrateur en attente sans approbation à son nom ; proposition acceptée ; 5 appels de modèle ; branche ${branch}`,
  }
})

// --- O2 ----------------------------------------------------------------------

await scenario(outcomes, 'O2 annuler l\'orchestrateur annule toutes ses sous-tâches actives', async () => {
  const repo = makeRepo('o2')
  provider.scripts.set('[O2-a]', [execTurn('a'), submit('jamais')])
  provider.scripts.set('[O2-b]', [execTurn('b'), submit('jamais')])
  const parent = await orchestrate('[O2]', repo, [
    [
      { tool: 'delegate_task', args: { agent_id: 'developer', objective: '[O2-a] première' } },
      { tool: 'delegate_task', args: { agent_id: 'developer', objective: '[O2-b] seconde' } },
    ],
    [{ tool: 'wait_for_task', args: { task_id: '{{task_id:0}}' } }],
    submit('jamais atteint'),
  ])
  const paused = await until(() => {
    const kids = childrenInDb(parent.id)
    return kids.length === 2 && kids.every((k) => k.status === 'waiting_approval')
  })
  if (!paused) {
    return { verdict: 'FAIL', detail: `enfants : ${childrenInDb(parent.id).map((k) => `${k.agent_id}=${k.status}`).join(', ')}` }
  }
  const before = childrenInDb(parent.id, { active: true }).length

  // Comme le bouton « Annuler » du dashboard.
  await daemonJson(rt, `/api/tasks/${parent.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'test' }) })
  const ended = await until(async () => TERMINAL.has((await task(parent.id)).status) && childrenInDb(parent.id, { active: true }).length === 0)

  const problems: string[] = []
  if (!ended) problems.push(`encore actives en base : ${childrenInDb(parent.id, { active: true }).length}`)
  const kids = childrenInDb(parent.id)
  for (const k of kids) {
    if (k.status !== 'cancelled') problems.push(`${k.id.slice(0, 8)} ${k.status}`)
    else if (k.error !== 'tâche parente annulée') problems.push(`motif : « ${k.error} »`)
  }
  if ((await approvals()).some((a) => kids.some((k) => k.id === a.task_id))) problems.push('une approbation reste en attente')
  // Deux créations dans la même milliseconde n'ont pas d'ordre sûr : chaque
  // worktree est cherché pour les deux marqueurs.
  for (const k of kids) {
    const worktree = await worktreeOf(k.id)
    if (!worktree) problems.push(`aucun worktree pour ${k.id.slice(0, 8)}`)
    else for (const marker of ['a', 'b']) {
      if (existsSync(join(worktree, marker))) problems.push(`commande « ${marker} » lancée malgré l'annulation`)
    }
  }
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : `${before} sous-tâches en pause → 0 active en base, toutes « tâche parente annulée », aucune approbation pendante`,
  }
})

// --- O3 ----------------------------------------------------------------------

await scenario(outcomes, 'O3 un daemon tué net laisse un arbre entièrement interrompu', async () => {
  const repo = makeRepo('o3')
  provider.scripts.set('[O3-dev]', [execTurn('apres'), submit('jamais')])
  const parent = await orchestrate('[O3]', repo, [
    [{ tool: 'delegate_task', args: { agent_id: 'developer', objective: '[O3-dev] attend l\'humain' } }],
    [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
    submit('jamais atteint'),
  ])
  const waiting = await until(async () => {
    const kids = childrenInDb(parent.id)
    return kids[0]?.status === 'waiting_approval' && (await events(parent.id)).some((e) => e.type === 'subtask.waiting')
  })
  if (!waiting) return { verdict: 'FAIL', detail: 'l\'arbre n\'a jamais atteint la pause attendue' }
  const devId = childrenInDb(parent.id)[0]!.id

  child.kill('SIGKILL')
  await new Promise((r) => child.once('exit', r))
  ;({ child, rt } = await startDaemon(main.config, main.home))
  // Le temps qu'une reprise fautive aurait pour se manifester.
  await sleep(2000)

  const problems: string[] = []
  const after = await task(parent.id)
  const dev = await task(devId)
  if (after.status !== 'interrupted') problems.push(`orchestrateur ${after.status}`)
  if (dev.status !== 'interrupted') problems.push(`Developer ${dev.status}`)
  if (childrenInDb(parent.id, { active: true }).length !== 0) problems.push('sous-tâche active en base après redémarrage')
  if ((await approvals()).some((a) => a.task_id === devId)) problems.push('l\'approbation du Developer reste en attente')
  const worktree = await worktreeOf(devId)
  if (!worktree) problems.push('aucun worktree pour le Developer')
  else {
    if (!existsSync(worktree)) problems.push('worktree effacé : il devait être conservé')
    if (existsSync(join(worktree, 'apres'))) problems.push('la commande a tourné')
  }
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : 'orchestrateur et Developer interrupted, 0 active en base, approbation expirée, worktree conservé, rien repris',
  }
})

// --- O4 ----------------------------------------------------------------------

await scenario(outcomes, 'O4 ni profondeur 2, ni limite relevée par une délégation', async () => {
  const repo = makeRepo('o4')
  provider.scripts.set('[O4-res]', [submit('lu')])
  const parent = await orchestrate('[O4]', repo, [
    [
      { tool: 'delegate_task', args: { agent_id: 'orchestrator', objective: '[O4-x] sous-orchestre' } },
      {
        tool: 'delegate_task',
        args: {
          agent_id: 'researcher',
          objective: '[O4-res] lis',
          limits: { max_cost_usd: 1000, max_steps: 100, timeout_s: 3600 },
        },
      },
    ],
    [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
    submit('fini'),
  ])
  await until(async () => TERMINAL.has((await task(parent.id)).status))

  const problems: string[] = []
  const done = await task(parent.id)
  if (done.status !== 'completed') problems.push(`orchestrateur ${done.status} — ${done.error}`)
  const refused = (await toolCalls(parent.id)).find((c) => c.name === 'delegate_task' && c.status === 'failed')
  if (!refused || !/orchestrator profile/.test(refused.error ?? '')) problems.push(`délégation à un orchestrateur : ${refused?.error ?? 'pas refusée'}`)
  const kids = childrenInDb(parent.id)
  if (kids.length !== 1 || kids[0]!.agent_id !== 'researcher') problems.push(`enfants : ${kids.map((k) => k.agent_id).join(', ')}`)
  const profile = (await daemonJson<{ agent: Agent }>(rt, '/api/agents/researcher')).body.agent
  if (kids[0] && JSON.stringify(kids[0].limits) !== JSON.stringify(profile.limits)) {
    problems.push(`limites de l'enfant ${JSON.stringify(kids[0].limits)} au lieu de celles du profil`)
  }
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : `délégation à « orchestrator » refusée ; 1 000 $ demandés, ${profile.limits.max_cost_usd} $ appliqués (plafond du profil)`,
  }
})

// --- O5 ----------------------------------------------------------------------

/** Ouvre une conversation avec l'orchestrateur, comme le formulaire du dashboard. */
async function converse(tag: string, repo: string, script: Turn[]): Promise<Task> {
  provider.scripts.set(tag, script)
  const res = await daemonJson<TaskView & { error?: string }>(rt, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ objective: `${tag} aide-moi`, agent_id: 'orchestrator', project_dir: repo, conversation: true }),
  })
  if (res.status !== 201) throw new Error(`conversation refusée : ${JSON.stringify(res.body)}`)
  return res.body.task
}

/** Écrit à une conversation, comme la saisie du dashboard. */
async function say(id: string, text: string, conclude = false): Promise<number> {
  const res = await daemonJson(rt, `/api/tasks/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text, conclude, by: 'test' }),
  })
  return res.status
}

/** Une tâche lue en base, sur une connexion en lecture seule. */
function inDb(id: string): Task | null {
  const store = HarnessStore.openReadOnly(main.config)
  try {
    return store.getTask(id)
  } finally {
    store.close()
  }
}

await scenario(outcomes, 'O5 une conversation pilote la revue d\'un Developer, de bout en bout', async () => {
  const repo = makeRepo('o5')
  provider.scripts.set('[O5-dev]', [
    [{ tool: 'write_file', args: { path: 'src/health.ts', content: 'export const health = () => "ok"\n' } }],
    submit('route ajoutée'),
    [{ tool: 'write_file', args: { path: 'src/health.test.ts', content: 'import "./health.ts"\n' } }],
    submit('route et test ajoutés'),
  ])
  const parent = await converse('[O5]', repo, [
    [{ tool: 'delegate_task', args: { agent_id: 'developer', objective: '[O5-dev] ajoute /health' } }],
    [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
    { text: 'Le Developer propose la route sans test. Je l\'accepte ?' },
    [{ tool: 'send_message', args: { task_id: '{{task_id}}', message: 'Ajoute un test.' } }],
    [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
    [{ tool: 'accept_result', args: { task_id: '{{task_id}}' } }],
    { text: 'C\'est commité sur sa branche.' },
    submit('route et test sur la branche du Developer'),
  ])

  const problems: string[] = []
  const awaitsUser = () => inDb(parent.id)?.status === 'waiting_input' && inDb(parent.id)?.awaiting_input === 'chat'
  if (!(await until(awaitsUser))) return { verdict: 'FAIL', detail: `pas d'attente de l'utilisateur : ${inDb(parent.id)?.status}` }
  const [dev] = childrenInDb(parent.id)
  if (dev?.status !== 'waiting_input' || dev.awaiting_input !== 'proposal') {
    problems.push(`Developer ${dev?.status}/${dev?.awaiting_input} pendant que l'orchestrateur attend`)
  }
  if ((await say(parent.id, 'Non, demande-lui un test.')) !== 200) problems.push('premier message refusé')
  if (!(await until(awaitsUser))) return { verdict: 'FAIL', detail: [...problems, 'seconde attente jamais atteinte'].join(' ; ') }
  if ((await say(parent.id, '', true)) !== 200) problems.push('« conclure » refusé')
  if (!(await until(async () => TERMINAL.has((await task(parent.id)).status)))) problems.push('conversation jamais conclue')

  const done = await task(parent.id)
  const child = await task(dev!.id)
  if (done.status !== 'completed') problems.push(`orchestrateur ${done.status} — ${done.error}`)
  if (child.status !== 'completed') problems.push(`Developer ${child.status} — ${child.error}`)
  const branch = child.result?.workspace?.branch
  if (!branch) problems.push('aucune branche')
  else {
    const commits = git(repo, 'rev-list', '--count', `main..${branch}`).trim()
    const files = git(repo, 'diff', '--name-only', 'main', branch).trim().split('\n').sort()
    if (commits !== '1') problems.push(`${commits} commit(s) sur ${branch}, un seul attendu`)
    if (files.join(',') !== 'src/health.test.ts,src/health.ts') problems.push(`fichiers commités : ${files.join(', ')}`)
  }
  const said = (await events(parent.id)).filter((e) => e.type === 'message.user')
  if (said.length !== 2 || said[1]!.payload.conclude !== true) problems.push(`${said.length} message(s) de l'utilisateur au journal`)
  const exchange = (await events(dev!.id)).filter((e) => e.type === 'input.requested' || e.type === 'message.agent')
  const shape = exchange.map((e) => (e.type === 'input.requested' ? 'proposition' : e.payload.verdict === 'accepted' ? 'accepte' : 'renvoi'))
  if (shape.join(',') !== 'proposition,renvoi,proposition,accepte') problems.push(`échange : ${shape.join(', ')}`)
  if (childrenInDb(parent.id, { active: true }).length !== 0) problems.push('sous-tâche active en base')
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : `deux tours de conversation, proposition renvoyée puis acceptée, 1 commit (2 fichiers) sur ${branch}, 0 active`,
  }
})

// --- O6 ----------------------------------------------------------------------

await scenario(outcomes, 'O6 un daemon tué net pendant que tout l\'arbre attend ne reprend rien', async () => {
  const repo = makeRepo('o6')
  provider.scripts.set('[O6-dev]', [
    [{ tool: 'write_file', args: { path: 'src/x.ts', content: 'export const x = 1\n' } }],
    submit('x ajouté'),
  ])
  const parent = await converse('[O6]', repo, [
    [{ tool: 'delegate_task', args: { agent_id: 'developer', objective: '[O6-dev] propose' } }],
    [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
    { text: 'Je l\'accepte ?' },
  ])
  const bothWait = await until(() => {
    const kid = childrenInDb(parent.id)[0]
    return inDb(parent.id)?.awaiting_input === 'chat' && kid?.awaiting_input === 'proposal'
  })
  if (!bothWait) return { verdict: 'FAIL', detail: 'l\'arbre n\'a jamais attendu en entier' }
  const devId = childrenInDb(parent.id)[0]!.id

  child.kill('SIGKILL')
  await new Promise((r) => child.once('exit', r))
  ;({ child, rt } = await startDaemon(main.config, main.home))
  await sleep(2000)

  const problems: string[] = []
  for (const [label, id] of [['orchestrateur', parent.id], ['Developer', devId]] as const) {
    const t = inDb(id)
    if (t?.status !== 'interrupted') problems.push(`${label} ${t?.status}`)
    if (t?.awaiting_input !== null) problems.push(`${label} attend encore (${t?.awaiting_input})`)
  }
  if (childrenInDb(parent.id, { active: true }).length !== 0) problems.push('sous-tâche active en base')
  const worktree = await worktreeOf(devId)
  if (!worktree || !existsSync(worktree)) problems.push('worktree effacé : il devait être conservé')
  else if (!existsSync(join(worktree, 'src', 'x.ts'))) problems.push('le travail non commité a disparu du worktree')
  const ws = (await daemonJson<{ workspace: { branch: string } | null }>(rt, `/api/tasks/${devId}/workspace`)).body.workspace
  if (ws && git(repo, 'rev-parse', ws.branch).trim() !== git(repo, 'rev-parse', 'main').trim()) {
    problems.push('la branche a bougé : une proposition non acceptée a été commitée')
  }
  const late = await say(parent.id, 'je suis revenu')
  if (late !== 409) problems.push(`message à une conversation interrompue : HTTP ${late}`)
  return {
    verdict: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' ; ')
      : 'orchestrateur et Developer interrupted, plus rien n\'attend, 0 active, branche au départ, travail lisible, message refusé (409)',
  }
})

// --- Démontage ---------------------------------------------------------------

await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r(null)))
provider.server.close()
main.cleanup()
rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
process.exit(summarize(outcomes, 'Orchestrateur de bout en bout'))
