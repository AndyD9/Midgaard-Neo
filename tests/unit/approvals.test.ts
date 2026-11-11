/**
 * @file Empreinte des approbations : ce qui doit la changer, et ce qui ne doit pas.
 *
 * Une approbation vaut pour une opération exacte (PLAN §5). L'empreinte est
 * tirée du détail structuré, mis en forme canonique : elle doit distinguer deux
 * opérations qui s'affichent pareil, et confondre deux écritures du même objet.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_RESEARCHER_LIMITS, canonicalJson, loadConfig, operationHash } from '@midgaard/contracts'
import { HarnessStore } from '@midgaard/persistence'

const TASK = '0b9f3c2e-4d1a-4f6b-9c7e-2a5d8e1f3b40'

describe('canonicalJson', () => {
  it('trie les clés à tous les niveaux, et garde l\'ordre des tableaux', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, 1], c: null } }), '{"a":{"c":null,"d":[3,1]},"b":1}')
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}')
  })
})

describe('operationHash', () => {
  const exec = (args: string[]) => ({ tool: 'exec', program: '/bin/echo', args, cwd: '/w' })

  it('distingue un argument contenant ; de trois arguments', () => {
    assert.notEqual(operationHash(TASK, 1, exec(['a;b'])), operationHash(TASK, 1, exec(['a', ';', 'b'])))
  })

  it('ignore l\'ordre des clés', () => {
    assert.equal(
      operationHash(TASK, 1, { tool: 'exec', args: ['x'], cwd: '/w' }),
      operationHash(TASK, 1, { cwd: '/w', args: ['x'], tool: 'exec' }),
    )
  })

  it('ne vaut que pour une pause : même commande, autre numéro, autre empreinte', () => {
    assert.notEqual(operationHash(TASK, 1, exec(['x'])), operationHash(TASK, 2, exec(['x'])))
  })
})

describe('détail conservé avec la demande', () => {
  it('relit le détail tel qu\'il a été écrit, et null pour une demande ancienne', () => {
    const home = mkdtempSync(join(tmpdir(), 'midgaard-approvals-'))
    const store = HarnessStore.open(loadConfig({ MIDGAARD_HOME: home }))
    try {
      const { task } = store.createTask({
        objective: 'o', agentId: 'simulated', context: null, projectDir: null,
        limits: DEFAULT_RESEARCHER_LIMITS, durationS: 10, stepsTotal: 5, needsApproval: true,
      })
      const detail = exec(['test'])
      const a = store.createApproval({
        taskId: task.id, seq: 1, operation: 'exec — exécuter /bin/echo test', operationDetail: detail,
        operationHash: operationHash(task.id, 1, detail), ttlMs: 60_000,
      })
      assert.deepEqual(a.operation_detail, detail)
      assert.deepEqual(store.getApproval(a.id)?.operation_detail, detail)
      assert.deepEqual(store.pendingApprovals()[0]?.operation_detail, detail)
      assert.equal(a.operation_hash, operationHash(task.id, 1, detail), 'l\'empreinte se recalcule depuis le détail relu')

      const old = store.createApproval({
        taskId: task.id, seq: 2, operation: 'étape', operationDetail: null, operationHash: 'h', ttlMs: 60_000,
      })
      assert.equal(old.operation_detail, null)
      assert.equal('operation_json' in old, false, 'la colonne brute ne fuit pas dans le contrat')
    } finally {
      store.close()
      rmSync(home, { recursive: true, force: true })
    }
  })

  function exec(args: string[]) {
    return { tool: 'exec', program: '/bin/echo', args, cwd: '/w' }
  }
})
