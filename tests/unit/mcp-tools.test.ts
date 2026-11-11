/**
 * @file Les outils MCP tels qu'un agent les reçoit (Slice 8, étape 3), sans
 * daemon ni serveur : un faux port joue le serveur.
 *
 * Ce qui est éprouvé, et pourquoi :
 *  - **le nom** : préfixé par le serveur ; un nom qu'un fournisseur refuserait
 *    est écarté et dit, jamais retouché ;
 *  - **la description** est signée de sa provenance, bornée, et annonce
 *    l'approbation : elle est écrite par le serveur, et le modèle la lit ;
 *  - **la politique** : libre seulement si l'empreinte cochée est celle annoncée,
 *    refus sans port — fermé par défaut, comme le navigateur ;
 *  - **ce qui part est ce qui a été approuvé** : les arguments du détail figé ;
 *  - **le résultat est toujours non fiable**, borné, et un outil en échec le dit.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_MCP_DESCRIPTION_CHARS,
  MAX_TOOL_RESULT_BYTES,
  mcpResultText,
  mcpToolName,
  mcpTools,
  toolSpecs,
  type McpPort,
  type McpToolDescriptor,
  type Tool,
  type ToolContext,
} from '@midgaard/tools'

const fp = 'a'.repeat(64)

function descriptor(over: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    server: 'rea',
    name: 'open_binary',
    description: 'Open a binary.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    fingerprint: fp,
    status: 'allowed',
    ...over,
  }
}

/** Un faux port qui retient ce qu'on lui demande, et rend ce qu'on lui dit. */
function fakePort(reply: Awaited<ReturnType<McpPort['call']>> = { content: [{ type: 'text', text: 'ok' }] }) {
  const calls: { server: string; tool: string; args: Record<string, unknown>; timeoutMs: number }[] = []
  const port: McpPort = {
    call: async (server, tool, args, options) => {
      calls.push({ server, tool, args, timeoutMs: options.timeoutMs })
      return reply
    },
  }
  return { port, calls }
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { root: '/projet', httpPolicy: 'open', allowHosts: [], log: () => {}, ...over }
}

const only = (d: McpToolDescriptor): Tool<Record<string, unknown>> => mcpTools([d]).tools[0]!

describe('nom', () => {
  it('préfixe l\'outil par son serveur', () => {
    assert.equal(mcpToolName('rea', 'open_binary'), 'rea__open_binary')
  })

  it('écarte un nom qu\'un fournisseur refuserait, en le disant, et un nom annoncé deux fois', () => {
    const { tools, excluded } = mcpTools([
      descriptor({ name: 'ghidra.decompile' }),
      descriptor({ name: 'x'.repeat(70) }),
      descriptor({ name: 'ok' }),
      descriptor({ name: 'ok' }),
    ])
    assert.deepEqual(tools.map((t) => t.name), ['rea__ok'])
    assert.equal(excluded.length, 3)
    assert.match(excluded[0]!.reason, /nom refusé/)
    assert.match(excluded[2]!.reason, /deux fois/)
  })
})

