/**
 * @file Les serveurs MCP déclarés (Slice 8, étape 5) : leur dernier test, leur
 * catalogue, et les outils cochés libres.
 *
 * **Ce qui se fait ici** : tester la connexion (le daemon lance le serveur et
 * relit son catalogue), cocher ou décocher des outils. Cocher s'annonce et se
 * confirme, avec le même avertissement que `harness mcp allow` : c'est une
 * autorisation durable, et un outil MCP n'est pas borné au projet.
 *
 * **Ce qui ne se fait pas ici** : déclarer ou retirer un serveur. Un serveur
 * est un programme que le daemon lancera ; la CLI le résout par le `PATH` du
 * terminal de l'humain, rend absolus ses arguments-fichiers, et saisit une
 * valeur secrète sans écho. La carte donne les commandes exactes.
 *
 * Un outil coché que le serveur annonce désormais autrement est montré
 * **changé** : il redemande une approbation à chaque appel jusqu'à ce qu'on
 * le recoche (docs/SLICE8.md, décision 5).
 */
import { useCallback, useEffect, useState } from 'react'
import { PlugZap, RefreshCw, ShieldCheck } from 'lucide-react'
import type { McpCatalogEntry, McpServerView } from '@midgaard/contracts'
import { ApiError, allowMcpTools, fetchMcpServers, revokeMcpTools, testMcpServer } from '@/lib/api'
import { allowWarning, hintsOf, readOnlyCandidates } from '@/lib/mcp'
import { formatDateTime } from '@/lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

/** La commande qui déclare REA, à recopier dans un terminal, à la racine du dépôt. */
const DECLARE_EXAMPLE = 'npm run harness -- mcp add rea -- node /chemin/vers/rea/scripts/rea.mjs mcp'

/** La carte des serveurs MCP, dans la vue « Profils ». */
export function McpServersCard() {
  const [servers, setServers] = useState<McpServerView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetchMcpServers()
      .then((body) => setServers(body.servers))
      .catch((e: unknown) => setError((e as Error).message))
  }, [])

  useEffect(load, [load])

  /** Remplace un serveur par sa nouvelle vue, rendue par le daemon. */
  const replace = (next: McpServerView) => setServers((list) => (list ?? []).map((s) => (s.id === next.id ? next : s)))

  return (
    <Card data-testid="mcp-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugZap className="size-4 text-muted" /> Serveurs MCP
        </CardTitle>
        <span className="text-xs text-muted">{servers ? `${servers.length} déclaré(s)` : ''}</span>
      </CardHeader>
      <CardBody className="space-y-4 text-sm">
        {error && <p className="text-xs text-danger">{error}</p>}
        {servers?.length === 0 && (
          <p className="text-xs text-muted" data-testid="mcp-empty">
            Aucun serveur MCP déclaré. Dans un terminal, à la racine du dépôt :{' '}
            <code className="rounded bg-canvas px-1 font-mono">{DECLARE_EXAMPLE}</code>
          </p>
        )}
        {servers?.map((s) => <ServerBlock key={s.id} server={s} onChange={replace} />)}
        <p className="border-t border-border pt-3 text-xs text-muted">
          Un serveur se déclare et se retire depuis un terminal, à la racine du dépôt (
          <code className="font-mono">npm run harness -- mcp add</code>,{' '}
          <code className="font-mono">mcp remove</code>) : son programme y est résolu par ton <code>PATH</code>, et une
          valeur secrète s'y saisit sans écho. Il se donne à un profil ci-dessus, ou par{' '}
          <code className="font-mono">npm run harness -- mcp attach rea researcher</code>.
        </p>
      </CardBody>
    </Card>
  )
}

