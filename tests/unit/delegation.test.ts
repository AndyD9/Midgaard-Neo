/**
 * @file Le port de délégation et la cascade d'annulation (Slice 5, étape 3),
 * sur un vrai daemon démarré dans le processus de test.
 *
 * Aucun modèle n'est appelé. Le profil `orchestrator` n'a pas encore de moteur
 * (il arrive à l'étape 4), et l'on ne veut pas de vrai Researcher qui
 * chercherait une clé : les deux types reçoivent ici un **moteur pilotable**,
 * qui ne fait rien seul et dont le test écrit les transitions par le bus — le
 * seul chemin d'écriture du daemon. Le gérant de tâches, lui, est le vrai.
 *
 * Ce que ces tests couvrent, et pourquoi :
 *  - les règles de rattachement : profondeur 1, parent actif et orchestrateur,
 *    dossier hérité du parent, sous-tâches d'un autre arbre invisibles ;
 *  - l'attente traverse une pause d'approbation (décision 2) et s'arrête sur
 *    la fin, l'arrêt du parent ou son échéance ; `subtask.waiting` est écrit ;
 *  - **aucun orphelin** (décision 5) : les tâches actives sont **comptées en
 *    base** après l'arrêt du parent, pas déduites de ce que voit un client —
 *    c'est ainsi qu'un bug de verrou était passé inaperçu ;
 *  - ce que le modèle écrit dans une délégation est expurgé avant d'être persisté.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createRedactor, loadConfig, type AgentKind, type Task } from '@midgaard/contracts'
import { reconcileAgents, startDaemon, type Daemon, type EngineContext, type TaskEngine } from '@midgaard/daemon'
import type { DelegationPort, SubtaskState } from '@midgaard/tools'

let home: string
let project: string
let daemon: Daemon
let ctx: EngineContext
/** Ce que les moteurs pilotables ont vu annuler, par tâche. */
const cancelledByEngine = new Set<string>()
/** Vrai : le moteur de l'orchestrateur s'arrêtera « au prochain point de contrôle ». */
let cooperativeOrchestrator = false

/** Un moteur qui ne fait rien seul : le test écrit les transitions. */
function drivenEngine(kind: AgentKind): TaskEngine {
  return {
    kind,
    start: (task) => void ctx.bus.record(task.id, 'running', { type: 'task.started' }),
    resume: () => {},
    cancel: (task) => {
      cancelledByEngine.add(task.id)
      return kind === 'orchestrator' ? !cooperativeOrchestrator : true
    },
    stop: () => {},
  }
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'midgaard-delegation-'))
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-delegation-projet-')))
  const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
  daemon = (await startDaemon(config, { log: () => {}, env: { MIDGAARD_VAULT: 'file' } }))!
  ctx = daemon.tasks.engineContextFor()
  daemon.store.upsertProvider({
    id: 'faux', name: 'faux', kind: 'openai-compatible', preset: 'venice', baseUrl: null,
    defaultModel: 'modele', secretRef: null, webSearch: 'off',
  })
  reconcileAgents(daemon.store)
  daemon.store.upsertAgent({
    id: 'orchestrator', name: 'Orchestrator', kind: 'orchestrator', description: 'délègue', providerId: 'faux',
    model: null, systemPrompt: '', tools: [], limits: daemon.store.getAgent('researcher')!.limits, enabled: true,
  })
  for (const kind of ['orchestrator', 'researcher', 'developer'] as const) daemon.tasks.register(drivenEngine(kind))
})

