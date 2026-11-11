/**
 * @file Les agents créés à la volée par un orchestrateur, le plafond de
 * sous-tâches actives et le budget de l'arbre (Slice 8, étape 4), sur un vrai
 * daemon démarré dans le processus de test.
 *
 * Comme `delegation.test.ts`, aucun modèle n'est appelé : les moteurs sont
 * **pilotables** — ils ne font rien seuls, et le test écrit leurs transitions et
 * leur consommation par le bus. Le gérant de tâches, lui, est le vrai.
 *
 * Ce qui est prouvé, et pourquoi :
 *  - **rien de créé ne dépasse le profil de base**, et chaque dépassement est
 *    refusé **avec son motif** — limites, serveurs MCP, fournisseur, modèle non
 *    offert, modèle sans tarif connu —, jamais réduit en silence ;
 *  - ce qui est créé **dérive** du profil : mêmes outils, consigne du profil
 *    puis le rôle, jamais l'inverse ; et l'humain le voit (`agent.created`) ;
 *  - **un agent créé n'existe que dans son arbre** : ni un autre orchestrateur
 *    ni une tâche de premier niveau ne peuvent s'en servir ;
 *  - **les plafonds de l'arbre** se vérifient avant de créer une sous-tâche :
 *    nombre de sous-tâches actives, et budget commun — **compté en base**.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { checkLimits } from '@midgaard/agent-runtime'
import { createRedactor, emptyUsage, loadConfig, type AgentKind, type Task, type Usage } from '@midgaard/contracts'
import { CREATED_ROLE_HEADING, reconcileAgents, startDaemon, type Daemon, type EngineContext, type TaskEngine } from '@midgaard/daemon'
import type { CreatedAgentInfo, DelegationPort, DelegationRefusal } from '@midgaard/tools'

let home: string
let project: string
let daemon: Daemon
let ctx: EngineContext

/** Un moteur qui ne fait rien seul : le test écrit les transitions. */
function drivenEngine(kind: AgentKind): TaskEngine {
  return {
    kind,
    start: (task) => void ctx.bus.record(task.id, 'running', { type: 'task.started' }),
    resume: () => {},
    cancel: () => true,
    stop: () => {},
  }
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'midgaard-created-'))
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-created-projet-')))
  // Deux sous-tâches actives au plus : le plafond se voit sans en lancer quatre.
  const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0', MIDGAARD_MAX_ACTIVE_SUBTASKS: '2' })
  daemon = (await startDaemon(config, { log: () => {}, env: { MIDGAARD_VAULT: 'file' } }))!
  ctx = daemon.tasks.engineContextFor()
  // Venice : la table de tarifs livrée connaît ses modèles.
  daemon.store.upsertProvider({
    id: 'venice', name: 'Venice', kind: 'openai-compatible', preset: 'venice', baseUrl: null,
    defaultModel: 'deepseek-v4-flash-0731', secretRef: null, webSearch: 'off',
  })
  daemon.store.recordProviderTest('venice', {
    ok: true, detail: 'test', at: new Date().toISOString(), latency_ms: 1,
    models: ['deepseek-v4-flash-0731', 'qwen-3-8-flash', 'modele-sans-tarif'],
  })
  reconcileAgents(daemon.store)
  daemon.store.upsertMcpServer({ id: 'rea', name: 'REA', command: process.execPath, args: [], env: {}, secretEnv: [] })
  daemon.store.setAgentMcpServers('researcher', ['rea'])
  for (const kind of ['orchestrator', 'researcher', 'developer'] as const) daemon.tasks.register(drivenEngine(kind))
})

