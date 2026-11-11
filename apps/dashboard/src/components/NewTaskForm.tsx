/**
 * @file Formulaire « Nouvelle tâche » (Slice 5) : lancer une tâche sans Claude
 * Code, depuis le dashboard — en particulier un orchestrateur, qui ne se lance
 * que d'ici.
 *
 * Trois règles, chacune tirée d'une leçon déjà payée :
 *
 *  - **ne proposer que des profils actifs, et dire pourquoi les autres ne le
 *    sont pas** : un profil sans fournisseur présenté comme utilisable enverrait
 *    créer une tâche qui échoue (Slice 0, « ne rien décrire qui n'existe pas ») ;
 *  - **le dossier de projet est vérifié par le daemon**, pas ici : il existe,
 *    c'est un dossier, et ce n'est ni `/` ni le dossier personnel. Le formulaire
 *    affiche le motif du refus tel que le daemon l'écrit ;
 *  - **les limites sont celles du profil**, affichées sans manette pour les
 *    relever ici : une tâche ne relève pas son budget. Elles se règlent aux
 *    Profils, pour les tâches à venir, avec confirmation (Slice 8).
 *
 * Le dernier dossier saisi est retenu dans le navigateur (`localStorage`),
 * commodité de ce seul poste : rien de ce qui doit durer n'y est rangé, et la
 * page fonctionne sans lui.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Play } from 'lucide-react'
import type { Agent, ProviderConfig } from '@midgaard/contracts'
import { ApiError, createTask, fetchAgents, fetchProviders } from '@/lib/api'
import { disabledReason } from '@/lib/agents'
import { subtaskCeiling } from '@/lib/tree'
import { formatCost } from '@/lib/utils'
import { Button } from './ui/button'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

/** Clé du dernier dossier de projet saisi, dans le navigateur de ce poste. */
const LAST_DIR_KEY = 'midgaard.lastProjectDir'

