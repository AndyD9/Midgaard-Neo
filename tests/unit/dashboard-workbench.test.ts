/**
 * @file L'interface terminal du dashboard : les fonctions pures du flux, de la
 * saisie, du navigateur et des timelines, sans rendu.
 *
 * Ce qui pourrait mentir à l'écran sans qu'aucun rendu ne le montre :
 *  - **le flux ne laisse passer aucune séquence d'échappement** d'une sortie
 *    de commande, ni d'un argument : une séquence qui efface l'écran ou réécrit
 *    une ligne ferait voir à l'humain autre chose que ce qui s'est passé, au
 *    moment même où il décide d'une approbation ;
 *  - **le flux suit l'ordre du journal** et dit qui parle, sans inventer de
 *    ligne — une note du harness n'y passe pas pour une parole de l'agent ;
 *  - **la saisie ne s'ouvre que lorsque la conversation attend** l'utilisateur ;
 *  - **le navigateur** : l'état de la session se lit dans le journal, la
 *    capture n'est redemandée qu'après un événement qui l'a changée, et elle
 *    ne reprend le premier plan qu'à une **nouvelle** session ;
 *  - **une image lue** entre au flux avec l'empreinte journalisée, que la vue
 *    compare à celle du fichier relu ;
 *  - **une timeline chargée pendant que la tâche avance ne perd rien** : ce que
 *    la WebSocket diffuse pendant la requête survit à sa réponse ;
 *  - **une page plus vieille que son daemon le voit** : le script que désigne
 *    l'`index.html` servi n'est plus le sien. Dans le doute, elle ne se
 *    recharge pas.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyUsage, type Task, type TaskEvent } from '@midgaard/contracts'
import { composerState } from '../../apps/dashboard/src/lib/thread.ts'
import { buildStream, plain } from '../../apps/dashboard/src/lib/stream.ts'
import { browserSummary, closedReasonText } from '../../apps/dashboard/src/lib/browser.ts'
import { appendEvent, mergeTimeline, unwatchTimeline, watchTimeline, type Timelines } from '../../apps/dashboard/src/lib/timeline.ts'
import { bundleChanged, moduleScript } from '../../apps/dashboard/src/lib/bundle.ts'

const ROOT = '00000000-0000-4000-8000-000000000001'
const CHILD = '00000000-0000-4000-8000-000000000002'

/** Une tâche minimale. */
function task(id: string, over: Partial<Task> = {}): Task {
  const at = '2026-11-03T10:00:00.000Z'
  return {
    id, objective: 'objectif', status: 'running', step: 0, steps_total: 1, agent_id: 'orchestrator', context: null,
    project_dir: '/p', parent_task_id: null, mode: 'chat', awaiting_input: null,
    usage: emptyUsage(), needs_approval: false, approval_seq: 0, duration_s: 1, created_at: at, updated_at: at,
    started_at: null, ended_at: null, result: null, error: null, ...over,
  }
}

let seq = 0
/** Un événement, numéroté dans l'ordre d'écriture. */
function ev(taskId: string, type: TaskEvent['type'], payload: Record<string, unknown> = {}, status: Task['status'] = 'running'): TaskEvent {
  seq++
  return { seq, task_seq: seq, task_id: taskId, type, at: '2026-11-03T10:00:00.000Z', status, payload }
}

