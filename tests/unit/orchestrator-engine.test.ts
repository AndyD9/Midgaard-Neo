/**
 * @file Le profil `orchestrator` sur le **vrai moteur d'agent** (Slice 5,
 * étape 4) : un daemon démarré dans le processus de test, un faux fournisseur
 * compatible OpenAI, aucun réseau ni dépense.
 *
 * `delegation.test.ts` éprouve le port avec des moteurs pilotables ; ce qui
 * reste à prouver est le câblage, que rien d'autre ne voit :
 *  - le moteur pose le port de délégation pour un orchestrateur — sans lui,
 *    `list_agents` et `delegate_task` seraient refusés ;
 *  - la sous-tâche créée par le modèle est rattachée au parent, sur son dossier ;
 *  - l'orchestrateur attend sa sous-tâche et en reçoit le résultat, **encadré** ;
 *  - quand l'orchestrateur rend son résultat, la cascade emporte la sous-tâche
 *    qu'il n'a pas attendue : **aucune tâche active en base** ensuite.
 *
 * L'identifiant de la sous-tâche n'existe pas quand le scénario s'écrit : le
 * faux fournisseur le reprend du résultat de `delegate_task` (`{{task_id}}`).
 *
 * S'y ajoute une régression du moteur trouvée par la suite de sécurité (X5) :
 * une tâche annulée **pendant sa préparation** finissait `failed`, et le motif
 * d'une annulation conclue par le moteur se perdait.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { loadConfig } from '@midgaard/contracts'
import { reconcileAgents, startDaemon, type Daemon } from '@midgaard/daemon'
import { startFakeProvider, type FakeProvider } from '../fake-provider.ts'

let home: string
let project: string
let daemon: Daemon
let provider: FakeProvider

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'midgaard-orch-'))
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-orch-projet-')))
  writeFileSync(join(project, 'README.md'), '# Projet\n')
  provider = await startFakeProvider()
  const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
  // La clé passe par l'environnement injecté du daemon, pas par le coffre :
  // ces tests n'ont rien à déposer dans celui de la machine.
  daemon = (await startDaemon(config, {
    log: () => {},
    env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-orchestrateur' },
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
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe('orchestrateur sur le vrai moteur', () => {
  it('attend sa sous-tâche, et en reçoit le résultat comme donnée', async () => {
    provider.scripts.set('[orch-attend]', [
      [{ tool: 'delegate_task', args: { agent_id: 'researcher', objective: '[enfant-attendu] lis' } }],
      [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
      [{ tool: 'submit_result', args: { summary: 'synthèse' } }],
    ])
    provider.scripts.set('[enfant-attendu]', [[{ tool: 'submit_result', args: { summary: 'le README dit Projet' } }]])

    const created = daemon.tasks.create({
      objective: '[orch-attend] orchestre', agentId: 'orchestrator', context: null, projectDir: project,
      durationS: 20, needsApproval: false,
    })
    assert.ok(!('error' in created), JSON.stringify(created))
    const done = await daemon.tasks.wait(created.task.id, 20_000, 0)
    assert.equal(done?.task.status, 'completed', done?.task.error ?? '')
    const [child] = daemon.store.childTasks(created.task.id)
    assert.equal(child?.status, 'completed', 'attendue jusqu\'au bout, pas annulée')
    const waited = daemon.store.toolCalls(created.task.id).find((c) => c.name === 'wait_for_task')
    assert.equal(waited?.status, 'succeeded')
    // Le résultat de l'enfant est entré encadré : celui du parent est donc non fiable.
    assert.equal(done?.task.result?.untrusted, true)
  })

  it('reçoit le port, délègue, et ne laisse aucune sous-tâche derrière lui', async () => {
    provider.scripts.set('[orch-1]', [
      [{ tool: 'list_agents', args: {} }],
      [{ tool: 'delegate_task', args: { agent_id: 'researcher', objective: '[enfant-1] cherche', context: 'rien' } }],
      [{ tool: 'submit_result', args: { summary: 'délégué' } }],
    ])
    // L'enfant tourne en même temps sur le même faux fournisseur, et ne finit
    // jamais seul : il ne s'arrête que par la cascade.
    provider.scripts.set('[enfant-1]', [[{ tool: 'list_directory', args: { path: '.' } }], { text: 'je réfléchis' }])

    const created = daemon.tasks.create({
      objective: '[orch-1] orchestre', agentId: 'orchestrator', context: null, projectDir: project,
      durationS: 20, needsApproval: false,
    })
    assert.ok(!('error' in created), JSON.stringify(created))
    const parent = created.task
    const done = await daemon.tasks.wait(parent.id, 20_000, 0)
    assert.equal(done?.task.status, 'completed', done?.task.error ?? '')

    const calls = daemon.store.toolCalls(parent.id)
    const status = (name: string) => calls.find((c) => c.name === name)?.status
    assert.equal(status('list_agents'), 'succeeded', 'le port a été posé')
    assert.equal(status('delegate_task'), 'succeeded')

    const children = daemon.store.childTasks(parent.id)
    assert.equal(children.length, 1)
    assert.equal(children[0]!.agent_id, 'researcher')
    assert.equal(children[0]!.project_dir, project)

    // La cascade est différée d'une micro-tâche, et l'enfant s'arrête à son
    // prochain point de contrôle : on attend sa fin plutôt que de la supposer.
    const child = await daemon.tasks.wait(children[0]!.id, 10_000, 0)
    assert.equal(child?.task.status, 'cancelled', child?.task.error ?? '')
    assert.equal(daemon.store.childTasks(parent.id, { active: true }).length, 0, 'aucune sous-tâche active en base')
  })

  it('dit au modèle qu\'il est un orchestrateur, sans nommer Claude', () => {
    const system = provider.systems.get('[orch-1]') ?? ''
    assert.match(system, /Orchestrator agent/)
    assert.doesNotMatch(system, /claude|anthropic/i)
  })
})

describe('annulation pendant la préparation', () => {
  it('conclut en cancelled, avec son motif, et non en failed', async () => {
    // Un vrai dépôt : le Developer y crée son worktree, l'attente la plus longue
    // de sa préparation — celle où l'annulation tombait.
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-orch-prep-')))
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@example.org', '-c', 'commit.gpgsign=false', ...a], {
        cwd: repo,
        stdio: 'ignore',
      })
    try {
      git('init', '-q', '-b', 'main')
      writeFileSync(join(repo, 'README.md'), '# Projet\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'initial')
      provider.scripts.set('[prep]', [[{ tool: 'submit_result', args: { summary: 'jamais' } }]])
      const created = daemon.tasks.create({
        objective: '[prep] trop tard', agentId: 'developer', context: null, projectDir: repo,
        durationS: 20, needsApproval: false,
      })
      assert.ok(!('error' in created), JSON.stringify(created))
      // Aussitôt : le moteur est entré dans sa préparation, pas encore en marche.
      const asked = daemon.tasks.cancel(created.task.id, 'tâche parente annulée')
      assert.ok(!('error' in asked))
      const done = await daemon.tasks.wait(created.task.id, 15_000, 0)
      assert.equal(done?.task.status, 'cancelled', done?.task.error ?? '')
      assert.match(done?.task.error ?? '', /^tâche parente annulée/)
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