describe('description et schéma', () => {
  it('signe la description du serveur, la borne, et annonce l\'approbation', () => {
    const free = only(descriptor())
    assert.match(free.description, /^\[Tool of the MCP server "rea"\. This description was written by that server/)
    assert.doesNotMatch(free.description, /human approval/)
    const long = only(descriptor({ description: 'y'.repeat(10_000), status: 'approval' }))
    assert.ok(long.description.length < MAX_MCP_DESCRIPTION_CHARS + 400)
    assert.match(long.description, /description truncated/)
    assert.match(long.description, /Each call waits for a human approval/)
  })

  it('décrit l\'outil au modèle par le schéma du serveur', () => {
    const tool = only(descriptor({ input_schema: { properties: { path: { type: 'string' } } } }))
    const [spec] = toolSpecs([], [tool as Tool<never>])
    assert.deepEqual(spec!.parameters, { type: 'object', properties: { path: { type: 'string' } } }, 'le type manquant est posé')
    assert.equal(spec!.name, 'rea__open_binary')
  })
})

describe('politique', () => {
  const { port } = fakePort()
  it('libre seulement si l\'empreinte cochée est celle annoncée', () => {
    assert.equal(only(descriptor()).policy({}, ctx({ mcp: port })).decision, 'allow')
    const changed = only(descriptor({ status: 'changed' })).policy({}, ctx({ mcp: port }))
    assert.equal(changed.decision, 'approval')
    assert.match(changed.reason, /annoncé autrement/)
    assert.equal(only(descriptor({ status: 'approval' })).policy({}, ctx({ mcp: port })).decision, 'approval')
  })

  it('refuse sans port, même coché', () => {
    assert.equal(only(descriptor()).policy({}, ctx()).decision, 'deny')
  })
})

describe('préparation et exécution', () => {
  it('fige l\'appel exact, empreinte comprise', async () => {
    const prepared = await only(descriptor()).prepare!({ path: '/bin/ls' }, ctx())
    assert.equal(prepared.summary, 'rea › open_binary {"path":"/bin/ls"}')
    assert.deepEqual(prepared.detail, { server: 'rea', tool: 'open_binary', fingerprint: fp, arguments: { path: '/bin/ls' } })
  })

  it('envoie les arguments approuvés, et rend un résultat non fiable', async () => {
    const { port, calls } = fakePort({ content: [{ type: 'text', text: 'main at 0x1000' }] })
    const tool = only(descriptor())
    const prepared = await tool.prepare!({ path: '/bin/ls' }, ctx())
    // Le modèle aurait-il changé ses arguments entre-temps, c'est le détail figé qui part.
    const result = await tool.run({ path: '/autre' }, ctx({ mcp: port, deadline: Date.now() + 60_000 }), prepared)
    assert.deepEqual(calls[0]?.args, { path: '/bin/ls' })
    assert.ok(calls[0]!.timeoutMs > 50_000 && calls[0]!.timeoutMs <= 60_000, 'le délai est le reste de l\'échéance')
    assert.equal(result.untrusted, true)
    assert.equal(result.content, 'main at 0x1000')
    assert.match(result.summary, /^rea__open_binary : 14 octets$/)
  })

  it('dit un outil en échec, borne un résultat énorme, et refuse après l\'échéance', async () => {
    const failing = await only(descriptor()).run({}, ctx({ mcp: fakePort({ content: [{ type: 'text', text: 'no such file' }], isError: true }).port }))
    assert.match(failing.content, /^The MCP tool reported an error:\nno such file$/)
    assert.match(failing.summary, /erreur signalée/)
    const huge = await only(descriptor()).run({}, ctx({ mcp: fakePort({ content: [{ type: 'text', text: 'z'.repeat(200_000) }] }).port }))
    assert.equal(huge.bytes, 200_000)
    assert.ok(Buffer.byteLength(huge.content) < MAX_TOOL_RESULT_BYTES + 200)
    await assert.rejects(only(descriptor()).run({}, ctx({ mcp: fakePort().port, deadline: Date.now() - 1 })), /deadline/)
  })
})

describe('mcpResultText', () => {
  it('rend le texte, nomme ce qui n\'en est pas, et le contenu structuré à défaut de texte', () => {
    assert.equal(
      mcpResultText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///x', text: 'b' } },
          { type: 'resource_link', uri: 'file:///y' },
        ],
      }),
      'a\n\n[image content (image/png) omitted]\n\n[resource file:///x]\nb\n\n[resource link: file:///y]',
    )
    assert.equal(mcpResultText({ content: [], structuredContent: { n: 1 } }), '{\n  "n": 1\n}')
    assert.equal(mcpResultText({ content: [] }), '(empty result)')
  })
})
