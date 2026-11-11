/**
 * @file L'onglet « Navigateur » de l'atelier (Slice 7, étape 6) : ce que voit
 * l'agent, au fil de ses actions, et le moyen de l'arrêter.
 *
 * Quatre choix :
 *  - **la capture vient de la mémoire du daemon**, jamais de la base : elle est
 *    redemandée chaque fois que le journal dit qu'elle a pu changer, et une
 *    session fermée ne la rend plus. L'onglet garde alors la dernière vue, et
 *    le dit ;
 *  - **la demande d'approbation s'affiche au-dessus de la capture** : l'humain
 *    lit le texte qu'il approuve en regardant la page où il partira ;
 *  - **l'adresse et le titre sont du texte**, jamais un lien : ils sont écrits
 *    par la page, et un clic ouvrirait le vrai navigateur de l'utilisateur, avec
 *    ses sessions, sur une adresse choisie par elle ;
 *  - **« Couper la session » est un acte humain**, sans confirmation : arrêter
 *    doit être plus simple que laisser faire. L'agent l'apprend à son action
 *    suivante, et une saisie approuvée ensuite ne part pas.
 */
import { useEffect, useMemo, useState } from 'react'
import { Globe, Unplug } from 'lucide-react'
import type { Approval, Task, TaskEvent } from '@midgaard/contracts'
import { ApiError, closeBrowser, fetchBrowser, fetchBrowserFrame } from '@/lib/api'
import { browserSummary, type BrowserSummary } from '@/lib/browser'
import { speaker } from '@/lib/thread'
import { timeUntil } from '@/lib/utils'
import { ApprovalPanel } from './ApprovalPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

/**
 * Les tâches d'un arbre qui ont ouvert un navigateur, la plus récente en
 * dernier. Exporté pour que l'atelier sache s'il doit montrer l'onglet.
 */
export function browserSources(tasks: readonly Task[], events: Record<string, TaskEvent[] | undefined>): BrowserSummary[] {
  return tasks
    .map((t) => browserSummary(t.id, events[t.id]))
    .filter((s): s is BrowserSummary => s !== null)
    .sort((a, b) => a.frameSeq - b.frameSeq)
}