/** Lit le dernier dossier saisi ; vide si le navigateur refuse le stockage. */
function lastDir(): string {
  try {
    return localStorage.getItem(LAST_DIR_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Retient le dossier saisi, sans rien exiger : la page vit sans stockage. */
function rememberDir(dir: string): void {
  try {
    localStorage.setItem(LAST_DIR_KEY, dir)
  } catch {
    // Navigation privée, stockage bloqué : la commodité se perd, rien d'autre.
  }
}

/** Classes communes aux champs de saisie. */
const FIELD =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50'

export function NewTaskForm({ onCreated }: { onCreated: (taskId: string) => void }) {
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [agentId, setAgentId] = useState('')
  const [objective, setObjective] = useState('')
  const [projectDir, setProjectDir] = useState(lastDir)
  const [context, setContext] = useState('')
  // Cochée par défaut : un orchestrateur lancé d'ici a un humain en face, et la
  // conversation est ce que l'atelier montre (Slice 6).
  const [conversation, setConversation] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let abandoned = false
    Promise.all([fetchAgents(), fetchProviders()])
      .then(([a, p]) => {
        if (abandoned) return
        setAgents(a.agents)
        setProviders(p.providers)
        // L'orchestrateur d'abord, s'il est actif : c'est le profil qui ne se
        // lance que d'ici. Sinon le premier profil actif.
        const active = a.agents.filter((x) => x.enabled)
        setAgentId((current) => current || (active.find((x) => x.kind === 'orchestrator') ?? active[0])?.id || '')
      })
      .catch((e: unknown) => {
        if (!abandoned) setLoadError(`profils illisibles : ${(e as Error).message}`)
      })
    return () => {
      abandoned = true
    }
  }, [])

  const active = useMemo(() => agents?.filter((a) => a.enabled) ?? [], [agents])
  const inactive = useMemo(() => agents?.filter((a) => !a.enabled) ?? [], [agents])
  const selected = active.find((a) => a.id === agentId) ?? null
  // Le profil simulé ne lit aucun dossier : le lui demander serait une fausse exigence.
  const needsDir = selected !== null && selected.kind !== 'simulated'
  const ready = selected !== null && objective.trim() !== '' && (!needsDir || projectDir.trim() !== '')
  // Seul un orchestrateur converse : le daemon refuse la demande pour un autre profil.
  const converses = selected?.kind === 'orchestrator' && conversation

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!ready || !selected) return
    setSubmitting(true)
    setError(null)
    try {
      const view = await createTask({
        objective: objective.trim(),
        agent_id: selected.id,
        ...(context.trim() ? { context: context.trim() } : {}),
        ...(needsDir ? { project_dir: projectDir.trim() } : {}),
        ...(converses ? { conversation: true } : {}),
      })
      if (needsDir) rememberDir(projectDir.trim())
      onCreated(view.task.id)
    } catch (err) {
      setError(err instanceof ApiError && err.reason ? err.reason : `création refusée : ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  if (loadError) return <p className="text-sm text-danger">{loadError}</p>
  if (!agents) return null

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle className="text-base">Nouvelle tâche</CardTitle>
      </CardHeader>
      <CardBody>
        <form className="space-y-4 text-sm" onSubmit={submit} data-testid="new-task-form">
          <label className="block space-y-1.5">
            <span className="font-medium">Profil</span>
            {active.length === 0 ? (
              <p className="text-waiting">Aucun profil actif : configure un fournisseur de modèle d'abord.</p>
            ) : (
              <select
                className={FIELD}
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                data-testid="new-task-agent"
              >
                {active.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.id})
                  </option>
                ))}
              </select>
            )}
          </label>

          {selected && (
            <div className="space-y-1 rounded-md border border-border bg-canvas px-3 py-2 text-xs text-muted">
              <p>{selected.description}</p>
              <p className="font-mono">
                {selected.limits.max_steps} étapes · {formatCost(selected.limits.max_cost_usd)} ·{' '}
                {selected.limits.timeout_s} s — limites du profil
              </p>
              {selected.kind === 'orchestrator' && (
                // Depuis la Slice 8, le budget de l'orchestrateur couvre tout
                // son arbre : on le dit avant le lancement, avec le plafond en
                // nombre, qui reste.
                <p data-testid="new-task-ceiling">
                  Ce budget couvre tout l'arbre : l'orchestrateur et chacune de ses sous-tâches. Il peut lancer
                  jusqu'à {subtaskCeiling(selected)} sous-tâches, et créer ses propres exécutants à partir des
                  profils, sans jamais dépasser leurs limites.
                </p>
              )}
            </div>
          )}

          {inactive.length > 0 && (
            <ul className="space-y-0.5 text-xs text-muted" data-testid="new-task-inactive">
              {inactive.map((a) => (
                <li key={a.id}>
                  <span className="font-mono">{a.id}</span> indisponible — {disabledReason(a, providers)}
                </li>
              ))}
            </ul>
          )}

          {selected?.kind === 'orchestrator' && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={conversation}
                onChange={(e) => setConversation(e.target.checked)}
                data-testid="new-task-conversation"
              />
              <span>
                <span className="font-medium">Conversation</span>
                <span className="block text-xs text-muted">
                  L'orchestrateur vous répond et attend votre message, jusqu'à ce que vous lui demandiez de
                  conclure. Décochée, il travaille d'un trait et rend son résultat.
                </span>
              </span>
            </label>
          )}

          <label className="block space-y-1.5">
            <span className="font-medium">{converses ? 'Premier message' : 'Objectif'}</span>
            <textarea
              className={`${FIELD} min-h-24`}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              maxLength={4000}
              placeholder="Ce que la tâche doit accomplir, en entier : l'exécutant ne voit rien d'autre."
              data-testid="new-task-objective"
            />
          </label>

          {needsDir && (
            <label className="block space-y-1.5">
              <span className="font-medium">Dossier du projet</span>
              <input
                className={`${FIELD} font-mono`}
                value={projectDir}
                onChange={(e) => setProjectDir(e.target.value)}
                placeholder="/chemin/absolu/du/depot"
                spellCheck={false}
                data-testid="new-task-dir"
              />
              <span className="block text-xs text-muted">
                Chemin absolu. L'agent ne lira que ce dossier ; ni la racine du système ni ton dossier personnel
                ne sont acceptés.
              </span>
            </label>
          )}

          <label className="block space-y-1.5">
            <span className="font-medium">
              Contexte <span className="font-normal text-muted">(facultatif)</span>
            </span>
            <textarea
              className={`${FIELD} min-h-16`}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Ce que tu sais déjà : fichiers utiles, contraintes, pistes écartées."
              data-testid="new-task-context"
            />
          </label>

          {error && (
            <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" disabled={!ready || submitting} data-testid="new-task-submit">
            <Play /> Lancer
          </Button>
        </form>
      </CardBody>
    </Card>
  )
}