describe('flux terminal : une commande et sa sortie', () => {
  it('montre la commande entière, sa sortie et sa fin, et nettoie aussi la ligne de commande', () => {
    seq = 0
    const events = {
      [CHILD]: [
        ev(CHILD, 'tool.requested', { tool_call_id: 't1', name: 'exec', decision: 'approval', arguments: JSON.stringify({ command: 'npm', args: ['test', '\x1b[2J', 'a;b'] }) }),
        ev(CHILD, 'exec.output', { tool_call_id: 't1', stream: 'stdout', text: 'ok\n' }),
        ev(CHILD, 'exec.output', { tool_call_id: 't1', stream: 'stderr', text: 'avert\n' }),
        ev(CHILD, 'tool.completed', { tool_call_id: 't1', status: 'succeeded', summary: 'code 0' }),
      ],
    }
    const lines = buildStream([{ taskId: ROOT, label: 'orchestrator' }, { taskId: CHILD, label: 'developer·0000' }], events)
    assert.equal(lines[0]!.tag, 'developer·0000', 'la sous-tâche est nommée en tête de ligne')
    assert.match(lines[0]!.text, /^\$ npm test /)
    assert.match(lines[0]!.text, /"a;b"/, 'un argument qui porte un caractère de shell est cité')
    assert.match(lines[0]!.text, /sous approbation/)
    assert.doesNotMatch(lines[0]!.text, /\x1b/, 'la séquence glissée dans un argument est retirée aussi')
    assert.deepEqual(lines.slice(1, 3).map((l) => [l.raw, l.text, l.tone]), [[true, 'ok\n', 'muted'], [true, 'avert\n', 'danger']])
    assert.equal(lines[3]!.text, 'code 0')
  })
})

describe('flux terminal : la conversation', () => {
  it('raconte qui dit quoi, dans l’ordre du journal ; une note du harness n’est pas une parole', () => {
    seq = 0
    const events = {
      [ROOT]: [ev(ROOT, 'task.created')],
      [CHILD]: [] as TaskEvent[],
    }
    events[CHILD].push(ev(CHILD, 'task.created'))
    events[ROOT].push(ev(ROOT, 'agent.message', { message: 'relance', note: true }))
    events[CHILD].push(ev(CHILD, 'input.requested', { request: 'proposal', text: 'route ajoutée' }, 'waiting_input'))
    events[CHILD].push(ev(CHILD, 'message.agent', { text: 'ajoute un test', from_task_id: ROOT }))
    events[ROOT].push(ev(ROOT, 'message.user', { text: 'merci' }))
    events[ROOT].push(ev(ROOT, 'agent.message', { message: 'C’est fait.' }))
    events[ROOT].push(ev(ROOT, 'task.completed', { result: { summary: 'route livrée', workspace: { branch: 'midgaard/x' } } }, 'completed'))

    const lines = buildStream(
      [{ taskId: ROOT, label: 'orchestrator', objective: 'aide-moi' }, { taskId: CHILD, label: 'developer', objective: 'ajoute /health' }],
      events,
    )
    assert.deepEqual(
      lines.map((l) => [l.tag, l.label, l.text]),
      [
        ['', 'tâche', 'aide-moi'],
        ['developer', 'tâche', 'ajoute /health'],
        ['', 'note', 'relance'],
        ['developer', 'attend', 'le verdict du parent — route ajoutée'],
        ['developer', 'parent', 'ajoute un test'],
        ['', 'vous', 'merci'],
        ['', 'message', 'C’est fait.'],
        ['', 'terminée', 'route livrée — branche midgaard/x'],
      ],
    )
  })

  it('n’ouvre la saisie que lorsque la conversation attend l’utilisateur', () => {
    assert.deepEqual(composerState(task(ROOT, { status: 'waiting_input', awaiting_input: 'chat' })), { open: true })
    for (const over of [
      { status: 'running' as const },
      { status: 'waiting_approval' as const },
      { status: 'completed' as const },
      { status: 'waiting_input' as const, awaiting_input: 'chat' as const, mode: 'oneshot' as const },
    ]) {
      const state = composerState(task(ROOT, over))
      assert.equal(state.open, false, JSON.stringify(over))
    }
  })
})

