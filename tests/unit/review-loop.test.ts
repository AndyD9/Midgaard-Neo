/**
 * @file La boucle entre l'orchestrateur et ses sous-tâches (Slice 6, étape 3),
 * sur le **vrai moteur d'agent** : un daemon dans le processus de test, un faux
 * fournisseur compatible OpenAI, et un vrai dépôt Git pour les worktrees.
 *
 * Ce qui est prouvé, et que rien d'autre ne voit :
 *  - **revue et reprise** : la proposition d'un Developer est renvoyée une fois,
 *    il reprend dans le même worktree, puis elle est acceptée ;
 *  - **la branche ne bouge qu'à l'acceptation** : chaque fois que le Developer
 *    attend son verdict, sa branche est relue **au moment même** — elle est
 *    toujours au commit de départ ;
 *  - l'orchestrateur reçoit la proposition **avec son diff**, encadrée ;
 *  - **une question** (`ask_parent`) arrive à l'orchestrateur, et sa réponse à
 *    l'enfant, dans la même conversation. Seule une sous-tâche reçoit l'outil ;
 *  - un orchestrateur **ne conclut pas** tant qu'une sous-tâche attend ;
 *  - une sous-tâche qui attend est **emportée par la cascade**, sans commit :
 *    zéro tâche active en base.
 *
 * Les identifiants de sous-tâche n'existent pas quand les scénarios s'écrivent :
 * le faux fournisseur reprend le dernier `task_id` lu (`{{task_id}}`).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { loadConfig, type Task, type TaskStatus } from '@midgaard/contracts'
import { reconcileAgents, startDaemon, type Daemon } from '@midgaard/daemon'
import { startFakeProvider, type FakeProvider } from '../fake-provider.ts'

let home: string
let repo: string
let base: string
let daemon: Daemon
let provider: FakeProvider

/** `git` dans le dépôt de test, sans l'identité ni la signature de la machine. */
function git(...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=u', '-c', 'user.email=u@example.org', '-c', 'commit.gpgsign=false', ...args],
    { cwd: repo, encoding: 'utf8' },
  ).trim()
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'midgaard-review-'))
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-review-depot-')))
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), '# Projet\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  base = git('rev-parse', 'HEAD')
  provider = await startFakeProvider()
  const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
  // La clé passe par l'environnement injecté du daemon, pas par le coffre.
  daemon = (await startDaemon(config, {
    log: () => {},
    env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-revue' },
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

/** Lance un orchestrateur sur le dépôt de test. */
function orchestrate(objective: string, conversation = false): Task {
  const created = daemon.tasks.create({
    objective, agentId: 'orchestrator', context: null, projectDir: repo,
    durationS: 20, needsApproval: false, conversation,
  })
  assert.ok(!('error' in created), JSON.stringify(created))
  return created.task
}

/** Attend un statut en lisant la base. */
async function until(id: string, status: TaskStatus, ms = 15_000): Promise<Task> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const task = daemon.store.getTask(id)
    if (task?.status === status) return task
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.fail(`tâche ${id} : ${status} attendu, ${daemon.store.getTask(id)?.status} constaté`)
}

describe('revue et reprise', () => {
  it('renvoie une proposition, la reprend dans le même worktree, et ne commite qu\'à l\'acceptation', async () => {
    provider.scripts.set('[rev-orch]', [
      [{ tool: 'delegate_task', args: { agent_id: 'developer', objective: '[rev-dev] ajoute /health' } }],
      [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
      [{ tool: 'send_message', args: { task_id: '{{task_id}}', message: 'Ajoute aussi un test.' } }],
      [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
      [{ tool: 'accept_result', args: { task_id: '{{task_id}}' } }],
      [{ tool: 'submit_result', args: { summary: 'route et test sur la branche' } }],
    ])
    provider.scripts.set('[rev-dev]', [
      [{ tool: 'write_file', args: { path: 'src/health.ts', content: 'export const health = () => "ok"\n' } }],
      [{ tool: 'submit_result', args: { summary: 'route ajoutée' } }],
      [{ tool: 'write_file', args: { path: 'test/health.test.ts', content: 'import "../src/health.ts"\n' } }],
      [{ tool: 'submit_result', args: { summary: 'route et test ajoutés' } }],
    ])

    // La branche, relue **à l'instant** où le Developer attend son verdict.
    const branchWhileWaiting: string[] = []
    const unsubscribe = daemon.subscribe(({ task }) => {
      if (task.agent_id !== 'developer' || task.status !== 'waiting_input') return
      const ws = daemon.store.workspaceForTask(task.id)
      if (ws) branchWhileWaiting.push(git('rev-parse', ws.branch))
    })
    let parent: Task
    try {
      parent = orchestrate('[rev-orch] fais ajouter /health')
      const done = await daemon.tasks.wait(parent.id, 20_000, 0)
      assert.equal(done?.task.status, 'completed', done?.task.error ?? '')
    } finally {
      unsubscribe()
    }

    const [child] = daemon.store.childTasks(parent.id)
    assert.equal(child?.mode, 'review', 'un Developer délégué par un orchestrateur propose')
    assert.equal(child?.status, 'completed', child?.error ?? '')
    assert.deepEqual(branchWhileWaiting, [base, base], 'deux propositions, aucune commitée pendant la revue')

    const ws = daemon.store.workspaceForTask(child!.id)!
    assert.equal(git('rev-list', '--count', `${base}..${ws.branch}`), '1', 'un seul commit, à l\'acceptation')
    const files = git('diff', '--name-only', base, ws.branch).split('\n').sort()
    assert.deepEqual(files, ['src/health.ts', 'test/health.test.ts'], 'le même worktree, les deux passes')
    assert.equal(child!.result?.summary, 'route et test ajoutés')
    assert.equal(child!.result?.workspace?.branch, ws.branch)

    const events = daemon.store.taskEvents(child!.id)
    const asked = events.filter((e) => e.type === 'input.requested')
    assert.deepEqual(asked.map((e) => e.payload.request), ['proposal', 'proposal'])
    assert.equal(asked[0]!.payload.text, 'route ajoutée')
    const replies = events.filter((e) => e.type === 'message.agent')
    assert.equal(replies[0]!.payload.text, 'Ajoute aussi un test.')
    assert.equal(replies[0]!.payload.from_task_id, parent.id)
    assert.equal(replies[1]!.payload.verdict, 'accepted')

    // Ce que l'orchestrateur a lu de la première proposition : le diff, encadré.
    const read = provider.received.get('[rev-orch]') ?? []
    const review = read.find((m) => m.role === 'tool' && (m.content ?? '').includes('review_proposal'))
    assert.ok(review, 'wait_for_task a rendu la proposition')
    assert.match(review.content!, /<untrusted_data nonce=/)
    assert.match(review.content!, /src\/health\.ts/)
    // Et ce que le Developer a lu en retour, en réponse à son submit_result.
    const dev = provider.received.get('[rev-dev]') ?? []
    assert.ok(dev.some((m) => m.role === 'tool' && /sent it back[\s\S]*Ajoute aussi un test\./.test(m.content ?? '')))
  })
})

describe('question au parent', () => {
  it('rend la question à l\'orchestrateur et sa réponse à l\'enfant, dans la même conversation', async () => {
    provider.scripts.set('[ask-orch]', [
      [{ tool: 'delegate_task', args: { agent_id: 'researcher', objective: '[ask-child] trouve le port' } }],
      [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
      [{ tool: 'send_message', args: { task_id: '{{task_id}}', message: 'Le port 7777.' } }],
      [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
      [{ tool: 'submit_result', args: { summary: 'port trouvé' } }],
    ])
    provider.scripts.set('[ask-child]', [
      [{ tool: 'ask_parent', args: { question: 'Quel port faut-il viser ?' } }],
      [{ tool: 'submit_result', args: { summary: 'le port est 7777' } }],
    ])
    const parent = orchestrate('[ask-orch] trouve le port')
    const done = await daemon.tasks.wait(parent.id, 20_000, 0)
    assert.equal(done?.task.status, 'completed', done?.task.error ?? '')

    const [child] = daemon.store.childTasks(parent.id)
    assert.equal(child?.mode, 'oneshot', 'un Researcher rend son résultat d\'un coup')
    assert.equal(child?.result?.summary, 'le port est 7777')
    const asked = daemon.store.lastEventOfType(child!.id, 'input.requested')
    assert.equal(asked?.payload.request, 'question')
    assert.equal(asked?.payload.text, 'Quel port faut-il viser ?')
    const answered = daemon.store.lastEventOfType(child!.id, 'message.agent')
    assert.equal(answered?.payload.in_reply_to, 'question')

    const orch = provider.received.get('[ask-orch]') ?? []
    assert.ok(orch.some((m) => m.role === 'tool' && /answer_question[\s\S]*Quel port faut-il viser/.test(m.content ?? '')))
    const kid = provider.received.get('[ask-child]') ?? []
    assert.ok(kid.some((m) => m.role === 'tool' && m.content === 'Answer from the orchestrator:\n\nLe port 7777.'))
    assert.ok(provider.tools.get('[ask-child]')?.includes('ask_parent'), 'une sous-tâche peut demander')
  })

  it('ne donne pas ask_parent à une tâche sans parent', async () => {
    provider.scripts.set('[solo]', [[{ tool: 'submit_result', args: { summary: 'seul' } }]])
    const created = daemon.tasks.create({
      objective: '[solo] lis', agentId: 'researcher', context: null, projectDir: repo,
      durationS: 20, needsApproval: false,
    })
    assert.ok(!('error' in created))
    await until(created.task.id, 'completed')
    assert.equal(provider.tools.get('[solo]')?.includes('ask_parent'), false)
  })
})

describe('un orchestrateur ne laisse personne attendre', () => {
  it('refuse son submit_result tant qu\'une proposition attend, puis conclut une fois la sous-tâche annulée', async () => {
    provider.scripts.set('[block-orch]', [
      [{ tool: 'delegate_task', args: { agent_id: 'developer', objective: '[block-dev] propose' } }],
      [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
      [{ tool: 'submit_result', args: { summary: 'trop tôt' } }],
      [{ tool: 'cancel_task', args: { task_id: '{{task_id}}', reason: 'inutile' } }],
      [{ tool: 'submit_result', args: { summary: 'conclu sans la proposition' } }],
    ])
    provider.scripts.set('[block-dev]', [
      [{ tool: 'write_file', args: { path: 'src/x.ts', content: 'export const x = 1\n' } }],
      [{ tool: 'submit_result', args: { summary: 'x ajouté' } }],
    ])
    const parent = orchestrate('[block-orch] essaie de conclure')
    const done = await daemon.tasks.wait(parent.id, 20_000, 0)
    assert.equal(done?.task.status, 'completed', done?.task.error ?? '')
    assert.equal(done?.task.result?.summary, 'conclu sans la proposition')

    const refused = daemon.store
      .taskEvents(parent.id)
      .find((e) => e.type === 'agent.message' && /submit_result refusé/.test(String(e.payload.message)))
    assert.ok(refused, 'le refus est au journal')
    const orch = provider.received.get('[block-orch]') ?? []
    assert.ok(orch.some((m) => m.role === 'tool' && /submit_result refused: 1 subtask\(s\) wait for you/.test(m.content ?? '')))

    const [child] = daemon.store.childTasks(parent.id)
    const final = await until(child!.id, 'cancelled')
    const ws = daemon.store.workspaceForTask(final.id)!
    assert.equal(git('rev-parse', ws.branch), base, 'une proposition annulée ne commite rien')
    assert.equal(daemon.store.countTasks().active, 0)
  })
})

describe('cascade', () => {
  it('emporte une sous-tâche qui attend son verdict, sans commit, quand le parent est annulé', async () => {
    // Un parent en conversation : quand il attend l'utilisateur, l'enfant
    // attend son verdict. Les deux sont à l'arrêt — l'annulation tombe à coup sûr.
    provider.scripts.set('[casc-orch]', [
      [{ tool: 'delegate_task', args: { agent_id: 'developer', objective: '[casc-dev] propose' } }],
      [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
      { text: 'Le Developer propose un changement. Je l\'accepte ?' },
    ])
    provider.scripts.set('[casc-dev]', [
      [{ tool: 'write_file', args: { path: 'src/y.ts', content: 'export const y = 2\n' } }],
      [{ tool: 'submit_result', args: { summary: 'y ajouté' } }],
    ])
    const parent = orchestrate('[casc-orch] délègue puis demande', true)
    await until(parent.id, 'waiting_input')
    const [child] = daemon.store.childTasks(parent.id)
    assert.equal(daemon.store.getTask(child!.id)?.awaiting_input, 'proposal')

    const asked = daemon.tasks.cancel(parent.id, 'l\'utilisateur arrête tout')
    assert.ok(!('error' in asked))
    await until(parent.id, 'cancelled')
    const final = await until(child!.id, 'cancelled')
    assert.match(final.error ?? '', /^tâche parente annulée/)
    const ws = daemon.store.workspaceForTask(final.id)!
    assert.equal(git('rev-parse', ws.branch), base, 'la branche reste au commit de départ')
    assert.equal(ws.status, 'kept', 'le worktree reste lisible')
    assert.equal(daemon.store.countTasks().active, 0, 'aucune tâche active en base')
  })
})
