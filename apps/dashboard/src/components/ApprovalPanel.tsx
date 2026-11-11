/**
 * @file Panneau d'approbation : le seul endroit du dashboard qui débloque une
 * tâche.
 *
 * Deux choses y sont explicites, et pas par hasard :
 *
 *  - **ce qui est autorisé**, en toutes lettres (`operation`), puis sous sa
 *    forme exacte (`operation_detail`). Pour une commande, chaque argument est
 *    affiché **séparément** : `a;b` et `a ; b` ne doivent pas se lire pareil.
 *    Une approbation vaut pour cette opération précise et pour elle seule ;
 *  - **le délai restant**. Passé ce délai, la demande expire et la tâche
 *    s'arrête en `timed_out` — mieux vaut le voir venir que le découvrir après.
 */
import { useEffect, useState } from 'react'
import { Check, ShieldQuestion, X } from 'lucide-react'
import type { Approval } from '@midgaard/contracts'
import { approve, reject } from '@/lib/api'
import { timeUntil } from '@/lib/utils'
import { Button } from './ui/button'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

export function ApprovalPanel({
  approval,
  onError,
}: {
  approval: Approval
  onError: (message: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  // Le compte à rebours se rafraîchit seul : une demande expirée doit cesser de
  // paraître actionnable, même si personne ne touche à la page.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const remaining = timeUntil(approval.expires_at, now)

  /** Envoie la décision. Le daemon rejette toute seconde décision : pas de course possible. */
  async function decide(kind: 'approve' | 'reject'): Promise<void> {
    setBusy(true)
    onError(null)
    try {
      if (kind === 'approve') await approve(approval.id)
      else await reject(approval.id, reason.trim() || undefined)
    } catch (e) {
      onError(`décision refusée : ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="border-waiting/40 bg-waiting/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-waiting">
          <ShieldQuestion className="size-4" />
          Décision humaine requise
        </CardTitle>
        <span className="text-xs text-muted">
          {remaining ? `expire dans ${remaining}` : 'expirée'}
        </span>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm">
          <span className="text-muted">Opération : </span>
          {approval.operation}
        </p>
        {approval.operation_detail && <OperationDetail detail={approval.operation_detail} />}
        <p className="font-mono text-[11px] text-muted" title="Empreinte de l'opération exacte : une décision ne vaut que pour elle.">
          {approval.id} · {approval.operation_hash.slice(0, 16)}…
        </p>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Motif du refus (facultatif)"
          className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <div className="flex gap-2">
          <Button onClick={() => decide('approve')} disabled={busy || !remaining}>
            <Check /> Approuver
          </Button>
          <Button variant="danger" onClick={() => decide('reject')} disabled={busy || !remaining}>
            <X /> Refuser
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

/**
 * L'opération exacte. Une commande est détaillée champ par champ ; tout autre
 * outil est montré en JSON, tel qu'il a été haché — rien n'est résumé.
 */
function OperationDetail({ detail }: { detail: Record<string, unknown> }) {
  if (detail.tool === 'exec' && Array.isArray(detail.args)) {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-surface p-2.5 text-xs">
        <dt className="text-muted">Programme</dt>
        <dd className="break-all font-mono" data-testid="approval-program">{String(detail.program)}</dd>
        <dt className="text-muted">Arguments</dt>
        <dd>
          {detail.args.length === 0 ? (
            <span className="text-muted">aucun</span>
          ) : (
            <ol className="space-y-0.5" data-testid="approval-args">
              {detail.args.map((arg, i) => (
                // Un argument par ligne, encadré : ses espaces et ses `;` se
                // voient comme faisant partie de lui.
                <li key={i} className="break-all font-mono">
                  <span className="text-muted">{i + 1}. </span>
                  <span className="rounded bg-waiting/10 px-1">{String(arg)}</span>
                </li>
              ))}
            </ol>
          )}
        </dd>
        <dt className="text-muted">Dossier</dt>
        <dd className="break-all font-mono">{String(detail.cwd)}</dd>
        <dt className="text-muted">Délai</dt>
        <dd>{String(detail.timeout_s)} s</dd>
      </dl>
    )
  }
  return (
    <pre className="max-h-48 overflow-auto rounded-md border border-border bg-surface p-2.5 text-xs">
      {JSON.stringify(detail, null, 2)}
    </pre>
  )
}