after(async () => {
  daemon.close('fin des tests')
  await daemon.stopped
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

beforeEach(() => {
  cooperativeOrchestrator = false
})

/** Une tâche orchestrateur en marche, et son port. */
function orchestrator(): { parent: Task; port: DelegationPort } {
  const created = daemon.tasks.create({
    objective: 'orchestre', agentId: 'orchestrator', context: null, projectDir: project, durationS: 20, needsApproval: false,
  })
  assert.ok(!('error' in created), JSON.stringify(created))
  return { parent: created.task, port: daemon.tasks.delegationFor(created.task.id, createRedactor([])) }
}

/** Délègue au Researcher, et échoue bruyamment sur un refus. */
function delegate(port: DelegationPort, objective = 'cherche'): SubtaskState {
  const child = port.delegate({ agent_id: 'researcher', objective })
  assert.ok(!('refused' in child), JSON.stringify(child))
  return child
}

/** Tâches actives d'un arbre, **lues en base**. */
function activeIn(parent: Task): number {
  return daemon.store.childTasks(parent.id, { active: true }).length
}

/** Laisse passer la cascade, différée d'une micro-tâche. */
async function settle(): Promise<void> {
  await tick()
}

describe('rattachement', () => {
  it('rattache la sous-tâche au parent et lui impose son dossier', () => {
    const { parent, port } = orchestrator()
    const child = delegate(port)
    const stored = daemon.store.getTask(child.task_id)!
    assert.equal(stored.parent_task_id, parent.id)
    assert.equal(stored.project_dir, project)
    assert.equal(daemon.store.taskEvents(child.task_id)[0]!.payload.parent_task_id, parent.id)
  })

  it('ne liste pas les orchestrateurs, et refuse de leur déléguer', () => {
    const { port } = orchestrator()
    assert.ok(!port.listAgents().some((a) => a.kind === 'orchestrator'))
    const refused = port.delegate({ agent_id: 'orchestrator', objective: 'o' })
    assert.ok('refused' in refused && /orchestrator profile/.test(refused.refused))
  })

  it('refuse un profil inconnu en disant quoi faire', () => {
    const refused = orchestrator().port.delegate({ agent_id: 'personne', objective: 'o' })
    assert.ok('refused' in refused && /list_agents/.test(refused.refused))
  })

  it('refuse qu\'une tâche non orchestratrice délègue', () => {
    const created = daemon.tasks.create({
      objective: 'lit', agentId: 'researcher', context: null, projectDir: project, durationS: 20, needsApproval: false,
    })
    assert.ok(!('error' in created))
    const refused = daemon.tasks.delegationFor(created.task.id, (t) => t).delegate({ agent_id: 'researcher', objective: 'o' })
    assert.ok('refused' in refused)
    assert.equal(daemon.store.childTasks(created.task.id).length, 0)
  })

  it('ne voit ni n\'annule les sous-tâches d\'un autre arbre', async () => {
    const mine = orchestrator()
    const other = orchestrator()
    const theirs = delegate(other.port)
    const waited = await mine.port.wait(theirs.task_id, {})
    assert.ok('refused' in waited)
    const cancelled = mine.port.cancel(theirs.task_id)
    assert.ok('refused' in cancelled)
    assert.equal(daemon.store.getTask(theirs.task_id)!.status, 'running', 'intacte')
  })

  it('expurge l\'objectif et le contexte avant de les persister', () => {
    const secret = `ghp_${'Z8'.repeat(18)}`
    const { port } = orchestrator()
    const child = port.delegate({ agent_id: 'researcher', objective: `utilise ${secret}`, context: `jeton : ${secret}` })
    assert.ok(!('refused' in child))
    const stored = daemon.store.getTask(child.task_id)!
    assert.ok(!stored.objective.includes(secret), stored.objective)
    assert.ok(!stored.context!.includes(secret), stored.context!)
  })
})

describe('attente', () => {
  it('traverse une pause d\'approbation, et rend le résultat à la fin', async () => {
    const { parent, port } = orchestrator()
    const child = delegate(port)
    let settled = false
    const waiting = port.wait(child.task_id, {}).then((r) => {
      settled = true
      return r
    })
    await settle()
    const waitEvent = daemon.store.taskEvents(parent.id).find((e) => e.type === 'subtask.waiting')
    assert.equal(waitEvent?.payload.task_id, child.task_id, 'le dashboard sait qui le parent attend')

    ctx.requestApproval(child.task_id, 'exec — npm test', { argv: ['npm', 'test'] })
    await settle()
    assert.equal(settled, false, 'une pause d\'approbation ne rend pas la main')

    const approval = daemon.store.pendingApprovalFor(child.task_id)!
    daemon.tasks.approve(approval.id, 'test')
    ctx.bus.record(child.task_id, 'completed', { type: 'task.completed' }, {
      result: { summary: 'trouvé', details: '', steps: [], citations: [], untrusted: false, workspace: null },
    })
    const outcome = await waiting
    assert.ok(!('refused' in outcome))
    assert.equal(outcome.stopped_by, 'ended')
    assert.equal(outcome.result?.summary, 'trouvé')
  })

  it('rend la main à l\'échéance du parent, sans annuler la sous-tâche elle-même', async () => {
    const { port } = orchestrator()
    const child = delegate(port)
    const outcome = await port.wait(child.task_id, { deadline: Date.now() + 50 })
    assert.ok(!('refused' in outcome))
    assert.equal(outcome.stopped_by, 'deadline')
    assert.equal(outcome.ended, false)
  })

  it('rend la main quand le parent s\'arrête', async () => {
    const { port } = orchestrator()
    const child = delegate(port)
    const abort = new AbortController()
    const waiting = port.wait(child.task_id, { signal: abort.signal })
    abort.abort()
    const outcome = await waiting
    assert.ok(!('refused' in outcome))
    assert.equal(outcome.stopped_by, 'parent_stopping')
  })
})

describe('aucun orphelin', () => {
  it('annuler le parent annule ses sous-tâches actives, pause d\'approbation comprise', async () => {
    const { parent, port } = orchestrator()
    const running = delegate(port, 'une')
    const paused = delegate(port, 'deux')
    ctx.requestApproval(paused.task_id, 'exec — npm test', { argv: ['npm', 'test'] })
    const done = delegate(port, 'trois')
    ctx.bus.record(done.task_id, 'completed', { type: 'task.completed' })
    assert.equal(activeIn(parent), 2)

    daemon.tasks.cancel(parent.id, 'test')
    await settle()
    assert.equal(activeIn(parent), 0, 'aucune sous-tâche active en base')
    assert.equal(daemon.store.getTask(running.task_id)!.status, 'cancelled')
    assert.equal(daemon.store.getTask(paused.task_id)!.status, 'cancelled')
    assert.equal(daemon.store.getTask(done.task_id)!.status, 'completed', 'une sous-tâche finie reste finie')
    assert.equal(daemon.store.getTask(running.task_id)!.error, 'tâche parente annulée')
    assert.ok(cancelledByEngine.has(running.task_id), 'le moteur de la sous-tâche a été prévenu')
  })

  it('annule dès la demande, sans attendre que le parent ait fini de s\'arrêter', async () => {
    cooperativeOrchestrator = true
    const { parent, port } = orchestrator()
    delegate(port)
    daemon.tasks.cancel(parent.id)
    await settle()
    assert.equal(daemon.store.getTask(parent.id)!.status, 'cancel_requested')
    assert.equal(activeIn(parent), 0)
    const refused = port.delegate({ agent_id: 'researcher', objective: 'trop tard' })
    assert.ok('refused' in refused && /stopping/.test(refused.refused), 'un parent qui s\'arrête ne lance plus rien')
  })

  for (const status of ['completed', 'failed', 'timed_out', 'budget_exceeded'] as const) {
    it(`un parent qui finit en ${status} annule ce qui reste`, async () => {
      const { parent, port } = orchestrator()
      delegate(port)
      delegate(port)
      ctx.bus.record(parent.id, status, { type: status === 'completed' ? 'task.completed' : 'task.failed' })
      await settle()
      assert.equal(activeIn(parent), 0)
      for (const child of daemon.store.childTasks(parent.id)) {
        assert.equal(child.status, 'cancelled')
        assert.match(child.error ?? '', new RegExp(`terminée \\(${status}\\)`))
      }
    })
  }

  it('une sous-tâche annulée par l\'orchestrateur ne touche pas aux autres', async () => {
    const { parent, port } = orchestrator()
    const a = delegate(port, 'a')
    const b = delegate(port, 'b')
    const cancelled = port.cancel(a.task_id, 'déjà répondu')
    assert.ok(!('refused' in cancelled))
    await settle()
    assert.equal(daemon.store.getTask(a.task_id)!.status, 'cancelled')
    assert.equal(daemon.store.getTask(b.task_id)!.status, 'running')
    assert.equal(daemon.store.getTask(parent.id)!.status, 'running')
    const again = port.cancel(a.task_id)
    assert.ok('refused' in again && /already ended/.test(again.refused))
  })
})