/** Un serveur : son test, son catalogue, ses outils libres. */
function ServerBlock({ server, onChange }: { server: McpServerView; onChange: (s: McpServerView) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const test = server.last_test
  const free = server.tools.filter((t) => t.status === 'allowed').length
  const candidates = readOnlyCandidates(server.tools)

  /** Lance une action, montre son issue, et remplace la vue du serveur. */
  async function act(label: string, run: () => Promise<{ server: McpServerView }>, done: string): Promise<void> {
    setBusy(label)
    setMessage(null)
    try {
      const { server: next } = await run()
      onChange(next)
      setMessage({ ok: true, text: done })
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError && e.reason ? e.reason : (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  /** Cocher demande confirmation, avec l'avertissement de la CLI ; décocher, non. */
  function allow(names: string[]): void {
    if (!window.confirm(allowWarning(server.id, names))) return
    void act('allow', () => allowMcpTools(server.id, names), `${names.length} outil(s) libre(s) pour les tâches à venir`)
  }

  return (
    <section className="space-y-2 rounded-md border border-border p-3" data-testid={`mcp-server-${server.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-medium">{server.id}</span>
        {server.name !== server.id && <span className="text-xs text-muted">{server.name}</span>}
        <Badge tone={test?.ok ? 'done' : test ? 'danger' : 'neutral'} data-testid={`mcp-test-badge-${server.id}`}>
          {test ? (test.ok ? 'répond' : 'ne répond pas') : 'jamais testé'}
        </Badge>
        <span className="text-xs text-muted">
          {server.tools.length} outil(s), {free} libre(s)
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={busy !== null}
          onClick={() => void act('test', () => testMcpServer(server.id), 'catalogue relu')}
          data-testid={`mcp-test-${server.id}`}
        >
          <RefreshCw className={busy === 'test' ? 'animate-spin' : undefined} /> Tester la connexion
        </Button>
      </div>
      <p className="font-mono text-xs break-all text-muted">{[server.command, ...server.args].join(' ')}</p>
      {server.secret_env.length > 0 && (
        <p className="text-xs text-muted">Variables secrètes, au coffre : {server.secret_env.join(', ')}</p>
      )}
      {test && (
        <p className={test.ok ? 'text-xs text-muted' : 'text-xs whitespace-pre-wrap text-danger'} data-testid={`mcp-test-detail-${server.id}`}>
          {test.detail} — {formatDateTime(test.at)}
        </p>
      )}
      {message && (
        <p className={message.ok ? 'text-xs text-done' : 'text-xs text-danger'} role="status">
          {message.text}
        </p>
      )}

      {server.tools.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-xs text-muted">
              Catalogue lu le {server.catalog_at ? formatDateTime(server.catalog_at) : '—'}. Coché : appelé sans
              approbation. Sinon, chaque appel attend un humain.
            </span>
            {candidates.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => allow(candidates.map((t) => t.name))}
                data-testid={`mcp-allow-readonly-${server.id}`}
              >
                <ShieldCheck /> Cocher les outils de lecture ({candidates.length})
              </Button>
            )}
          </div>
          <ul className="divide-y divide-border rounded-md border border-border" data-testid={`mcp-tools-${server.id}`}>
            {server.tools.map((t) => (
              <ToolRow
                key={t.name}
                tool={t}
                disabled={busy !== null}
                onToggle={(checked) =>
                  checked
                    ? allow([t.name])
                    : void act('revoke', () => revokeMcpTools(server.id, [t.name]), `${t.name} : approuvé à chaque appel`)
                }
              />
            ))}
          </ul>
        </>
      )}
      {server.missing.length > 0 && (
        <p className="text-xs text-muted">Cochés mais plus annoncés : {server.missing.map((m) => m.name).join(', ')}</p>
      )}
    </section>
  )
}

/** Un outil du catalogue, et la case qui le rend libre. */
function ToolRow({ tool, disabled, onToggle }: { tool: McpCatalogEntry; disabled: boolean; onToggle: (checked: boolean) => void }) {
  const hints = hintsOf(tool)
  // Un outil « changé » n'est **pas** libre : la case est vide, et le badge
  // dit pourquoi — le cocher, c'est accepter ce que le serveur annonce maintenant.
  const checked = tool.status === 'allowed'
  return (
    <li className="flex items-start gap-2 px-2 py-1.5" data-testid={`mcp-tool-${tool.name}`}>
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={`${tool.name} libre`}
        data-testid={`mcp-tool-check-${tool.name}`}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs">{tool.name}</span>
          {tool.status === 'changed' && (
            <Badge tone="waiting" data-testid={`mcp-tool-changed-${tool.name}`}>
              changé depuis le cochage
            </Badge>
          )}
          {hints.map((h) => (
            <span key={h} className="rounded bg-canvas px-1 text-[0.65rem] text-muted">
              {h}
            </span>
          ))}
        </div>
        <p className="line-clamp-2 text-xs text-muted" title={tool.description}>
          {tool.description || '(sans description)'}
        </p>
      </div>
    </li>
  )
}
