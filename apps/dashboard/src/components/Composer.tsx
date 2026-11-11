/**
 * @file L'invite de la vue terminal : la saisie vers l'orchestrateur, et
 * l'image qu'un agent a lue.
 *
 * Trois choix, hérités du panneau de conversation de l'atelier d'origine :
 *  - **la saisie ne s'ouvre que lorsque l'orchestrateur attend votre réponse** :
 *    le daemon refuse un message à une tâche qui travaille, et un champ ouvert
 *    qui refuse ensuite ferait croire à une panne. Le motif est affiché à la place ;
 *  - **le texte est rendu comme du texte** : il vient d'agents, qui ont pu lire
 *    le web. React l'échappe, rien n'en est interprété — ni Markdown, ni HTML ;
 *  - **une conversation ne survit pas au daemon**, et l'invite le dit tant
 *    qu'elle est en cours : la règle `interrupted` est un invariant, pas un
 *    défaut à cacher ;
 *  - **une tâche terminée ne repart pas, mais on peut rebondir dessus** : sous
 *    la tâche finie d'un orchestrateur, la saisie ouvre une **suite** — une
 *    nouvelle tâche, qui reçoit le relevé de la première et ses agents créés.
 *    L'invite le dit : ce que l'orchestrateur avait lu n'est plus en mémoire.
 *
 * Une image lue par un agent est relue **sur le disque**. Aucune image n'est
 * gardée par le daemon : si le fichier a changé depuis, son empreinte diffère
 * de celle journalisée, et le flux le dit plutôt que de montrer une autre image
 * comme celle que l'agent a vue.
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import type { Task } from '@midgaard/contracts'
import { ApiError, continueTask, fetchTaskImage, postMessage } from '@/lib/api'
import { canContinue, composerState } from '@/lib/thread'

/** Statuts où une conversation est encore en cours. */
const ACTIVE = ['queued', 'preparing', 'running', 'waiting_approval', 'waiting_input']

/**
 * L'image qu'un agent a lue, relue sur le disque. Montrée seulement si son
 * empreinte est celle que `read_image` a journalisée : sinon, ce ne serait pas
 * l'image que l'agent a vue, et le flux le dit.
 *
 * @param taskId       tâche dont le dossier porte l'image
 * @param path         chemin journalisé par l'outil, relatif à la tâche
 * @param sha256Prefix début de l'empreinte journalisée à la lecture
 */