describe('le navigateur d\'une tâche (Slice 7)', () => {
  const NAV = '00000000-0000-4000-8000-000000000003'
  const action = (id: string, name: string, summary: string, status = 'succeeded') => [
    ev(NAV, 'tool.requested', { tool_call_id: id, name, decision: 'allow' }),
    ev(NAV, 'tool.completed', { tool_call_id: id, status, summary }),
  ]

  it('rien sans session ; ouverte, l\'adresse suit les actions, et la capture ne bouge qu\'après un événement du navigateur', () => {
    assert.equal(browserSummary(NAV, [ev(NAV, 'task.created')]), null)
    const opened = ev(NAV, 'browser.opened', {
      objective: 'lire', start_url: 'https://a.example/', max_duration_s: 60, expires_at: '2026-11-03T10:01:00.000Z',
    })
    const events = [opened, ...action('c1', 'browser_click', 'clicked (1, 2) → https://a.example/b')]
    const s = browserSummary(NAV, events)!
    assert.equal(s.open, true)
    assert.equal(s.lastUrl, 'https://a.example/b')
    assert.equal(s.actions, 1)
    assert.equal(s.openedSeq, opened.seq)
    const frameSeq = s.frameSeq
    // Un outil qui n'est pas du navigateur ne change pas la capture.
    const more = [...events, ...action('f1', 'read_file', 'src/a.ts')]
    assert.equal(browserSummary(NAV, more)!.frameSeq, frameSeq)
    // Une action refusée ne compte pas, mais peut avoir changé l'écran.
    const denied = [...more, ...action('t1', 'browser_type', 'x', 'failed')]
    assert.equal(browserSummary(NAV, denied)!.actions, 1)
  })

  it('les textes prévus se barrent au fil des saisies permises sans demande, et seulement elles', () => {
    const opened = ev(NAV, 'browser.opened', {
      objective: 'o', start_url: 'https://a.example/',
      planned_inputs: [{ text: 'pain', press_enter: true }, { text: 'pain', press_enter: true }, { text: 'CI', press_enter: false }],
    })
    const typed = (id: string, decision: string, args: Record<string, unknown>) =>
      ev(NAV, 'tool.requested', { tool_call_id: id, name: 'browser_type', decision, arguments: JSON.stringify(args) })
    const s = browserSummary(NAV, [
      opened,
      typed('t1', 'allow', { text: 'pain', press_enter: true }),
      // Approuvée à part : ce n'est pas un texte prévu qui a servi.
      typed('t2', 'approval', { text: 'CI', press_enter: false }),
      // Même texte, sans Entrée : ne correspond à aucun texte prévu.
      typed('t3', 'allow', { text: 'pain', press_enter: false }),
    ])!
    assert.deepEqual(
      s.plannedInputs.map((p) => `${p.text}${p.pressEnter ? '↵' : ''}:${p.used ? 'tapé' : 'reste'}`),
      ['pain↵:tapé', 'pain↵:reste', 'CI:reste'],
    )
    // Une session ouverte sans textes prévus, comme avant.
    assert.deepEqual(browserSummary(NAV, [ev(NAV, 'browser.opened', { objective: 'o', start_url: 'https://a.example/' })])!.plannedInputs, [])
  })

  it('fermée, elle dit pourquoi, en français ; une nouvelle session a une autre séquence d\'ouverture', () => {
    const first = ev(NAV, 'browser.opened', { objective: 'o', start_url: 'https://a.example/' })
    const closed = browserSummary(NAV, [first, ev(NAV, 'browser.closed', { reason: 'cut by the human operator' })])!
    assert.equal(closed.open, false)
    assert.equal(closed.closedReason, 'coupée par vous')
    const second = ev(NAV, 'browser.opened', { objective: 'o2', start_url: 'https://b.example/' })
    const again = browserSummary(NAV, [first, ev(NAV, 'browser.closed', { reason: 'the task ended' }), second])!
    assert.equal(again.open, true)
    assert.equal(again.objective, 'o2')
    assert.ok(again.openedSeq > closed.openedSeq)
    assert.equal(closedReasonText('something new'), 'something new', 'un motif inconnu reste tel quel, rien d\'inventé')
  })

  it('le flux montre une image lue, avec son chemin et le début de son empreinte ; pas un échec', () => {
    const root = task(ROOT, { agent_id: 'navigator', mode: 'oneshot' })
    const events = {
      [ROOT]: [
        ev(ROOT, 'task.created'),
        ev(ROOT, 'tool.requested', { tool_call_id: 'i1', name: 'read_image' }),
        ev(ROOT, 'tool.completed', { tool_call_id: 'i1', status: 'succeeded', summary: 'docs/maquette.png · image/png · 1401 octets · sha256 0123456789abcdef' }),
        ev(ROOT, 'tool.requested', { tool_call_id: 'i2', name: 'read_image' }),
        ev(ROOT, 'tool.completed', { tool_call_id: 'i2', status: 'failed', summary: null }),
      ],
    }
    const images = buildStream([{ taskId: root.id, label: 'navigator' }], events).filter((l) => l.image)
    assert.equal(images.length, 1)
    assert.deepEqual(images[0]!.image, { path: 'docs/maquette.png', sha256Prefix: '0123456789abcdef' })
    assert.equal(images[0]!.label, 'image')
  })
})

