/**
 * @file Une conversation avec l'orchestrateur (Slice 6, étape 2), sur le **vrai
 * moteur d'agent** : un daemon démarré dans le processus de test et un faux
 * fournisseur compatible OpenAI, sans réseau ni dépense.
 *
 * `agent-runtime.test.ts` éprouve la boucle seule, avec un crochet pilotable.
 * Ce fichier prouve le câblage, que rien d'autre ne voit :
 *  - une réplique sans outil met la tâche en `waiting_input` (chat), et le
 *    message de l'utilisateur la relance **dans la même conversation** ;
 *  - « Conclure » ajoute la consigne du harness, et la tâche finit sur
 *    `submit_result`, pas sur l'attente ;
 *  - le message est **expurgé avant d'être écrit**, et l'agent lit la version
 *    expurgée ;
 *  - seul un orchestrateur de premier niveau converse, et un message n'est
 *    accepté que par une conversation qui l'attend ;
 *  - une annulation pendant l'attente laisse **zéro tâche active en base**, et
 *    une attente oubliée expire en `timed_out` ;
 *  - une **approbation** oubliée aussi, et l'appel est inscrit « aucune
 *    décision humaine », jamais « refusé par un humain » (Slice 7, étape 8).
 *
 * Le faux fournisseur compte les répliques déjà dans la conversation pour
 * choisir la suivante : c'est ce qui prouve que la reprise se fait dans la
 * même conversation, et non dans une nouvelle.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { daemonJson, loadConfig, readRuntime, type Task, type TaskStatus, type TaskView } from '@midgaard/contracts'
import { reconcileAgents, startDaemon, type Daemon } from '@midgaard/daemon'
import { startFakeProvider, type FakeProvider } from '../fake-provider.ts'

let project: string
let provider: FakeProvider
const homes: string[] = []
const daemons: Daemon[] = []
/** Fichier de découverte de chaque daemon démarré : port et jeton, pour parler HTTP. */
const runtimeFiles = new Map<Daemon, string>()

/**
 * Démarre un daemon sur un dossier runtime neuf, déclare le faux fournisseur et
 * réconcilie les profils.
 *
 * @param env variables de délai propres au scénario (expiration)
 */
async function boot(env: Record<string, string> = {}): Promise<Daemon> {
  const home = mkdtempSync(join(tmpdir(), 'midgaard-chat-'))
  homes.push(home)
  const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0', ...env })
  // La clé passe par l'environnement injecté du daemon, pas par le coffre :
  // ces tests n'ont rien à déposer dans celui de la machine.
  const daemon = (await startDaemon(config, {
    log: () => {},
    env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-conversation' },
  }))!
  daemon.store.upsertProvider({
    id: 'faux', name: 'faux', kind: 'openai-compatible', preset: 'custom', baseUrl: provider.url,
    defaultModel: 'faux-1', secretRef: null, webSearch: 'off',
  })
  reconcileAgents(daemon.store)
  daemons.push(daemon)
  runtimeFiles.set(daemon, config.runtimeFile)
  return daemon
}

/** Attend qu'une tâche atteigne un statut, en lisant la base — jamais une supposition. */
async function until(daemon: Daemon, id: string, status: TaskStatus, ms = 10_000): Promise<Task> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const task = daemon.store.getTask(id)
    if (task?.status === status) return task
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.fail(`tâche ${id} : ${status} attendu, ${daemon.store.getTask(id)?.status} constaté`)
}

/** Ouvre une conversation avec l'orchestrateur. */
function converse(daemon: Daemon, objective: string): Task {
  const created = daemon.tasks.create({
    objective, agentId: 'orchestrator', context: null, projectDir: project,
    durationS: 20, needsApproval: false, conversation: true,
  })
  assert.ok(!('error' in created), JSON.stringify(created))
  return created.task
}

let daemon: Daemon

before(async () => {
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-chat-projet-')))
  writeFileSync(join(project, 'README.md'), '# Projet\n')
  provider = await startFakeProvider()
  daemon = await boot()
})

