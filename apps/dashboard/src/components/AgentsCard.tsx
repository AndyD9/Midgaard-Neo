/**
 * @file Ce qui est configuré : profils d'agents et fournisseurs de modèles.
 *
 * **Pourquoi cette carte existe.** Le premier essai réel de la Slice 0 a échoué
 * parce que le harness décrivait un dashboard qui n'existait pas. La leçon vaut
 * ici : un Researcher présenté comme disponible alors qu'aucune clé n'est
 * configurée enverrait l'utilisateur déléguer une tâche qui ne peut pas
 * démarrer. Cette carte montre donc l'état réel — profil désactivé compris — et
 * donne la commande exacte pour y remédier.
 *
 * **Les clés ne passent jamais par ici** : déposer une clé d'API passe par la
 * CLI, où elle peut être saisie sans écho et sans traverser un navigateur.
 *
 * **Ce qui s'y règle, depuis la Slice 5** (`editable`, vue « Profils ») : le
 * fournisseur et le modèle de chaque profil, par `PATCH /api/agents/:id`.
 * **Depuis la Slice 8**, aussi ses limites (`PUT /api/agents/:id/limits`),
 * décision de l'auteur qui revient sur la Slice 5 : un relèvement demande
 * confirmation, le daemon borne chaque valeur et journalise le changement.
 *
 * **Depuis la Slice 7**, aussi la déclaration « ce modèle lit les images », pour
 * un profil qui a des outils d'image, quand le fournisseur ne publie pas la
 * capacité. Le catalogue du fournisseur, quand il la publie, l'emporte : la case
 * le dit, et le motif d'un Navigator refusé vient du daemon, qui l'a constaté.
 *
 * **Depuis la Slice 8**, les serveurs MCP d'un profil (`PUT /api/agents/:id/mcp`),
 * pour le Researcher, le Developer et le Navigator — jamais l'orchestrateur, qui
 * délègue à un profil qui en a.
 */
import { useCallback, useEffect, useState } from 'react'
import { Bot, Save } from 'lucide-react'
import type { Agent, AgentLimits, McpServerView, ProviderConfig } from '@midgaard/contracts'
import { ApiError, fetchAgents, fetchMcpServers, fetchProviders, setAgentLimits, setAgentMcp, updateAgent } from '@/lib/api'
import { useHarnessCommand } from '@/lib/advice'
import { disabledReason } from '@/lib/agents'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

/** Types de profils qui reçoivent des outils MCP, comme `MCP_CAPABLE_KINDS` du daemon. */
const MCP_KINDS = new Set(['researcher', 'developer', 'navigator'])

interface Loaded {
  agents: Agent[]
  providers: ProviderConfig[]
  /** Serveurs MCP déclarés ; vide si la liste n'a pas pu être lue. */
  mcp: McpServerView[]
  pricing: { updated_at: string; models: number }
}

/**
 * La carte des exécutants.
 * @param editable vrai dans la vue « Profils » : fournisseur et modèle se règlent
 */