after(async () => {
  daemon.close('fin des tests')
  await daemon.stopped
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

/** Une tâche orchestrateur en marche, et son port. */
function orchestrator(): { parent: Task; port: DelegationPort } {
  const created = daemon.tasks.create({
    objective: 'orchestre', agentId: 'orchestrator', context: null, projectDir: project, durationS: 20, needsApproval: false,
  })
  assert.ok(!('error' in created), JSON.stringify(created))
  return { parent: created.task, port: daemon.tasks.delegationFor(created.task.id, createRedactor([])) }
}

function ok(result: CreatedAgentInfo | DelegationRefusal): CreatedAgentInfo {
  assert.ok(!('refused' in result), JSON.stringify(result))
  return result
}

function refused(result: CreatedAgentInfo | DelegationRefusal, motive: RegExp): void {
  assert.ok('refused' in result, `attendu un refus, reçu ${JSON.stringify(result)}`)
  assert.match(result.refused, motive)
}

/** Écrit la consommation d'une tâche comme le ferait son moteur. */
function spend(taskId: string, cost: number): void {
  const usage: Usage = { ...emptyUsage(), model_calls: 1, cost_usd: cost, cost_source: 'pricing_table' }
  ctx.bus.record(taskId, null, { type: 'usage.updated', payload: { usage, step: 1 } }, { usage, step: 1 })
}

describe('créer un agent', () => {
  it('dérive du profil de base : ses outils, sa consigne puis le rôle, un sous-ensemble de ses serveurs', () => {
    const { parent, port } = orchestrator()
    const info = ok(port.createAgent({
      name: 'Reverser binaire', base: 'researcher', role: 'Reverse the binary with REA.', mcp_servers: ['rea'],
      limits: { max_steps: 5 },
    }))
    assert.match(info.agent_id, /^reverser-binaire-[0-9a-f]{6}$/)
    assert.deepEqual(info.mcp_servers, ['rea'])
    assert.equal(info.limits.max_steps, 5)

    const agent = daemon.tasks.agentFor(info.agent_id)!
    const researcher = daemon.store.getAgent('researcher')!
    assert.equal(agent.kind, 'researcher')
    assert.deepEqual(agent.tools, researcher.tools, 'les outils sont ceux du profil, jamais plus')
    assert.ok(agent.system_prompt.startsWith(researcher.system_prompt), 'la consigne du profil reste en tête')
    assert.ok(agent.system_prompt.endsWith(`${CREATED_ROLE_HEADING}\n\nReverse the binary with REA.`))

    // L'humain le voit dans le journal de l'orchestrateur.
    const event = daemon.store.taskEvents(parent.id).find((e) => e.type === 'agent.created')
    assert.equal(event?.payload.agent_id, info.agent_id)
    assert.equal(event?.payload.role, 'Reverse the binary with REA.')
    // L'orchestrateur le retrouve, marqué comme sien.
    const listed = port.listAgents().find((a) => a.id === info.agent_id)
    assert.equal(listed?.created, true)
    // Et il lui délègue.
    const child = port.delegate({ agent_id: info.agent_id, objective: 'regarde main' })
    assert.ok(!('refused' in child), JSON.stringify(child))
    assert.equal(daemon.store.getTask(child.task_id)?.agent_id, info.agent_id)
    assert.equal(daemon.store.getTask(child.task_id)?.limits.max_steps, 5)
  })

  it('refuse avec le motif tout ce qui dépasserait le profil de base', () => {
    const { port } = orchestrator()
    const base = { name: 'x', base: 'researcher' as const, role: 'r' }
    const max = daemon.store.getAgent('researcher')!.limits.max_cost_usd
    refused(port.createAgent({ ...base, limits: { max_cost_usd: max + 1 } }), /limits above the base profile: max_cost_usd/)
    refused(port.createAgent({ ...base, mcp_servers: ['ghidra'] }), /not available to the base profile "researcher" \(it has: rea\)/)
    refused(port.createAgent({ name: 'x', base: 'developer', role: 'r', mcp_servers: ['rea'] }), /it has: none/)
    refused(port.createAgent({ ...base, provider_id: 'absent' }), /unknown model provider "absent"/)
    refused(port.createAgent({ ...base, model: 'pas-offert' }), /not offered by provider "venice"/)
    refused(port.createAgent({ ...base, model: 'modele-sans-tarif' }), /no known price/)
    // Un modèle offert et tarifé passe.
    ok(port.createAgent({ ...base, model: 'qwen-3-8-flash' }))
  })

  it('n\'existe que dans son arbre', () => {
    const a = orchestrator()
    const b = orchestrator()
    const info = ok(a.port.createAgent({ name: 'Mien', base: 'researcher', role: 'r' }))
    const other = b.port.delegate({ agent_id: info.agent_id, objective: 'vol' })
    assert.ok('refused' in other && /unknown profile/.test(other.refused), 'un autre arbre ne le voit pas')
    assert.equal(b.port.listAgents().some((x) => x.id === info.agent_id), false)
    const top = daemon.tasks.create({
      objective: 'direct', agentId: info.agent_id, context: null, projectDir: project, durationS: 20, needsApproval: false,
    })
    assert.ok('error' in top && top.error === 'agent_not_found', 'une tâche de premier niveau non plus')
  })
})

describe('les plafonds de l\'arbre', () => {
  it('refuse une sous-tâche au-delà du nombre de sous-tâches actives', () => {
    const { parent, port } = orchestrator()
    for (let i = 0; i < 2; i++) assert.ok(!('refused' in port.delegate({ agent_id: 'researcher', objective: `n${i}` })))
    const third = port.delegate({ agent_id: 'researcher', objective: 'trop' })
    assert.ok('refused' in third && /2 subtask\(s\) are already running/.test(third.refused))
    assert.equal(daemon.store.childTasks(parent.id, { active: true }).length, 2, 'compté en base')
  })

  it('compte la dépense de tout l\'arbre, et refuse de déléguer une fois le budget dépensé', () => {
    const { parent, port } = orchestrator()
    const limit = parent.limits.max_cost_usd
    const child = port.delegate({ agent_id: 'researcher', objective: 'dépense' })
    assert.ok(!('refused' in child))
    spend(parent.id, limit * 0.25)
    spend(child.task_id, limit * 0.5)
    // Chaque tâche voit ce qu'ont dépensé les **autres**.
    assert.deepEqual(daemon.tasks.treeBudget(child.task_id), { limit, others: limit * 0.25 })
    assert.deepEqual(daemon.tasks.treeBudget(parent.id), { limit, others: limit * 0.5 })
    spend(child.task_id, limit * 0.8)
    const late = port.delegate({ agent_id: 'researcher', objective: 'trop tard' })
    assert.ok('refused' in late && /budget of this task .* is spent/.test(late.refused))
  })

  it('arrête une tâche dont l\'arbre a atteint son budget, dès son premier appel', () => {
    const limits = daemon.store.getAgent('researcher')!.limits
    const base = { usage: emptyUsage(), step: 0, limits, deadline: Date.now() + 60_000, cancelled: false }
    assert.equal(checkLimits({ ...base, tree: { limit: 1, others: 0.4 } }), null)
    // Coût propre encore inconnu : il compte pour zéro, mais le contrôle a lieu.
    const stop = checkLimits({ ...base, tree: { limit: 1, others: 1 } })
    assert.equal(stop?.kind, 'budget')
    assert.match(stop!.detail, /budget de l'arbre de tâches/)
    const priced = { ...emptyUsage(), model_calls: 1, cost_usd: 0.7, cost_source: 'pricing_table' as const }
    assert.equal(checkLimits({ ...base, usage: priced, tree: { limit: 1, others: 0.4 } })?.kind, 'budget')
  })
})
