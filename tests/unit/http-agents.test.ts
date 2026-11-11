/**
 * @file Slice 5, étape 2, vue du client : `PATCH /api/agents/:id` et le
 * rattachement d'une tâche à son parent, sur un vrai daemon démarré dans le
 * processus de test.
 *
 * Ce que ces tests couvrent, et pourquoi :
 *  - le fournisseur et le modèle d'un profil se règlent par l'API, selon les
 *    règles de `updateAgentModel` — et **rien d'autre** : des limites glissées
 *    dans le corps sont ignorées, sinon un client relèverait le budget ;
 *  - un client qui envoie `parent_task_id` à `POST /api/tasks` ne rattache
 *    rien (Slice 5, décision 8). On lit la tâche **en base**, pas seulement la
 *    réponse : c'est la ligne qui décidera de l'annulation en cascade ;
 *  - le profil `orchestrator` livré à l'étape 4 : désactivé avec son motif
 *    sans fournisseur, actif avec un fournisseur, sans écriture, ni `exec`,
 *    ni web — et seul à recevoir les outils de délégation.
 *
 * Le fournisseur est écrit directement dans le dépôt, sans clé : aucun appel
 * modèle n'a lieu ici, et passer par `POST /api/providers` toucherait au coffre
 * de la machine qui exécute la suite.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { daemonJson, loadConfig, readRuntime, type Agent, type RuntimeInfo, type TaskView } from '@midgaard/contracts'
import { reconcileAgents, startDaemon, type Daemon } from '@midgaard/daemon'
import { DELEGATION_TOOLS } from '@midgaard/tools'

let home: string
let daemon: Daemon
let rt: RuntimeInfo

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'midgaard-http-agents-'))
  const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
  // Coffre fichier : le daemon ne sonde pas le coffre de la machine, qu'aucun
  // de ces tests n'emploie.
  daemon = (await startDaemon(config, { log: () => {}, env: { MIDGAARD_VAULT: 'file' } }))!
  rt = readRuntime(config.runtimeFile)!
  for (const id of ['venice', 'autre']) {
    daemon.store.upsertProvider({
      id,
      name: id,
      kind: 'openai-compatible',
      preset: 'venice',
      baseUrl: null,
      defaultModel: `${id}-defaut`,
      secretRef: null,
      webSearch: 'off',
    })
  }
})

after(async () => {
  daemon.close('fin des tests')
  await daemon.stopped
  rmSync(home, { recursive: true, force: true })
})

/** `PATCH /api/agents/:id`, corps JSON. */
function patch(id: string, body: unknown) {
  return daemonJson<{ agent?: Agent; error?: string; available?: string[] }>(rt, `/api/agents/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** `PUT /api/agents/:id/limits`, corps JSON. */
function putLimits(id: string, body: unknown) {
  return daemonJson<{ agent?: Agent; error?: string }>(rt, `/api/agents/${id}/limits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('plus aucune limite', () => {
  it('la route des limites n\'existe plus, et un profil n\'en porte pas', async () => {
    const r = await putLimits('researcher', { timeout_s: 900, by: 'test' })
    assert.equal(r.status, 404)
    const agent = daemon.store.getAgent('researcher')!
    assert.ok(!('limits' in agent))
  })

  it('une tâche créée n\'en porte pas non plus, même si le client en envoie', async () => {
    const created = await daemonJson<TaskView>(rt, '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'simulated', objective: 'avec limites', limits: { max_steps: 1, max_cost_usd: 0 } }),
    })
    assert.equal(created.status, 201)
    assert.ok(!('limits' in created.body.task))
    assert.ok(!('limits' in daemon.store.getTask(created.body.task.id)!))
  })
})

describe('PATCH /api/agents/:id', () => {
  it('choisit le fournisseur et le modèle, et le profil le garde', async () => {
    const r = await patch('researcher', { provider_id: 'venice', model: 'qwen-3' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.agent?.provider_id, 'venice')
    assert.equal(r.body.agent?.model, 'qwen-3')
    assert.equal(daemon.store.getAgent('researcher')?.model, 'qwen-3', 'écrit en base, pas seulement rendu')
  })

  it('remet le modèle à celui par défaut quand le fournisseur change sans modèle', async () => {
    await patch('developer', { provider_id: 'venice', model: 'qwen-3' })
    const r = await patch('developer', { provider_id: 'autre' })
    assert.equal(r.status, 200)
    assert.equal(r.body.agent?.provider_id, 'autre')
    assert.equal(r.body.agent?.model, null, 'un nom de modèle n\'a de sens que chez son fournisseur')
  })

  it('garde le modèle quand le fournisseur ne change pas', async () => {
    await patch('developer', { provider_id: 'venice', model: 'qwen-3' })
    const r = await patch('developer', { provider_id: 'venice' })
    assert.equal(r.body.agent?.model, 'qwen-3')
  })

  it('accepte null pour revenir au modèle par défaut', async () => {
    await patch('researcher', { model: 'qwen-3' })
    const r = await patch('researcher', { model: null })
    assert.equal(r.status, 200)
    assert.equal(r.body.agent?.model, null)
  })

  it('refuse un fournisseur inconnu, et nomme ceux qui existent', async () => {
    const before = daemon.store.getAgent('researcher')
    const r = await patch('researcher', { provider_id: 'fantome' })
    assert.equal(r.status, 404)
    assert.equal(r.body.error, 'provider_not_found')
    assert.deepEqual(r.body.available?.sort(), ['autre', 'venice'])
    assert.deepEqual(daemon.store.getAgent('researcher'), before, 'rien n\'a changé')
  })

  it('refuse le profil simulé, qui n\'appelle aucun modèle', async () => {
    const r = await patch('simulated', { model: 'qwen-3' })
    assert.equal(r.status, 409)
    assert.equal(r.body.error, 'agent_has_no_model')
  })

  it('refuse un profil inconnu, un corps vide et un modèle blanc', async () => {
    assert.equal((await patch('personne', { model: 'x' })).status, 404)
    assert.equal((await patch('researcher', {})).status, 400)
    assert.equal((await patch('researcher', { model: '   ' })).status, 400)
  })

  it('n\'admet ni PATCH sur la liste ni DELETE sur un profil', async () => {
    const list = await daemonJson(rt, '/api/agents', { method: 'PATCH', body: '{}' })
    assert.equal(list.status, 405)
    const del = await daemonJson(rt, '/api/agents/researcher', { method: 'DELETE' })
    assert.equal(del.status, 405)
  })
})

describe('rattachement d\'une tâche à son parent', () => {
  it('ignore un parent_task_id envoyé par un client', async () => {
    const parent = await daemonJson<TaskView>(rt, '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'parent', duration_s: 60 }),
    })
    assert.equal(parent.status, 201)
    assert.equal(parent.body.task.parent_task_id, null)

    const child = await daemonJson<TaskView>(rt, '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'faux enfant', duration_s: 60, parent_task_id: parent.body.task.id }),
    })
    assert.equal(child.status, 201)
    assert.equal(child.body.task.parent_task_id, null, 'réponse')
    assert.equal(daemon.store.getTask(child.body.task.id)?.parent_task_id, null, 'base')

    for (const t of [parent, child]) await daemonJson(rt, `/api/tasks/${t.body.task.id}/cancel`, { method: 'POST' })
  })
})