describe('les timelines, chargées pendant que la tâche avance', () => {
  const T = '00000000-0000-4000-8000-000000000009'

  it('un événement diffusé pendant le chargement survit à la réponse, qui ne le contenait pas', () => {
    // D14 échouait par intermittence ainsi : `read_image` finissait entre la
    // lecture du daemon et l'arrivée de la réponse, et l'image n'entrait
    // jamais au fil.
    seq = 0
    const created = ev(T, 'task.created')
    const started = ev(T, 'task.started')
    const imageRead = ev(T, 'tool.completed', { tool_call_id: 'i1', summary: 'maquette.png · image/png' })
    let t: Timelines = {}
    // Sans timeline ouverte, le direct n'invente rien.
    assert.equal(appendEvent(t, created), t)
    t = watchTimeline(t, T)
    t = appendEvent(t, imageRead)
    // La réponse a été lue par le daemon avant `imageRead`.
    t = mergeTimeline(t, T, [created, started])
    assert.deepEqual(t[T]!.map((e) => e.seq), [created.seq, started.seq, imageRead.seq])
  })

  it('fusionne sans doublon, dans l\'ordre de la tâche, et ferme une timeline dont le chargement a échoué', () => {
    seq = 0
    const a = ev(T, 'task.created')
    const b = ev(T, 'task.started')
    let t = watchTimeline({}, T)
    t = appendEvent(t, b)
    t = appendEvent(t, b)
    t = mergeTimeline(t, T, [b, a])
    assert.deepEqual(t[T]!.map((e) => e.seq), [a.seq, b.seq])
    // Ouvrir une timeline déjà chargée ne la vide pas.
    assert.equal(watchTimeline(t, T), t)
    // Un échec ne laisse pas une timeline partielle qui aurait l'air entière.
    assert.equal(unwatchTimeline(watchTimeline({}, T), T)[T], undefined)
  })
})

describe('une page plus vieille que son daemon', () => {
  // L'`index.html` tel que Vite l'écrit, attributs dans son ordre à lui.
  const served = (name: string) =>
    `<!doctype html><html><head><script type="module" crossorigin src="./assets/${name}.js"></script>` +
    `<link rel="stylesheet" crossorigin href="./assets/index.css"></head><body><div id="root"></div></body></html>`

  it('lit le script de module, attributs dans n’importe quel ordre', () => {
    assert.equal(moduleScript(served('index-AAA')), './assets/index-AAA.js')
    assert.equal(moduleScript(`<script src='/a.js' type='module'></script>`), '/a.js')
    // Un script classique n'est pas le bundle.
    assert.equal(moduleScript(`<script src="/legacy.js"></script><script type="module" src="/m.js"></script>`), '/m.js')
    assert.equal(moduleScript('<p>pas de script</p>'), null)
  })

  it('se sait périmée quand le daemon sert un autre bundle, et seulement alors', () => {
    assert.equal(bundleChanged('./assets/index-AAA.js', served('index-BBB')), true)
    assert.equal(bundleChanged('./assets/index-AAA.js', served('index-AAA')), false)
  })

  it('dans le doute, ne se recharge pas', () => {
    // La page d'aide d'un clone sans build n'a pas de script : quitter une
    // page qui marche pour elle serait pire.
    assert.equal(bundleChanged('./assets/index-AAA.js', '<html><body>npm run build</body></html>'), false)
    assert.equal(bundleChanged(null, served('index-BBB')), false)
  })
})

