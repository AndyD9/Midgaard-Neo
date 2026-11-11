/**
 * @file Machine à états : **toutes** les transitions, légales et illégales.
 *
 * C'est le test le plus important du lot. La machine à états décide de ce que le
 * harness a le droit de raconter : laisser passer une transition interdite, c'est
 * accepter qu'une tâche annulée finisse « terminée », ou qu'une tâche interrompue
 * reparte. On vérifie donc l'intégralité de la matrice, pas quelques cas choisis.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ACTIVE_STATUSES,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  canTransition,
  isActionable,
  isTerminal,
  nextActionFor,
  type TaskStatus,
} from '@midgaard/contracts'

describe('statuts', () => {
  it('sépare exactement actifs et finaux, sans recouvrement ni oubli', () => {
    assert.equal(ACTIVE_STATUSES.length + TERMINAL_STATUSES.length, TASK_STATUSES.length)
    for (const s of ACTIVE_STATUSES) assert.equal(isTerminal(s), false, s)
    for (const s of TERMINAL_STATUSES) assert.equal(isTerminal(s), true, s)
  })

  it('décrit une transition pour chaque statut', () => {
    for (const s of TASK_STATUSES) assert.ok(Array.isArray(TRANSITIONS[s]), `${s} absent de TRANSITIONS`)
  })
})

describe('transitions', () => {
  it("n'autorise aucune sortie d'un statut final", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of TASK_STATUSES) {
        assert.equal(canTransition(from, to), false, `${from} → ${to} ne devrait pas être permis`)
      }
    }
  })

  it('rend tout statut actif interruptible', () => {
    // `interrupted` est appliqué en bloc au redémarrage : si un seul statut actif
    // n'y menait pas, une tâche resterait active à jamais après un crash.
    for (const from of ACTIVE_STATUSES) {
      assert.equal(canTransition(from, 'interrupted'), true, `${from} → interrupted`)
    }
  })

  it('refuse la matrice complète des transitions non déclarées', () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const declared = TRANSITIONS[from].includes(to)
        assert.equal(canTransition(from, to), declared, `${from} → ${to}`)
      }
    }
  })

  it('refuse les retours en arrière les plus tentants', () => {
    const forbidden: [TaskStatus, TaskStatus][] = [
      ['completed', 'running'],
      ['cancelled', 'running'],
      ['interrupted', 'running'],
      ['running', 'queued'],
      ['running', 'preparing'],
      ['cancelled', 'completed'],
    ]
    for (const [from, to] of forbidden) assert.equal(canTransition(from, to), false, `${from} → ${to}`)
  })

  it('ne fait sortir une attente de message que pour continuer, annuler, expirer ou interrompre', () => {
    // Le message reçu relance la boucle, et c'est elle qui conclut : aucune
    // fin, réussie ou non, ne se décide pendant l'attente (Slice 6).
    assert.deepEqual([...TRANSITIONS.waiting_input].sort(), ['cancel_requested', 'interrupted', 'running', 'timed_out'])
    assert.equal(canTransition('running', 'waiting_input'), true)
    for (const to of ['completed', 'failed', 'budget_exceeded', 'cancelled', 'waiting_approval'] as TaskStatus[]) {
      assert.equal(canTransition('waiting_input', to), false, `waiting_input → ${to}`)
    }
    // Une approbation se tranche, elle ne se change pas en attente de message.
    assert.equal(canTransition('waiting_approval', 'waiting_input'), false)
  })

  it("laisse une tâche en cours d'annulation se terminer quand même", () => {
    // Une tâche peut franchir sa dernière étape avant d'avoir pris connaissance
    // de l'annulation. Mentir sur ce qui s'est passé serait pire.
    assert.equal(canTransition('cancel_requested', 'completed'), true)
  })
})

describe('nextActionFor', () => {
  const cases: [TaskStatus, string][] = [
    ['queued', 'call_wait_for_task_again'],
    ['preparing', 'call_wait_for_task_again'],
    ['running', 'call_wait_for_task_again'],
    ['cancel_requested', 'call_wait_for_task_again'],
    ['waiting_approval', 'human_approval_pending'],
    // Claude ne délègue que des tâches oneshot, qui n'y entrent jamais ; si
    // l'une y entrait, attendre encore resterait la seule consigne juste.
    ['waiting_input', 'call_wait_for_task_again'],
    ['completed', 'result_ready'],
    ['failed', 'task_ended_without_result'],
    ['cancelled', 'task_ended_without_result'],
    ['timed_out', 'task_ended_without_result'],
    ['budget_exceeded', 'task_ended_without_result'],
    ['interrupted', 'task_ended_without_result'],
  ]
  for (const [status, expected] of cases) {
    it(`${status} → ${expected}`, () => assert.equal(nextActionFor({ status }), expected))
  }

  it('couvre tous les statuts', () => {
    assert.equal(cases.length, TASK_STATUSES.length)
  })
})

describe('isActionable', () => {
  it("n'interrompt pas une attente tant que la tâche avance", () => {
    for (const status of ['queued', 'preparing', 'running', 'waiting_input', 'cancel_requested'] as TaskStatus[]) {
      assert.equal(isActionable({ status, approval_seq: 0 }), false, status)
    }
  })

  it('interrompt toujours sur une fin de tâche', () => {
    for (const status of TERMINAL_STATUSES) {
      assert.equal(isActionable({ status, approval_seq: 3 }, 99), true, status)
    }
  })

  it("n'annonce une pause qu'une fois au même client", () => {
    // Correctif du défaut n° 2 de la Slice 0 : rappeler l'attente sur une pause
    // déjà signalée rendait la main aussitôt, et le client renonçait à attendre.
    const paused = { status: 'waiting_approval' as const, approval_seq: 1 }
    assert.equal(isActionable(paused, 0), true, 'première annonce')
    assert.equal(isActionable(paused, 1), false, 'pause déjà signalée')
  })

  it('annonce une seconde pause sur la même tâche', () => {
    // Inévitable avec de vrais agents : plusieurs opérations sensibles par tâche.
    assert.equal(isActionable({ status: 'waiting_approval', approval_seq: 2 }, 1), true)
  })
})