describe('profil orchestrator', () => {
  it('est livré désactivé sans fournisseur, et refuse une tâche en disant pourquoi', async () => {
    // Les fournisseurs de ces tests sont écrits sans `reconcileAgents` : pour
    // le daemon, il n'y en avait aucun au démarrage.
    const agent = await daemonJson<{ agent: Agent }>(rt, '/api/agents/orchestrator')
    assert.equal(agent.status, 200)
    assert.equal(agent.body.agent.kind, 'orchestrator')
    assert.equal(agent.body.agent.enabled, false)
    const before = daemon.store.countTasks().total
    const r = await daemonJson<{ error?: string; reason?: string }>(rt, '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'o', agent_id: 'orchestrator', project_dir: home }),
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.error, 'agent_disabled')
    assert.match(r.body.reason ?? '', /fournisseur/)
    assert.equal(daemon.store.countTasks().total, before)
  })

  it('s\'active avec un fournisseur, et ne reçoit ni écriture, ni exec, ni web', () => {
    reconcileAgents(daemon.store)
    const agent = daemon.store.getAgent('orchestrator')!
    assert.equal(agent.enabled, true)
    for (const tool of ['list_agents', 'delegate_task', 'wait_for_task', 'cancel_task', 'submit_result']) {
      assert.ok(agent.tools.includes(tool), tool)
    }
    for (const tool of ['write_file', 'edit_file', 'delete_file', 'exec', 'http_fetch', 'web_search', 'git_diff']) {
      assert.ok(!agent.tools.includes(tool), `${tool} ne doit pas lui être donné`)
    }
  })

  it('n\'est donné à aucun autre profil : la délégation reste à l\'orchestrateur', () => {
    for (const agent of daemon.store.listAgents()) {
      if (agent.kind === 'orchestrator') continue
      assert.ok(!agent.tools.some((t) => DELEGATION_TOOLS.includes(t as never)), agent.id)
    }
  })
})

describe('dossier de projet à la création', () => {
  it('refuse un dossier invalide avant toute création, et dit pourquoi', async () => {
    const before = daemon.store.countTasks().total
    const r = await daemonJson<{ error?: string; reason?: string }>(rt, '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'o', agent_id: 'researcher', project_dir: join(home, 'absent') }),
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'invalid_project_dir')
    assert.match(r.body.reason ?? '', /n'existe pas/)
    assert.equal(daemon.store.countTasks().total, before)
  })

  it('ne vérifie rien pour le profil simulé, qui ne lit aucun dossier', async () => {
    const r = await daemonJson<TaskView>(rt, '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'o', duration_s: 60, project_dir: join(home, 'absent') }),
    })
    assert.equal(r.status, 201)
    assert.equal(r.body.task.project_dir, null)
    await daemonJson(rt, `/api/tasks/${r.body.task.id}/cancel`, { method: 'POST' })
  })
})
