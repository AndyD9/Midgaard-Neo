/**
 * @file Les fonctions pures du dashboard pour la Slice 8 : outils MCP, budget
 * de l'arbre, agents créés lus dans le journal.
 *
 * `readOnlyCandidates` existe deux fois — dans la CLI et dans le dashboard,
 * qui n'importe de `contracts` que des types —, et les deux doivent proposer la
 * même chose : le test les compare sur les mêmes entrées.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyUsage, type McpCatalogEntry, type Task, type TaskEvent } from '@midgaard/contracts'
import { readOnlyCandidates as cliCandidates } from '@midgaard/cli'
import { allowWarning, hintsOf, readOnlyCandidates, splitMcpName } from '../../apps/dashboard/src/lib/mcp.ts'
import { createdAgents } from '../../apps/dashboard/src/lib/tree.ts'

function entry(name: string, annotations: Record<string, unknown> | null, status: McpCatalogEntry['status'] = 'approval'): McpCatalogEntry {
  return { name, title: null, description: '', input_schema: {}, annotations, fingerprint: '0'.repeat(64), status, allowed_by: null, allowed_at: null }
}

function task(over: Partial<Task>): Task {
  return { usage: emptyUsage(), ...over } as Task
}

describe('outils MCP', () => {
  it('reconnaît un nom d\'outil MCP, et seulement lui', () => {
    assert.deepEqual(splitMcpName('rea__open_binary'), { server: 'rea', tool: 'open_binary' })
    assert.equal(splitMcpName('read_file'), null)
    assert.equal(splitMcpName('__x'), null)
    assert.equal(splitMcpName('rea__'), null)
  })

  it('propose les mêmes outils de lecture que la CLI', () => {
    const tools = [
      entry('lit', { readOnlyHint: true }),
      entry('detruit', { readOnlyHint: true, destructiveHint: true }),
      entry('ecrit', { readOnlyHint: false }),
      entry('muet', null),
      entry('deja', { readOnlyHint: true }, 'allowed'),
      entry('change', { readOnlyHint: true }, 'changed'),
    ]
    assert.deepEqual(readOnlyCandidates(tools).map((t) => t.name), ['lit', 'change'])
    assert.deepEqual(readOnlyCandidates(tools), cliCandidates(tools))
  })

  it('dit les annotations, et l\'avertissement de la CLI avant de cocher', () => {
    assert.deepEqual(hintsOf(entry('x', { readOnlyHint: true, openWorldHint: true })), ['lecture seule', 'monde ouvert'])
    const warning = allowWarning('rea', ['a', 'b'])
    assert.match(warning, /SANS APPROBATION/)
    assert.match(warning, /pas borné au projet/)
    assert.match(warning, /a, b/)
  })
})

describe('agents créés', () => {
  it('lit les agents créés dans le journal de l\'orchestrateur, rôle compris', () => {
    const events = [
      { type: 'task.started', payload: {} },
      {
        type: 'agent.created',
        payload: { agent_id: 'reverser-abc123', name: 'Reverser', base_agent_id: 'researcher', model: null, mcp_servers: ['rea'], role: 'Lis le binaire.' },
      },
    ] as unknown as TaskEvent[]
    assert.deepEqual(createdAgents(events), [
      { agent_id: 'reverser-abc123', name: 'Reverser', base: 'researcher', model: null, mcp_servers: ['rea'], role: 'Lis le binaire.' },
    ])
    assert.deepEqual(createdAgents(undefined), [])
  })
})
