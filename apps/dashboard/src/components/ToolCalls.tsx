/**
 * @file Appels d'outils d'une tâche : ce que l'exécutant a réellement fait.
 *
 * C'est la raison d'être du produit — « Claude Code sait déléguer, mais on ne
 * voit rien de ce que font les exécutants ». Cette liste est ce qu'on voit.
 *
 * Les arguments affichés sont ceux **expurgés** par le harness avant
 * persistance : si une clé avait traversé un outil, elle n'est ni en base ni
 * ici.
 *
 * Un appel à un outil d'un serveur MCP (Slice 8) porte le nom du serveur : son
 * résultat est toujours non fiable, et l'humain doit savoir d'où il vient.
 */
import { useEffect, useState } from 'react'
import { ChevronRight, Wrench } from 'lucide-react'
import type { ToolCall, ToolCallStatus } from '@midgaard/contracts'
import { fetchToolCalls } from '@/lib/api'
import { splitMcpName } from '@/lib/mcp'
import { Badge, type BadgeTone } from './ui/badge'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

/** Ton de chaque issue d'appel. Un refus n'est pas un échec, et se lit différemment. */
const TONE: Record<ToolCallStatus, BadgeTone> = {
  requested: 'neutral',
  awaiting_approval: 'waiting',
  running: 'running',
  succeeded: 'done',
  failed: 'danger',
  denied: 'danger',
  rejected: 'waiting',
}

export function ToolCalls({ taskId, version }: { taskId: string; version: number }) {
  const [calls, setCalls] = useState<ToolCall[] | null>(null)

  // Rechargé quand `version` change — c'est-à-dire à chaque événement `tool.*`
  // reçu en direct. Recharger à chaque événement de tâche ferait une requête par
  // mise à jour de consommation, pour rien.
  useEffect(() => {
    let abandoned = false
    fetchToolCalls(taskId)
      .then((body) => {
        if (!abandoned) setCalls(body.tool_calls)
      })
      .catch(() => {
        if (!abandoned) setCalls([])
      })
    return () => {
      abandoned = true
    }
  }, [taskId, version])

  if (!calls || calls.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="size-4 text-muted" /> Appels d'outils
        </CardTitle>
        <span className="text-xs text-muted">{calls.length}</span>
      </CardHeader>
      <CardBody className="space-y-2 p-0">
        <ul className="divide-y divide-border">
          {calls.map((call) => (
            <li key={call.id} className="px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{call.name}</span>
                {splitMcpName(call.name) && (
                  <Badge tone="neutral" data-testid={`tool-call-mcp-${call.id}`}>
                    MCP · {splitMcpName(call.name)!.server}
                  </Badge>
                )}
                <Badge tone={TONE[call.status]}>{call.status}</Badge>
                {call.decision !== 'allow' && <Badge tone="waiting">{call.decision}</Badge>}
                <span className="ml-auto font-mono text-[11px] text-muted">
                  étape {call.step}
                  {call.duration_ms !== null && ` · ${call.duration_ms} ms`}
                </span>
              </div>
              <ArgumentLine json={call.arguments_json} />
              {call.result_summary && <p className="mt-1 text-xs text-muted">{call.result_summary}</p>}
              {call.error && <p className="mt-1 text-xs text-danger">{call.error}</p>}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

/** Arguments sur une ligne, dépliables. Tronqués : un contenu long noierait la liste. */
function ArgumentLine({ json }: { json: string }) {
  const [open, setOpen] = useState(false)
  if (!json || json === '{}') return null
  const compact = json.length > 120 ? `${json.slice(0, 120)}…` : json
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className="mt-1 flex w-full items-start gap-1 text-left font-mono text-[11px] text-muted hover:text-ink"
    >
      <ChevronRight className={`mt-0.5 size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      <span className={open ? 'break-all whitespace-pre-wrap' : 'truncate'}>{open ? json : compact}</span>
    </button>
  )
}