describe('flux terminal (Slice 10)', () => {
  it('plain retire TOUTES les séquences d\'échappement, couleur comprise, et les contrôles', () => {
    // La couleur n'est pas interprétée en HTML : la garder ferait voir des octets.
    assert.equal(plain('\x1b[32mok\x1b[0m fin'), 'ok fin')
    // Effacement, curseur, OSC, ESC isolé, contrôles : tout part, \n et \t restent.
    assert.equal(plain('a\x1b[2Jb\x1b[1;1Hc'), 'abc')
    assert.equal(plain('a\x1b]0;titre\x07b'), 'ab')
    assert.equal(plain('a\x1bcb\x00c\x07d'), 'abcd')
    assert.equal(plain('ligne1\nligne2\tfin'), 'ligne1\nligne2\tfin')
  })

  it('fond l\'arbre en un flux ordonné par séquence globale, la racine sans étiquette', () => {
    seq = 0
    const e1 = ev(ROOT, 'task.started', {}, 'running')
    const e2 = ev(CHILD, 'tool.requested', { name: 'read_file', tool_call_id: 'c0', decision: 'allow' }, 'running')
    const e3 = ev(ROOT, 'task.progress', { step: 2, steps_total: 5 })
    const events = { [ROOT]: [e1, e3], [CHILD]: [e2] }
    const lines = buildStream(
      [{ taskId: ROOT, label: 'orchestrator' }, { taskId: CHILD, label: 'researcher' }],
      events,
    )
    assert.deepEqual(lines.map((l) => l.seq), [e1.seq, e2.seq, e3.seq], 'ordre global du journal')
    assert.equal(lines[0]!.tag, '', 'la racine n\'a pas d\'étiquette')
    assert.equal(lines[1]!.tag, 'researcher', 'une sous-tâche porte son profil')
    assert.equal(lines[1]!.label, 'outil')
    assert.equal(lines[1]!.text, 'read_file')
    assert.equal(lines[2]!.text, '2/5')
  })

  it('une sortie exec devient une ligne brute nettoyée, stderr en danger', () => {
    seq = 0
    const req = ev(ROOT, 'tool.requested', { name: 'exec', tool_call_id: 'c1', decision: 'allow' })
    const out = ev(ROOT, 'exec.output', { tool_call_id: 'c1', stream: 'stderr', text: 'boom\x1b[2J\n' })
    const lines = buildStream([{ taskId: ROOT, label: 'developer' }], { [ROOT]: [req, out] })
    const raw = lines.find((l) => l.raw)!
    assert.ok(raw, 'une ligne brute pour la sortie')
    assert.equal(raw.text, 'boom\n', 'la séquence d\'effacement est retirée')
    assert.equal(raw.tone, 'danger', 'stderr en danger')
  })

  it('un type d\'événement inconnu garde son nom, en sourdine (daemon plus récent)', () => {
    seq = 0
    const e = ev(ROOT, 'quelque.chose.de.neuf' as TaskEvent['type'], {})
    const lines = buildStream([{ taskId: ROOT, label: 'orchestrator' }], { [ROOT]: [e] })
    assert.equal(lines[0]!.label, 'quelque.chose.de.neuf')
    assert.equal(lines[0]!.tone, 'muted')
  })
})
