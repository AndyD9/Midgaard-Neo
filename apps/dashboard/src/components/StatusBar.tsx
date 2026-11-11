/**
 * @file Bandeau supérieur : état de la connexion et santé du daemon.
 *
 * L'état de la connexion est affiché en permanence, et c'est important : un
 * dashboard temps réel qui a perdu sa WebSocket continue d'afficher des données
 * d'apparence normale. Sans ce témoin, on croirait qu'il ne se passe rien.
 */
import { Activity, CircleAlert, Database, FolderOpen, Plug, PlugZap, Timer } from 'lucide-react'
import type { Health } from '@midgaard/contracts'
import type { ConnectionStatus } from '@/lib/useHarness'
import { Badge } from './ui/badge'

const CONNECTION: Record<ConnectionStatus, { label: string; tone: 'running' | 'done' | 'danger' }> = {
  connecting: { label: 'connexion…', tone: 'running' },
  open: { label: 'en direct', tone: 'done' },
  closed: { label: 'déconnecté', tone: 'danger' },
}

/**
 * Dossier runtime du daemon, tiré du chemin de sa base.
 *
 * Affiché en clair, pas seulement au survol : deux installations sur une même
 * machine ont deux daemons et deux dashboards, et rien d'autre ne les
 * distinguait. À l'essai de la Slice 4 (étape 8, leçon n° 33), l'auteur a
 * cherché une approbation sur `127.0.0.1:7777`, le dashboard de l'autre
 * installation : la page était vide et rien ne disait pourquoi.
 */
function runtimeDir(dbPath: string): string {
  return dbPath.replace(/[\\/][^\\/]+$/, '')
}

/** Millisecondes en texte court, pour le compte à rebours d'inactivité. */
function shortDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  return `${Math.round(ms / 60_000)} min`
}

export function StatusBar({
  status,
  health,
  error,
  gap,
}: {
  status: ConnectionStatus
  health: Health | null
  error: string | null
  gap: boolean
}) {
  const connection = CONNECTION[status]
  return (
    <header className="border-b border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md bg-accent-soft text-accent">
            <Activity className="size-4" />
          </span>
          <span className="font-semibold tracking-tight">Midgaard</span>
        </div>

        <Badge tone={connection.tone}>
          {status === 'open' ? <PlugZap className="size-3" /> : <Plug className="size-3" />}
          {connection.label}
        </Badge>

        {health && (
          <>
            <span className="text-xs text-muted">pid {health.pid} · protocole {health.protocol}</span>
            <span className="flex items-center gap-1.5 text-xs text-muted" title={health.db_path}>
              <Database className="size-3.5" />
              {health.tasks.total} tâche(s), {health.tasks.active} active(s)
            </span>
            <span
              className="flex min-w-0 items-center gap-1.5 text-xs text-muted"
              title={`Dossier runtime de ce daemon : ${runtimeDir(health.db_path)}`}
              data-testid="runtime-dir"
            >
              <FolderOpen className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{runtimeDir(health.db_path)}</span>
            </span>
            {health.idle_shutdown_in_ms !== null && (
              <span
                className="flex items-center gap-1.5 text-xs text-muted"
                title="Le daemon s'arrête après une période sans tâche active, sans dashboard connecté et sans requête."
              >
                <Timer className="size-3.5" />
                arrêt auto dans {shortDuration(health.idle_shutdown_in_ms)}
              </span>
            )}
          </>
        )}
      </div>

      {(error || gap) && (
        <div className="flex flex-col gap-1 border-t border-danger/30 bg-danger/10 px-5 py-2 text-xs text-danger">
          {error && (
            <span className="flex items-center gap-2">
              <CircleAlert className="size-3.5" /> {error}
            </span>
          )}
          {gap && (
            <span className="flex items-center gap-2">
              <CircleAlert className="size-3.5" />
              Reconnexion trop tardive : l'historique intermédiaire n'a pas pu être rejoué. L'état courant
              est à jour ; ouvre une tâche pour recharger sa timeline complète.
            </span>
          )}
        </div>
      )}
    </header>
  )
}