export function ReadImage({ taskId, path, sha256Prefix }: { taskId: string; path: string; sha256Prefix: string }) {
  const [state, setState] = useState<{ url: string } | { note: string } | null>(null)
  useEffect(() => {
    let abandoned = false
    let made: string | null = null
    fetchTaskImage(taskId, path)
      .then(({ blob, sha256 }) => {
        if (abandoned) return
        if (!sha256?.startsWith(sha256Prefix)) {
          setState({ note: 'Le fichier a changé depuis que l\'agent l\'a lu : il n\'est pas montré.' })
          return
        }
        made = URL.createObjectURL(blob)
        setState({ url: made })
      })
      .catch((e: unknown) => {
        if (!abandoned) setState({ note: e instanceof ApiError && e.reason ? `Image illisible : ${e.reason}.` : 'Image illisible.' })
      })
    return () => {
      abandoned = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [taskId, path, sha256Prefix])
  if (!state) return null
  if ('note' in state) return <span className="block text-[11px] text-muted" data-testid="chat-image-note">{state.note}</span>
  return <img src={state.url} alt={`Image lue par l'agent : ${path}`} className="my-1 block max-h-48 rounded border border-border" data-testid="chat-image" />
}

/**
 * L'invite vers l'orchestrateur : ouverte seulement quand la conversation
 * attend votre réponse. Entrée envoie, Maj+Entrée va à la ligne ; « conclure »
 * demande à l'orchestrateur de finir.
 *
 * Sous une tâche **terminée** d'orchestrateur, la même saisie sert à rebondir :
 * le message ouvre la tâche qui la prolonge, et la vue y passe.
 *
 * @param root        racine de l'arbre affiché : c'est à elle qu'on écrit
 * @param onError     remonte le motif d'un refus du daemon au bandeau
 * @param onContinued reçoit l'identifiant de la suite créée, pour l'afficher
 */
export function Composer({
  root,
  onError,
  onContinued,
}: {
  root: Task
  onError: (error: string | null) => void
  onContinued: (taskId: string) => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const state = composerState(root)
  const continuing = !state.open && canContinue(root)

  async function send(conclude: boolean): Promise<void> {
    if (sending || (!conclude && !text.trim())) return
    setSending(true)
    try {
      if (continuing) {
        const view = await continueTask(root.id, text.trim())
        setText('')
        onError(null)
        onContinued(view.task.id)
        return
      }
      await postMessage(root.id, text.trim(), conclude)
      setText('')
      onError(null)
    } catch (e) {
      onError(e instanceof ApiError && e.reason ? e.reason : `message refusé : ${(e as Error).message}`)
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Entrée envoie, Maj+Entrée va à la ligne : la convention des messageries.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(false)
    }
  }

  if (continuing) {
    return (
      <div className="border-t border-border px-3 py-2 font-mono text-[12px]">
        <div className="flex items-start gap-2">
          <span className="pt-0.5 text-accent" aria-hidden>
            ›
          </span>
          <textarea
            className="min-h-[1.5em] w-full resize-none bg-transparent leading-[1.5] text-ink outline-none placeholder:text-muted/60"
            rows={Math.min(8, Math.max(1, text.split('\n').length))}
            placeholder="rebondir sur cette tâche — Entrée ouvre la suite, Maj+Entrée va à la ligne"
            aria-label="Votre message pour continuer cette tâche"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending}
            data-testid="continue-input"
          />
          <button
            type="button"
            className="shrink-0 text-accent hover:text-ink disabled:opacity-40"
            onClick={() => void send(false)}
            disabled={sending || !text.trim()}
            data-testid="continue-send"
          >
            [continuer]
          </button>
        </div>
        {/* Dit ce qui se passe vraiment : une nouvelle tâche, pas celle-ci qui repart. */}
        <p className="mt-1 text-[11px] text-muted/70" data-testid="chat-closed">
          Cette tâche est terminée. Votre message ouvre une suite : une nouvelle tâche de l'orchestrateur, qui reçoit le
          résultat et le fil de celle-ci, et retrouve les agents qu'elle a créés. Ce qu'il avait lu n'est plus en mémoire : il
          le relira au besoin.
        </p>
      </div>
    )
  }
  if (!state.open) {
    return (
      <p className="border-t border-border px-3 py-2 font-mono text-xs text-muted" data-testid="chat-closed">
        <span className="text-muted/60">— </span>
        {state.reason}
      </p>
    )
  }
  return (
    <div className="border-t border-border px-3 py-2 font-mono text-[12px]">
      <div className="flex items-start gap-2">
        <span className="pt-0.5 text-accent" aria-hidden>
          ›
        </span>
        <textarea
          className="min-h-[1.5em] w-full resize-none bg-transparent leading-[1.5] text-ink outline-none placeholder:text-muted/60"
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          placeholder="votre réponse à l'orchestrateur — Entrée envoie, Maj+Entrée va à la ligne"
          aria-label="Votre réponse à l'orchestrateur"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
          data-testid="chat-input"
          autoFocus
        />
        <button
          type="button"
          className="shrink-0 text-muted hover:text-ink disabled:opacity-40"
          onClick={() => void send(true)}
          disabled={sending}
          data-testid="chat-conclude"
          title="Demande à l'orchestrateur de conclure"
        >
          [conclure]
        </button>
        <button
          type="button"
          className="shrink-0 text-accent hover:text-ink disabled:opacity-40"
          onClick={() => void send(false)}
          disabled={sending || !text.trim()}
          data-testid="chat-send"
        >
          [envoyer]
        </button>
      </div>
      {root.mode === 'chat' && ACTIVE.includes(root.status) && (
        <p className="mt-1 text-[11px] text-muted/70">Une conversation ne survit pas à un redémarrage du daemon.</p>
      )}
    </div>
  )
}