export function AgentsCard({ editable = false }: { editable?: boolean }) {
  const [data, setData] = useState<Loaded | null>(null)
  const harness = useHarnessCommand()

  const load = useCallback(() => {
    let abandoned = false
    // La liste MCP manquante ne doit pas faire disparaître la carte : c'est celle qui dit à un nouveau venu qu'aucun fournisseur n'est
    // configuré.
    Promise.all([
      fetchAgents(),
      fetchProviders(),
      fetchMcpServers().catch(() => ({ servers: [] })),
    ])
      .then(([a, p, m]) => {
        if (!abandoned) {
          setData({
            agents: a.agents,
            providers: p.providers,
            pricing: p.pricing,
            mcp: m.servers,
          })
        }
      })
      .catch(() => {})
    return () => {
      abandoned = true
    }
  }, [])

  useEffect(load, [load])

  if (!data) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4 text-muted" /> Exécutants
        </CardTitle>
        <span className="text-xs text-muted">
          {data.providers.length} fournisseur(s) · {data.pricing.models} tarif(s)
        </span>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <ul className="space-y-2">
          {data.agents.map((agent) => (
            <li key={agent.id} className="space-y-1" data-testid={`agent-${agent.id}`}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{agent.id}</span>
                <Badge tone={agent.enabled ? 'done' : 'neutral'}>
                  {agent.enabled ? 'disponible' : 'désactivé'}
                </Badge>
                {agent.provider_id && (
                  <span className="text-xs text-muted">
                    via {agent.provider_id}
                    {agent.model ? ` · ${agent.model}` : ''}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted">{agent.description}</p>
              {!agent.enabled && (
                <p className="text-xs text-waiting" data-testid={`agent-${agent.id}-reason`}>
                  {disabledReason(agent, data.providers)}
                  {/* La commande ne vaut que pour un fournisseur absent : un
                      Navigator aveugle a un fournisseur, il lui faut un modèle. */}
                  {(agent.provider_id === null || !data.providers.some((p) => p.id === agent.provider_id)) && (
                    <>
                      . Ajoute une clé dans{' '}
                      <a className="underline" href="#/agents" data-testid={`agent-${agent.id}-add-provider`}>
                        Profils → Fournisseurs
                      </a>
                      , ou {harness.where} :{' '}
                      <code className="rounded bg-canvas px-1 font-mono">
                        {harness.prefix} providers add venice --model deepseek-v4-flash-0731
                      </code>
                    </>
                  )}
                </p>
              )}
              {editable && agent.kind !== 'simulated' && data.providers.length > 0 && (
                <ModelEditor agent={agent} providers={data.providers} onSaved={load} />
              )}
              {editable && agent.provider_id !== null && agent.tools.some((t) => t === 'read_image' || t.startsWith('browser_')) && (
                <VisionEditor agent={agent} onSaved={load} />
              )}
              {editable && agent.kind !== 'simulated' && <LimitsEditor agent={agent} onSaved={load} />}
              {editable && MCP_KINDS.has(agent.kind) && data.mcp.length > 0 ? (
                <McpEditor agent={agent} servers={data.mcp} onSaved={load} />
              ) : (
                agent.mcp_servers.length > 0 && (
                  <p className="text-xs text-muted">Serveurs MCP : {agent.mcp_servers.join(', ')}</p>
                )
              )}
            </li>
          ))}
        </ul>

        {data.providers.length > 0 && (
          <ul className="space-y-1 border-t border-border pt-3">
            {data.providers.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-xs">
                <span className="font-mono">{p.id}</span>
                <span className="text-muted">{p.default_model}</span>
                <Badge tone={p.last_test?.ok ? 'done' : p.last_test ? 'danger' : 'neutral'}>
                  {p.last_test ? (p.last_test.ok ? 'joignable' : 'injoignable') : 'jamais testé'}
                </Badge>
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-border pt-3 text-xs text-muted">
          Tarifs relevés le {data.pricing.updated_at.slice(0, 10)}. Un coût affiché « estimé » vient de cette
          table ; un coût « facturé » vient du fournisseur lui-même.
        </p>
      </CardBody>
    </Card>
  )
}

/**
 * Fournisseur et modèle d'un profil, réglés par `PATCH /api/agents/:id`.
 *
 * Le modèle est un champ libre, aidé des modèles que le dernier « Test
 * connection » du fournisseur a listés : le harness ne connaît pas le catalogue
 * de chaque fournisseur, et un champ fermé interdirait un modèle sorti hier.
 * Vide, il revient au modèle par défaut du fournisseur. Changer de fournisseur
 * sans modèle fait de même côté daemon : un nom de modèle n'a de sens que chez
 * son fournisseur.
 */
function ModelEditor({
  agent,
  providers,
  onSaved,
}: {
  agent: Agent
  providers: ProviderConfig[]
  onSaved: () => void
}) {
  const [providerId, setProviderId] = useState(agent.provider_id ?? providers[0]!.id)
  const [model, setModel] = useState(agent.model ?? '')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const provider = providers.find((p) => p.id === providerId)
  const changed = providerId !== agent.provider_id || (model.trim() || null) !== agent.model
  const listId = `models-${agent.id}`

  async function save(): Promise<void> {
    setSaving(true)
    setMessage(null)
    try {
      const { agent: saved } = await updateAgent(agent.id, { provider_id: providerId, model: model.trim() || null })
      setMessage({ ok: true, text: `enregistré : ${saved.provider_id} · ${saved.model ?? 'modèle par défaut'}` })
      onSaved()
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError && e.reason ? e.reason : (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <select
        className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
        value={providerId}
        onChange={(e) => setProviderId(e.target.value)}
        aria-label={`Fournisseur de ${agent.id}`}
        data-testid={`agent-provider-${agent.id}`}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id}
          </option>
        ))}
      </select>
      <input
        className="min-w-48 flex-1 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        placeholder={provider ? `par défaut : ${provider.default_model}` : 'modèle'}
        list={listId}
        spellCheck={false}
        aria-label={`Modèle de ${agent.id}`}
        data-testid={`agent-model-${agent.id}`}
      />
      <datalist id={listId}>
        {(provider?.last_test?.models ?? []).map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <Button
        size="sm"
        variant="outline"
        onClick={save}
        disabled={!changed || saving}
        data-testid={`agent-save-${agent.id}`}
      >
        <Save /> Enregistrer
      </Button>
      {message && (
        <span className={message.ok ? 'text-xs text-done' : 'text-xs text-danger'} role="status">
          {message.text}
        </span>
      )}
    </div>
  )
}

/**
 * La déclaration « ce modèle lit les images » d'un profil (Slice 7), réglée par
 * `PATCH /api/agents/:id` avec `vision`. Elle porte sur le modèle du profil, et
 * le daemon l'efface quand il change.
 */
function VisionEditor({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const value = agent.vision === null ? 'unset' : agent.vision ? 'yes' : 'no'

  async function save(next: string): Promise<void> {
    setSaving(true)
    setMessage(null)
    try {
      await updateAgent(agent.id, { vision: next === 'unset' ? null : next === 'yes' })
      setMessage({ ok: true, text: 'déclaration enregistrée' })
      onSaved()
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError && e.reason ? e.reason : (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor={`vision-${agent.id}`} className="text-muted">
        Le modèle lit les images :
      </label>
      <select
        id={`vision-${agent.id}`}
        className="rounded border border-border bg-surface px-1.5 py-1"
        value={value}
        disabled={saving}
        onChange={(e) => void save(e.target.value)}
        data-testid={`vision-${agent.id}`}
      >
        <option value="unset">non déclaré</option>
        <option value="yes">oui, je le déclare</option>
        <option value="no">non, je le déclare</option>
      </select>
      <span className="text-muted">— le catalogue du fournisseur l'emporte quand il le publie</span>
      {message && <span className={message.ok ? 'text-done' : 'text-danger'}>{message.text}</span>}
    </div>
  )
}

/**
 * Les serveurs MCP d'un profil (Slice 8) : une case par serveur déclaré. Les
 * agents du profil en reçoivent les outils à partir de la tâche suivante —
 * libres s'ils sont cochés au serveur, approuvés à chaque appel sinon.
 */
function McpEditor({ agent, servers, onSaved }: { agent: Agent; servers: McpServerView[]; onSaved: () => void }) {
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  async function toggle(id: string, on: boolean): Promise<void> {
    setSaving(true)
    setMessage(null)
    const next = on ? [...agent.mcp_servers, id] : agent.mcp_servers.filter((s) => s !== id)
    try {
      await setAgentMcp(agent.id, next)
      setMessage({ ok: true, text: 'enregistré — vaut pour les tâches à venir' })
      onSaved()
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError && e.reason ? e.reason : (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs" data-testid={`agent-mcp-${agent.id}`}>
      <span className="text-muted">Serveurs MCP :</span>
      {servers.map((s) => (
        <label key={s.id} className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={agent.mcp_servers.includes(s.id)}
            disabled={saving}
            onChange={(e) => void toggle(s.id, e.target.checked)}
            data-testid={`agent-mcp-${agent.id}-${s.id}`}
          />
          <span className="font-mono">{s.id}</span>
        </label>
      ))}
      {message && <span className={message.ok ? 'text-done' : 'text-danger'}>{message.text}</span>}
    </div>
  )
}

/** Les limites réglables, leur libellé, et leur pas de saisie. */
const LIMIT_FIELDS: { key: keyof AgentLimits; label: string; step: number }[] = [
  { key: 'max_steps', label: 'étapes', step: 1 },
  { key: 'max_cost_usd', label: '$', step: 0.01 },
  { key: 'timeout_s', label: 's', step: 1 },
  { key: 'max_output_tokens', label: 'jetons de sortie', step: 1 },
  { key: 'max_tool_calls_per_step', label: 'appels par étape', step: 1 },
]

/**
 * Les limites d'un profil (Slice 8), réglées par `PUT /api/agents/:id/limits`.
 *
 * Un **relèvement** passe par une confirmation qui dit ce qui monte : le budget
 * est la protection contre une dépense qui s'emballe, et le relever doit être
 * un geste. Le daemon borne chaque valeur ; son refus s'affiche tel quel.
 */
function LimitsEditor({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, String(agent.limits[f.key])])),
  )
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const asked: Partial<AgentLimits> = {}
  for (const f of LIMIT_FIELDS) {
    const value = Number(draft[f.key])
    if (draft[f.key]?.trim() && Number.isFinite(value) && value !== agent.limits[f.key]) asked[f.key] = value
  }
  const keys = Object.keys(asked) as (keyof AgentLimits)[]

  async function save(): Promise<void> {
    const raised = keys.filter((k) => asked[k]! > agent.limits[k])
    if (raised.length) {
      const lines = raised.map((k) => `${k} : ${agent.limits[k]} → ${asked[k]}`).join('\n')
      const tree = agent.kind === 'orchestrator' && raised.includes('max_cost_usd')
        ? '\n\nLe budget de l’orchestrateur couvre tout son arbre : ses sous-tâches dépenseront jusque-là.'
        : ''
      if (!window.confirm(`Tu relèves des limites de ${agent.id} :\n\n${lines}${tree}\n\nCela vaut pour les tâches à venir.`)) return
    }
    setSaving(true)
    setMessage(null)
    try {
      await setAgentLimits(agent.id, asked)
      setMessage({ ok: true, text: 'limites enregistrées — pour les tâches à venir' })
      onSaved()
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError && e.reason ? e.reason : (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid={`agent-limits-${agent.id}`}>
      <span className="text-muted">Limites :</span>
      {LIMIT_FIELDS.map((f) => (
        <label key={f.key} className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            step={f.step}
            className="w-20 rounded border border-border bg-surface px-1.5 py-0.5 font-mono"
            value={draft[f.key]}
            onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
            aria-label={`${f.key} de ${agent.id}`}
            data-testid={`agent-limit-${agent.id}-${f.key}`}
          />
          <span className="text-muted">{f.label}</span>
        </label>
      ))}
      <Button size="sm" variant="outline" disabled={keys.length === 0 || saving} onClick={() => void save()} data-testid={`agent-limits-save-${agent.id}`}>
        <Save /> Enregistrer
      </Button>
      {message && <span className={message.ok ? 'text-done' : 'text-danger'}>{message.text}</span>}
    </div>
  )
}