after(async () => {
  for (const d of daemons) {
    d.close('fin des tests')
    await d.stopped
  }
  provider.server.close()
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe('conversation avec l\'orchestrateur', () => {
  it('attend l\'utilisateur, reprend dans la même conversation, et conclut sur submit_result', async () => {
    provider.scripts.set('[chat-deux-tours]', [
      { text: 'Quel fichier dois-je lire ?' },
      { text: 'Lu. Autre chose ?' },
      [{ tool: 'submit_result', args: { summary: 'le README dit Projet' } }],
    ])
    const task = converse(daemon, '[chat-deux-tours] aide-moi')
    assert.equal(task.mode, 'chat', 'posé par le daemon')

    const first = await until(daemon, task.id, 'waiting_input')
    assert.equal(first.awaiting_input, 'chat')
    const answered = daemon.tasks.postMessage(task.id, { text: 'le README', conclude: false, by: 'dashboard' })
    assert.ok(!('error' in answered), JSON.stringify(answered))
    assert.equal(answered.task.status, 'running')
    assert.equal(answered.task.awaiting_input, null)

    await until(daemon, task.id, 'waiting_input')
    const concluded = daemon.tasks.postMessage(task.id, { text: '', conclude: true, by: 'dashboard' })
    assert.ok(!('error' in concluded), JSON.stringify(concluded))
    const done = await daemon.tasks.wait(task.id, 10_000, 0)
    assert.equal(done?.task.status, 'completed', done?.task.error ?? '')
    assert.equal(done?.task.result?.summary, 'le README dit Projet')

    const events = daemon.store.taskEvents(task.id)
    const types = events.map((e) => e.type).filter((t) => t === 'input.requested' || t === 'message.user')
    assert.deepEqual(types, ['input.requested', 'message.user', 'input.requested', 'message.user'])
    const messages = events.filter((e) => e.type === 'message.user')
    assert.equal(messages[0]!.payload.text, 'le README')
    assert.equal(messages[0]!.status, 'running', 'le message et la reprise sont une seule écriture')
    assert.equal(messages[1]!.payload.conclude, true)
    assert.match(String(messages[1]!.payload.text), /conclude now\. Call submit_result/)

    const system = provider.systems.get('[chat-deux-tours]') ?? ''
    assert.match(system, /CONVERSATION with the human user/)
  })

  it('écrit le message expurgé, et c\'est la version expurgée que lit l\'agent', async () => {
    // Le faux fournisseur garde la dernière conversation reçue : c'est ce que
    // l'agent a lu, et pas seulement ce que le journal raconte.
    provider.scripts.set('[chat-secret]', [{ text: 'Donne-moi la clé.' }, { text: 'Reçu.' }])
    const task = converse(daemon, '[chat-secret] garde un secret')
    await until(daemon, task.id, 'waiting_input')
    const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
    const sent = daemon.tasks.postMessage(task.id, { text: `voici ${key}`, conclude: false, by: 'dashboard' })
    assert.ok(!('error' in sent))
    await until(daemon, task.id, 'waiting_input')
    const message = daemon.store.taskEvents(task.id).find((e) => e.type === 'message.user')!
    assert.doesNotMatch(String(message.payload.text), /abcdefghijklmnopqrstuvwxyz/)
    assert.match(String(message.payload.text), /^voici /)
    const read = provider.received.get('[chat-secret]') ?? []
    const reply = read.find((m) => m.role === 'user' && (m.content ?? '').startsWith('voici '))
    assert.ok(reply, 'le message est arrivé à l\'agent')
    assert.equal(reply.content, message.payload.text, 'l\'agent lit ce que le journal garde')
    assert.ok(!JSON.stringify(read).includes(key), 'et la clé n\'est nulle part dans ce qu\'il a lu')
    daemon.tasks.cancel(task.id, 'fin du scénario')
    await until(daemon, task.id, 'cancelled')
  })

  it('refuse un message à une tâche qui ne converse pas, ou qui n\'attend rien', async () => {
    provider.scripts.set('[oneshot]', [[{ tool: 'submit_result', args: { summary: 'fini' } }]])
    const created = daemon.tasks.create({
      objective: '[oneshot] une fois', agentId: 'orchestrator', context: null, projectDir: project,
      durationS: 20, needsApproval: false,
    })
    assert.ok(!('error' in created))
    assert.equal(created.task.mode, 'oneshot')
    const refused = daemon.tasks.postMessage(created.task.id, { text: 'coucou', conclude: false, by: 'dashboard' })
    assert.ok('error' in refused)
    assert.equal(refused.error, 'task_not_conversational')

    provider.scripts.set('[chat-fini]', [[{ tool: 'submit_result', args: { summary: 'tout de suite' } }]])
    const chat = converse(daemon, '[chat-fini] réponds vite')
    await until(daemon, chat.id, 'completed')
    const late = daemon.tasks.postMessage(chat.id, { text: 'encore là ?', conclude: false, by: 'dashboard' })
    assert.ok('error' in late)
    assert.equal(late.error, 'task_not_awaiting_user')
    assert.equal(daemon.store.taskEvents(chat.id).filter((e) => e.type === 'message.user').length, 0, 'rien écrit')
  })

  it('refuse un message vide qui ne demande pas de conclure', async () => {
    provider.scripts.set('[chat-vide]', [{ text: 'Alors ?' }])
    const task = converse(daemon, '[chat-vide] parle')
    await until(daemon, task.id, 'waiting_input')
    const refused = daemon.tasks.postMessage(task.id, { text: '   ', conclude: false, by: 'dashboard' })
    assert.ok('error' in refused)
    assert.equal(refused.error, 'empty_message')
    assert.equal(daemon.store.getTask(task.id)?.status, 'waiting_input', 'toujours en attente')
    daemon.tasks.cancel(task.id)
    await until(daemon, task.id, 'cancelled')
  })

  it('ne laisse converser qu\'un orchestrateur', () => {
    const refused = daemon.tasks.create({
      objective: 'lis', agentId: 'researcher', context: null, projectDir: project,
      durationS: 20, needsApproval: false, conversation: true,
    })
    assert.ok('error' in refused)
    assert.equal(refused.error, 'conversation_unsupported')
  })

  it('annulée pendant l\'attente, elle s\'arrête sans laisser de tâche active', async () => {
    provider.scripts.set('[chat-annule]', [{ text: 'Je t\'écoute.' }])
    const task = converse(daemon, '[chat-annule] écoute')
    await until(daemon, task.id, 'waiting_input')
    const asked = daemon.tasks.cancel(task.id, 'l\'utilisateur s\'en va')
    assert.ok(!('error' in asked))
    const done = await until(daemon, task.id, 'cancelled')
    assert.match(done.error ?? '', /^l'utilisateur s'en va/)
    assert.equal(done.awaiting_input, null)
    assert.equal(daemon.store.countTasks().active, 0, 'aucune tâche active en base')
  })
})

describe('par HTTP, comme le dashboard', () => {
  /** `POST` JSON sur l'API du daemon principal. */
  async function post(path: string, body: unknown) {
    const rt = readRuntime(runtimeFiles.get(daemon)!)!
    return daemonJson<TaskView & { error?: string }>(rt, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('ouvre une conversation, y répond, et dit pourquoi elle refuse', async () => {
    provider.scripts.set('[chat-http]', [{ text: 'Oui ?' }, [{ tool: 'submit_result', args: { summary: 'ok' } }]])
    const created = await post('/api/tasks', {
      objective: '[chat-http] bonjour', agent_id: 'orchestrator', project_dir: project, conversation: true,
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.task.mode, 'chat')
    const id = created.body.task.id

    await until(daemon, id, 'waiting_input')
    const invalid = await post(`/api/tasks/${id}/messages`, { text: 42 })
    assert.equal(invalid.status, 400)
    const answered = await post(`/api/tasks/${id}/messages`, { text: 'fais-le' })
    assert.equal(answered.status, 200, JSON.stringify(answered.body))
    assert.equal(answered.body.task.status, 'running')
    await until(daemon, id, 'completed')

    const late = await post(`/api/tasks/${id}/messages`, { text: 'encore' })
    assert.equal(late.status, 409)
    assert.equal(late.body.error, 'task_not_awaiting_user')
    const unknown = await post('/api/tasks/00000000-0000-4000-8000-000000000000/messages', { text: 'x' })
    assert.equal(unknown.status, 404)
    const researcher = await post('/api/tasks', {
      objective: 'lis', agent_id: 'researcher', project_dir: project, conversation: true,
    })
    assert.equal(researcher.status, 409)
    assert.equal(researcher.body.error, 'conversation_unsupported')
  })

  it('ne laisse pas un client poser le mode lui-même', async () => {
    // Le champ est inconnu du schéma : zod l'écarte, et la tâche reste oneshot.
    provider.scripts.set('[mode-force]', [[{ tool: 'submit_result', args: { summary: 'ok' } }]])
    const created = await post('/api/tasks', {
      objective: '[mode-force] essaie', agent_id: 'orchestrator', project_dir: project, mode: 'chat',
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.task.mode, 'oneshot')
    await until(daemon, created.body.task.id, 'completed')
  })
})

describe('conversation oubliée', () => {
  it('expire en timed_out quand l\'utilisateur ne répond pas', async () => {
    // Un daemon à délais courts : l'attente expire au bout d'une seconde, et le
    // balayage tourne toutes les 500 ms.
    const quick = await boot({ MIDGAARD_INPUT_TTL_S: '1', MIDGAARD_APPROVAL_TTL_S: '1' })
    provider.scripts.set('[chat-oublie]', [{ text: 'Tu es là ?' }])
    const created = quick.tasks.create({
      objective: '[chat-oublie] attends', agentId: 'orchestrator', context: null, projectDir: project,
      durationS: 20, needsApproval: false, conversation: true,
    })
    assert.ok(!('error' in created))
    await until(quick, created.task.id, 'waiting_input')
    const done = await until(quick, created.task.id, 'timed_out', 5_000)
    assert.match(done.error ?? '', /aucune réponse de l'utilisateur/)
    // Le verdict de la boucle réveillée est ignoré : un seul événement de fin.
    await new Promise((r) => setTimeout(r, 200))
    const ends = quick.store.taskEvents(created.task.id).filter((e) => e.type.startsWith('task.') && e.status === 'timed_out')
    assert.equal(ends.length, 1)
    assert.equal(quick.store.countTasks().active, 0)
  })
})

describe('approbation oubliée', () => {
  it('expire en timed_out, sans inscrire un refus que personne n\'a donné', async () => {
    // Vu à l'essai réel de la Slice 7 : la session d'un Navigator a expiré, et
    // son appel était inscrit « refusé par un humain ». Sous la politique HTTP
    // `approval`, un `http_fetch` attend l'humain ; personne ne répond.
    const quick = await boot({ MIDGAARD_APPROVAL_TTL_S: '1', MIDGAARD_HTTP_POLICY: 'approval' })
    provider.scripts.set('[approbation-oubliee]', [
      [{ tool: 'http_fetch', args: { url: 'https://example.org/' } }],
      [{ tool: 'submit_result', args: { summary: 'jamais atteint', details: 'x' } }],
    ])
    const created = quick.tasks.create({
      objective: '[approbation-oubliee] lis la page', agentId: 'researcher', context: null, projectDir: project,
      durationS: 20, needsApproval: false,
    })
    assert.ok(!('error' in created), JSON.stringify(created))
    await until(quick, created.task.id, 'waiting_approval')
    const done = await until(quick, created.task.id, 'timed_out', 5_000)
    assert.match(done.error ?? '', /aucune décision humaine/)
    // La boucle réveillée inscrit la fin de l'appel : qu'elle l'ait fait, puis ce qu'elle dit.
    let completed: Record<string, unknown> | undefined
    for (let i = 0; i < 50 && !completed; i++) {
      completed = quick.store.taskEvents(created.task.id).find((e) => e.type === 'tool.completed')?.payload
      if (!completed) await new Promise((r) => setTimeout(r, 20))
    }
    assert.ok(completed, 'la fin de l\'appel est au journal')
    assert.equal(completed.status, 'denied')
    assert.equal(completed.error, 'aucune décision humaine dans le délai')
    assert.equal(quick.store.countTasks().active, 0)
  })

  /** Les journaux de fin d'appel d'une tâche, une fois que la boucle les a tous écrits. */
  async function completions(quick: Awaited<ReturnType<typeof boot>>, taskId: string, count: number) {
    let found: Record<string, unknown>[] = []
    for (let i = 0; i < 100 && found.length < count; i++) {
      found = quick.store.taskEvents(taskId).filter((e) => e.type === 'tool.completed').map((e) => e.payload)
      if (found.length < count) await new Promise((r) => setTimeout(r, 20))
    }
    return found
  }

  it('n\'inscrit pas « refusé par un humain » pour l\'appel suivant, qu\'aucun humain n\'a vu', async () => {
    // Premier essai réel de la Slice 8 : deux appels REA dans la même étape ;
    // le premier a expiré, et le second — pour lequel aucune demande n'a pu
    // être créée, la tâche étant finie — était inscrit « refusé par un humain ».
    const quick = await boot({ MIDGAARD_APPROVAL_TTL_S: '1', MIDGAARD_HTTP_POLICY: 'approval' })
    provider.scripts.set('[deux-appels]', [
      [
        { tool: 'http_fetch', args: { url: 'https://example.org/a' } },
        { tool: 'http_fetch', args: { url: 'https://example.org/b' } },
      ],
      [{ tool: 'submit_result', args: { summary: 'jamais atteint', details: 'x' } }],
    ])
    const created = quick.tasks.create({
      objective: '[deux-appels] lis les pages', agentId: 'researcher', context: null, projectDir: project,
      durationS: 20, needsApproval: false,
    })
    assert.ok(!('error' in created), JSON.stringify(created))
    await until(quick, created.task.id, 'timed_out', 5_000)
    const [first, second] = await completions(quick, created.task.id, 2)
    assert.equal(first?.error, 'aucune décision humaine dans le délai')
    assert.equal(second?.status, 'denied')
    assert.equal(second?.error, 'tâche arrêtée : aucune approbation demandée')
    const requested = quick.store.taskEvents(created.task.id).filter((e) => e.type === 'approval.requested')
    assert.equal(requested.length, 1, 'une seule demande a été créée : le second appel n\'a sollicité personne')
  })

  it('n\'inscrit pas « refusé par un humain » quand la tâche est annulée pendant l\'attente', async () => {
    // Une annulation de la tâche — par un humain, ou par la cascade d'un parent
    // fini — n'est pas un refus de l'opération : personne ne l'a jugée.
    const quick = await boot({ MIDGAARD_HTTP_POLICY: 'approval' })
    provider.scripts.set('[annulee-en-attente]', [
      [{ tool: 'http_fetch', args: { url: 'https://example.org/' } }],
      [{ tool: 'submit_result', args: { summary: 'jamais atteint', details: 'x' } }],
    ])
    const created = quick.tasks.create({
      objective: '[annulee-en-attente] lis la page', agentId: 'researcher', context: null, projectDir: project,
      durationS: 20, needsApproval: false,
    })
    assert.ok(!('error' in created), JSON.stringify(created))
    await until(quick, created.task.id, 'waiting_approval')
    quick.tasks.cancel(created.task.id, 'tâche parente terminée')
    await until(quick, created.task.id, 'cancelled', 5_000)
    const [completed] = await completions(quick, created.task.id, 1)
    assert.equal(completed?.status, 'denied')
    assert.equal(completed?.error, 'tâche arrêtée avant la décision humaine')
  })
})
