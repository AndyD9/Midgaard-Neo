/**
 * @file Les tâches en arbre du dashboard (Slice 5, étape 5) : fonctions pures
 * de `apps/dashboard/src/lib/tree.ts` et `agents.ts`, sans rendu.
 *
 * Deux règles pourraient mentir à l'écran sans qu'aucun rendu ne le montre :
 *  - **le total d'un arbre porte la plus faible de ses provenances** — une
 *    facture additionnée à une ignorance n'est pas une facture ;
 *  - **aucune tâche ne disparaît de la liste**, même quand son parent en est absent.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyUsage, type Agent, type ProviderConfig, type Task, type Usage } from '@midgaard/contracts'
import { subtasksOf, taskTree, treeTotal } from '../../apps/dashboard/src/lib/tree.ts'
import { disabledReason } from '../../apps/dashboard/src/lib/agents.ts'

let clock = 0
/** Une tâche minimale ; `created_at` croît à chaque appel. */
function task(id: string, over: Partial<Task> = {}): Task {
  const at = new Date(Date.UTC(2026, 10, 1, 0, 0, clock++)).toISOString()
  return {
    id, objective: id, status: 'running', step: 0, steps_total: 1, agent_id: 'researcher', context: null,
    project_dir: null, parent_task_id: null, continues_task_id: null, mode: 'oneshot', awaiting_input: null, usage: emptyUsage(),
    needs_approval: false, approval_seq: 0, duration_s: 1, created_at: at, updated_at: at, started_at: null,
    ended_at: null, result: null, error: null, ...over,
  }
}

/** Une consommation mesurée. */
function spent(cost_usd: number, cost_source: Usage['cost_source']): Usage {
  return { ...emptyUsage(), model_calls: 1, cost_usd, cost_source }
}

describe('taskTree', () => {
  it('range chaque sous-tâche sous son parent, dans l\'ordre de délégation', () => {
    const parent = task('p', { agent_id: 'orchestrator' })
    const first = task('a', { parent_task_id: 'p' })
    const second = task('b', { parent_task_id: 'p' })
    const other = task('o')
    // La liste reçue va de la plus récente à la plus ancienne.
    const rows = taskTree([other, second, first, parent])
    assert.deepEqual(rows.map((r) => [r.task.id, r.depth]), [['o', 0], ['p', 0], ['a', 1], ['b', 1]])
    assert.equal(rows[1]!.children, 2)
  })

  it('montre au premier niveau une sous-tâche dont le parent est absent, plutôt que de la perdre', () => {
    const orphan = task('x', { parent_task_id: 'absent' })
    assert.deepEqual(taskTree([orphan]).map((r) => [r.task.id, r.depth]), [['x', 0]])
  })

  it('subtasksOf rend les enfants dans l\'ordre de délégation', () => {
    const a = task('a', { parent_task_id: 'p' })
    const b = task('b', { parent_task_id: 'p' })
    assert.deepEqual(subtasksOf([b, task('z'), a], 'p').map((t) => t.id), ['a', 'b'])
  })
})

describe('treeTotal', () => {
  it('additionne et garde « facturé » quand tout l\'est', () => {
    const total = treeTotal([task('p', { usage: spent(0.01, 'provider') }), task('a', { usage: spent(0.02, 'provider') })])
    assert.equal(total?.cost_source, 'provider')
    assert.ok(Math.abs(total!.cost_usd - 0.03) < 1e-12)
  })

  it('porte la plus faible des provenances : estimé, puis inconnu', () => {
    const estimated = treeTotal([task('p', { usage: spent(0.01, 'provider') }), task('a', { usage: spent(0.02, 'pricing_table') })])
    assert.equal(estimated?.cost_source, 'pricing_table')
    const unknown = treeTotal([
      task('p', { usage: spent(0.01, 'provider') }),
      task('a', { usage: spent(0.02, 'pricing_table') }),
      task('b', { usage: spent(0, 'unknown') }),
    ])
    assert.equal(unknown?.cost_source, 'unknown')
  })

  it('ignore une tâche qui n\'a appelé aucun modèle, et rend null si aucune n\'en a appelé', () => {
    const total = treeTotal([task('p', { usage: spent(0.01, 'provider') }), task('s')])
    assert.equal(total?.cost_source, 'provider', 'une tâche simulée ne rend pas le total inconnu')
    assert.equal(total?.counted, 1)
    assert.equal(treeTotal([task('s')]), null)
  })
})

describe('disabledReason', () => {
  const agent = (over: Partial<Agent>): Agent => ({
    id: 'researcher', name: 'R', kind: 'researcher', description: '', provider_id: null, model: null, system_prompt: '',
    tools: [], enabled: false, vision: null, mcp_servers: [], created_at: '', updated_at: '', ...over,
  })
  const venice = { id: 'venice' } as ProviderConfig

  it('ne dit rien d\'un profil actif', () => {
    assert.equal(disabledReason(agent({ enabled: true, provider_id: 'venice' }), [venice]), null)
  })

  it('dit pourquoi un profil est désactivé', () => {
    assert.match(disabledReason(agent({}), [])!, /aucun fournisseur/)
    assert.match(disabledReason(agent({ provider_id: 'parti' }), [venice])!, /« parti » n'existe plus/)
  })

  it('reprend le motif calculé par le daemon quand il le rend (Slice 7)', () => {
    // Un Navigator aveugle a un fournisseur : seul le daemon sait dire pourquoi il est refusé.
    const blind = agent({ kind: 'navigator', provider_id: 'venice', disabled_reason: 'le modèle « m » ne lit pas les images' })
    assert.equal(disabledReason(blind, [venice]), 'le modèle « m » ne lit pas les images')
  })
})