export function BrowserPanel({
  tasks,
  events,
  approvals,
  root,
  onError,
}: {
  /** L'arbre affiché : sa racine et ses sous-tâches. */
  tasks: Task[]
  events: Record<string, TaskEvent[] | undefined>
  approvals: Approval[]
  root: Task
  onError: (message: string | null) => void
}) {
  const sources = useMemo(() => browserSources(tasks, events), [tasks, events])
  const [chosen, setChosen] = useState<string | null>(null)
  // Par défaut, la session la plus récemment active : c'est celle que l'agent pilote.
  const summary = sources.find((s) => s.taskId === chosen) ?? sources.at(-1) ?? null
  const task = tasks.find((t) => t.id === summary?.taskId) ?? null
  const approval = approvals.find((a) => a.task_id === summary?.taskId) ?? null

  const [frame, setFrame] = useState<{ url: string; title: string } | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [cutting, setCutting] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // La capture est redemandée à chaque événement qui a pu la changer. Une
  // session fermée n'en rend plus : on garde la dernière image vue.
  const taskId = summary?.taskId ?? null
  const frameSeq = summary?.frameSeq ?? 0
  const open = summary?.open ?? false
  useEffect(() => {
    if (!taskId || !open) return
    let abandoned = false
    let made: string | null = null
    Promise.all([fetchBrowser(taskId), fetchBrowserFrame(taskId)])
      .then(([info, blob]) => {
        if (abandoned) return
        made = URL.createObjectURL(blob)
        setImage((previous) => {
          if (previous) URL.revokeObjectURL(previous)
          return made
        })
        setFrame(info.frame)
      })
      .catch(() => {
        // Pas encore de capture (la session démarre), ou déjà fermée : l'image
        // affichée reste la dernière vue, et l'état de la session le dit.
      })
    return () => {
      abandoned = true
    }
  }, [taskId, frameSeq, open])
  // L'URL `blob:` vit dans la page : libérée quand on change de tâche.
  useEffect(() => () => setImage((previous) => (previous && URL.revokeObjectURL(previous), null)), [taskId])

  if (!summary || !task) {
    return (
      <div className="grid h-full place-items-center p-6 text-sm text-muted" data-testid="browser-panel">
        Aucun agent de cet arbre n'a ouvert de navigateur.
      </div>
    )
  }

  async function cut(): Promise<void> {
    if (!taskId) return
    setCutting(true)
    onError(null)
    try {
      await closeBrowser(taskId)
    } catch (e) {
      onError(e instanceof ApiError && e.status === 409 ? 'la session était déjà fermée' : `coupure refusée : ${(e as Error).message}`)
    } finally {
      setCutting(false)
    }
  }

  const remaining = summary.open && summary.expiresAt ? timeUntil(summary.expiresAt, now) : null
  const url = frame?.url ?? summary.lastUrl ?? summary.startUrl

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="browser-panel" data-task={summary.taskId}>
      <header className="space-y-1.5 border-b border-border bg-canvas px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <Globe className="size-3.5 text-muted" />
          {sources.length > 1 ? (
            <select
              className="rounded border border-border bg-surface px-1 py-0.5"
              value={summary.taskId}
              onChange={(e) => setChosen(e.target.value)}
              aria-label="Session affichée"
            >
              {sources.map((s) => {
                const t = tasks.find((x) => x.id === s.taskId)
                return (
                  <option key={s.taskId} value={s.taskId}>
                    {t ? speaker(t, t.id === root.id) : s.taskId.slice(0, 8)}
                  </option>
                )
              })}
            </select>
          ) : (
            <span className="font-medium">{speaker(task, task.id === root.id)}</span>
          )}
          <Badge tone={summary.open ? 'running' : 'neutral'} data-testid="browser-state">
            {summary.open ? 'session ouverte' : `fermée — ${summary.closedReason ?? ''}`}
          </Badge>
          {remaining && <span className="text-muted">expire dans {remaining}</span>}
          {summary.open && (
            <Button size="sm" variant="danger" className="ml-auto" onClick={() => void cut()} disabled={cutting} data-testid="browser-cut">
              <Unplug /> Couper la session
            </Button>
          )}
        </div>
        <p className="text-muted">
          Objectif approuvé : <span className="text-ink">{summary.objective}</span>
        </p>
        {summary.plannedInputs.length > 0 && (
          // Approuvés avec la session : chacun part une fois sans demande. Les
          // voir barrés au fil des saisies dit ce qui peut encore partir seul.
          <p className="text-muted" data-testid="browser-planned">
            Textes prévus :{' '}
            {summary.plannedInputs.map((p, i) => (
              <span key={i} className={p.used ? 'line-through' : 'text-ink'} title={p.used ? 'déjà tapé' : 'peut partir sans nouvelle demande'}>
                {i > 0 && ' ; '}
                {JSON.stringify(p.text)}
                {p.pressEnter && ' ↵'}
              </span>
            ))}
          </p>
        )}
        <p className="truncate font-mono" title={url} data-testid="browser-url">
          {url}
        </p>
      </header>

      {approval && (
        <div className="border-b border-border p-3">
          <ApprovalPanel approval={approval} onError={onError} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto bg-canvas p-3">
        {image ? (
          <figure className="space-y-1">
            <img
              src={image}
              alt={`Capture du navigateur : ${frame?.title || url}`}
              className="max-w-full rounded border border-border"
              data-testid="browser-frame"
            />
            <figcaption className="text-[11px] text-muted">
              {summary.open
                ? `Dernière capture vue par l'agent, après ${summary.actions} action(s).`
                : 'Session fermée : voici la dernière capture vue ici. Le daemon ne garde aucune capture.'}
            </figcaption>
          </figure>
        ) : (
          <p className="text-sm text-muted">
            {summary.open ? 'En attente de la première capture…' : 'Session fermée. Le daemon ne garde aucune capture.'}
          </p>
        )}
      </div>
    </div>
  )
}
