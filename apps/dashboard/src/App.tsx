/**
 * @file Application du dashboard : une interface tout terminal.
 *
 * ```text
 *  ┌ barre d'état ──────────────────────────────────────────────────────┐
 *  │ tâches            │ [flux] [détails] [navigateur]                  │
 *  │ (l'arbre, en      │ ───────────────────────────────────────────────│
 *  │  lignes)          │ le flux de l'arbre, en lignes                  │
 *  │                   │ approbations en attente                        │
 *  │ [+ nouvelle]      │ › invite vers l'orchestrateur                  │
 *  └───────────────────┴────────────────────────────────────────────────┘
 * ```
 *
 * Une seule colonne de travail. Par défaut elle montre **le flux** de la tâche
 * sélectionnée et de son arbre (`TerminalView`) : c'est là qu'on lit, qu'on
 * converse et qu'on approuve. Deux autres lectures de la même tâche s'y
 * substituent, à la demande :
 *  - **détails** : ce qui ne tient pas en lignes — consommation, limites,
 *    sous-tâches et budget de l'arbre, diff d'un Developer, appels d'outils ;
 *  - **navigateur** : la capture de ce que voit un agent. Elle apparaît dès
 *    qu'un agent de l'arbre a ouvert un navigateur, et s'ouvre seule à chaque
 *    nouvelle session si l'on regardait le flux : l'humain doit voir ce que
 *    voit l'agent avant d'approuver une saisie.
 *
 * L'atelier d'origine (barre d'activité, panneau de conversation, terminal
 * xterm, séparateurs) a été retiré : le flux porte la conversation et la
 * sortie des commandes.
 *
 * Le routage se fait par le fragment d'URL, sans bibliothèque : `#/tasks/<id>`
 * (et son alias `#/terminal/<id>`, qui ouvre toujours le flux), `#/new` (lancer
 * une tâche) et `#/agents` (profils, fournisseurs, serveurs MCP). Le daemon
 * sert `index.html` pour toute route inconnue, donc un rechargement fonctionne
 * aussi. Rien ici n'écrit un fichier : le daemon n'en a pas les routes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Task } from '@midgaard/contracts'
import { useHarness } from '@/lib/useHarness'
import { DEFAULT_HARNESS_COMMAND, HarnessCommandContext } from '@/lib/advice'
import { cn } from '@/lib/utils'
import { McpServersCard } from './components/McpServersCard'
import { ProvidersCard } from './components/ProvidersCard'
import { AgentsCard } from './components/AgentsCard'
import { BrowserPanel, browserSources } from './components/BrowserPanel'
import { NewTaskForm } from './components/NewTaskForm'
import { StatusBar } from './components/StatusBar'
import { TaskInspector } from './components/TaskInspector'
import { TerminalView } from './components/TerminalView'
import { TaskList } from './components/TaskList'

/** Ce que montre la colonne de travail, lu dans le fragment d'URL. */
type View =
  | { kind: 'task'; id: string; flux: boolean }
  | { kind: 'new' }
  | { kind: 'agents' }
  | { kind: 'none' }

/** Lecture d'une tâche dans la colonne de travail. */
type Mode = 'flux' | 'details' | 'browser'

/** Vue désignée par le fragment courant. */
function viewFromHash(): View {
  if (location.hash === '#/new') return { kind: 'new' }
  if (location.hash === '#/agents') return { kind: 'agents' }
  const match = /^#\/(tasks|terminal)\/([0-9a-f-]{36})$/i.exec(location.hash)
  return match ? { kind: 'task', id: match[2]!, flux: match[1]!.toLowerCase() === 'terminal' } : { kind: 'none' }
}

export function App() {
  const { state, loadEvents, reportError } = useHarness()
  const [view, setView] = useState<View>(viewFromHash)
  /** Compte les changements de fournisseurs, pour relire la carte des exécutants. */
  const [providersRev, setProvidersRev] = useState(0)
  const [mode, setMode] = useState<Mode>('flux')
  const selectedId = view.kind === 'task' ? view.id : null

  // Le fragment est la source de vérité de la vue : les boutons Précédent et
  // Suivant du navigateur fonctionnent, et un lien partagé ouvre la bonne tâche.
  useEffect(() => {
    const onHashChange = () => {
      const next = viewFromHash()
      setView(next)
      // `#/terminal/<id>` désigne le flux, quelle que soit la lecture en cours.
      if (next.kind === 'task' && next.flux) setMode('flux')
    }
    addEventListener('hashchange', onHashChange)
    return () => removeEventListener('hashchange', onHashChange)
  }, [])

  // La lecture en cours (flux, détails) est gardée d'une tâche à l'autre du
  // même arbre : qui compare les diffs de deux sous-tâches ne veut pas rouvrir
  // « détails » à chaque clic.
  const select = useCallback((id: string) => {
    location.hash = `#/tasks/${id}`
  }, [])

  // À défaut de sélection, on ouvre ce qui attend une décision, sinon la tâche
  // la plus récente : ouvrir le dashboard doit montrer quelque chose d'utile.
  const effectiveId = useMemo(() => {
    if (view.kind === 'new' || view.kind === 'agents') return null
    if (selectedId && state.tasks.some((t) => t.id === selectedId)) return selectedId
    return state.approvals[0]?.task_id ?? state.tasks[0]?.id ?? null
  }, [view.kind, selectedId, state.tasks, state.approvals])

  // Ce choix par défaut devient aussitôt une sélection explicite, inscrite dans
  // le fragment. Sans cela, il serait recalculé à chaque changement d'état : la
  // tâche qu'on regarde s'échapperait au moment même où on l'approuve.
  useEffect(() => {
    if (view.kind === 'none' && effectiveId) location.hash = `#/tasks/${effectiveId}`
  }, [view.kind, effectiveId])

  const task = state.tasks.find((t) => t.id === effectiveId) ?? null
  const approval = state.approvals.find((a) => a.task_id === effectiveId) ?? null

  // L'arbre de la tâche sélectionnée : sa racine et les sous-tâches de celle-ci.
  const root: Task | null = task ? (state.tasks.find((t) => t.id === task.parent_task_id) ?? task) : null
  const children = useMemo(
    () => (root ? state.tasks.filter((t) => t.parent_task_id === root.id).sort((a, b) => a.created_at.localeCompare(b.created_at)) : []),
    [root, state.tasks],
  )

  // Changer d'arbre ramène au flux : c'est par lui qu'on aborde une tâche, et
  // un lien vers une autre tâche ne doit pas s'ouvrir sur les détails qu'on
  // lisait ailleurs. Dans un même arbre, la lecture en cours est gardée.
  const rootId = root?.id ?? null
  const lastRoot = useRef<string | null>(null)
  useEffect(() => {
    if (rootId && lastRoot.current && rootId !== lastRoot.current) setMode('flux')
    if (rootId) lastRoot.current = rootId
  }, [rootId])

  // Les timelines dont le flux a besoin, chargées une fois : ensuite, la
  // WebSocket les tient à jour.
  const requested = useRef(new Set<string>())
  useEffect(() => {
    const needed = [task?.id, root?.id, ...children.map((c) => c.id)]
    for (const id of needed) {
      if (!id || state.events[id] !== undefined || requested.current.has(id)) continue
      requested.current.add(id)
      void loadEvents(id)
    }
  }, [task?.id, root?.id, children, state.events, loadEvents])

  // Les sessions de navigateur de l'arbre. Une nouvelle ouverture amène la
  // capture au premier plan.
  const tree = useMemo(() => (root ? [root, ...children] : []), [root, children])
  const browsers = useMemo(() => browserSources(tree, state.events), [tree, state.events])
  // Comparé à la séquence d'**ouverture**, pas à celle de la dernière action :
  // la capture ne reprend pas le premier plan à chaque clic de l'agent. La
  // première valeur vue est retenue sans basculer — une session déjà ouverte
  // au chargement de la page n'est pas une nouvelle session.
  const lastOpened = useRef<number | null>(null)
  const newestOpen = browsers.filter((b) => b.open).reduce((max, b) => Math.max(max, b.openedSeq), 0)
  useEffect(() => {
    if (lastOpened.current !== null && newestOpen > lastOpened.current) setMode('browser')
    if (newestOpen > 0) lastOpened.current = Math.max(lastOpened.current ?? 0, newestOpen)
    else lastOpened.current ??= 0
  }, [newestOpen])

  // Un arbre sans navigateur n'a pas de capture : on retombe sur le flux,
  // sans toucher à la lecture choisie.
  const shown: Mode = mode === 'browser' && browsers.length === 0 ? 'flux' : mode

  return (
    <HarnessCommandContext.Provider value={state.health?.harness_command ?? DEFAULT_HARNESS_COMMAND}>
    <div className="flex h-full flex-col">
      <StatusBar status={state.status} health={state.health} error={state.error} gap={state.gap} />

      <div className="flex min-h-0 flex-1">
        <aside className="flex min-h-0 w-[min(20rem,30vw)] shrink-0 flex-col border-r border-border">
          <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1 text-xs">
            <h1 className="mr-auto text-muted">tâches ({state.tasks.length})</h1>
            <Command active={view.kind === 'agents'} onClick={() => (location.hash = '#/agents')} testId="nav-agents">
              profils
            </Command>
            <Command active={view.kind === 'new'} onClick={() => (location.hash = '#/new')} testId="nav-new">
              + nouvelle
            </Command>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TaskList tasks={state.tasks} approvals={state.approvals} selectedId={effectiveId} onSelect={select} />
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {view.kind === 'new' ? (
            <Page title="nouvelle tâche">
              <NewTaskForm onCreated={select} />
            </Page>
          ) : view.kind === 'agents' ? (
            <Page title="profils">
              <div className="mx-auto max-w-2xl space-y-4">
                {/* Un fournisseur ajouté ou retiré active ou désactive des
                    profils : la carte des exécutants se remonte pour les relire. */}
                <ProvidersCard onChanged={() => setProvidersRev((n) => n + 1)} />
                <AgentsCard key={providersRev} editable />
                <McpServersCard />
              </div>
            </Page>
          ) : task && root ? (
            <>
              <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1 text-xs" role="tablist">
                <Command active={shown === 'flux'} onClick={() => setMode('flux')} testId="tab-flux" tab>
                  flux
                </Command>
                <Command active={shown === 'details'} onClick={() => setMode('details')} testId="tab-details" tab>
                  détails
                </Command>
                {browsers.length > 0 && (
                  <Command active={shown === 'browser'} onClick={() => setMode('browser')} testId="tab-browser" tab>
                    navigateur{browsers.some((b) => b.open) && <span className="text-running" aria-label="session ouverte"> ●</span>}
                  </Command>
                )}
                <span className="ml-auto truncate text-muted" title={task.objective}>
                  {task.objective}
                </span>
              </div>
              <section className="min-h-0 flex-1 overflow-hidden">
                {shown === 'browser' ? (
                  <BrowserPanel tasks={tree} events={state.events} approvals={state.approvals} root={root} onError={reportError} />
                ) : shown === 'details' ? (
                  <div className="h-full overflow-y-auto p-4">
                    <TaskInspector
                      task={task}
                      tasks={state.tasks}
                      approval={approval}
                      events={state.events[task.id]}
                      onLoadEvents={loadEvents}
                      onError={reportError}
                      onSelect={select}
                    />
                  </div>
                ) : (
                  <TerminalView root={root} tasks={state.tasks} events={state.events} approvals={state.approvals} onError={reportError} />
                )}
              </section>
            </>
          ) : (
            <Page title="midgaard">
              <Empty />
            </Page>
          )}
        </main>
      </div>
    </div>
    </HarnessCommandContext.Provider>
  )
}

/**
 * Une commande de l'interface, écrite entre crochets comme dans un terminal.
 * `tab` en fait un onglet pour les lecteurs d'écran : flux, détails et
 * navigateur sont trois lectures de la même tâche.
 */
function Command(props: { active: boolean; onClick: () => void; testId: string; tab?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      {...(props.tab ? { role: 'tab', 'aria-selected': props.active } : { 'aria-current': props.active })}
      onClick={props.onClick}
      data-testid={props.testId}
      className={cn('shrink-0 whitespace-nowrap hover:text-ink', props.active ? 'text-accent' : 'text-muted')}
    >
      [{props.children}]
    </button>
  )
}

/** Une page de formulaires dans la colonne de travail : un titre en ligne, puis le contenu qui défile. */
function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="shrink-0 border-b border-border px-3 py-1 text-xs text-muted">
        <span className="text-accent">›</span> {title}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </>
  )
}

/**
 * Écran vide : il explique quoi faire, plutôt que de rester muet.
 *
 * Il montre aussi l'état réel des exécutants. Quelqu'un qui ouvre le dashboard
 * sans avoir configuré de clé doit l'apprendre **ici**, et non en voyant sa
 * première délégation refusée.
 */
function Empty() {
  return (
    <div className="mx-auto max-w-xl space-y-5 pt-6">
      <div className="space-y-2 text-sm">
        <p>Rien à observer pour l'instant.</p>
        <p className="text-muted">
          Lance une conversation avec « + nouvelle ». Elle apparaîtra ici en direct.
        </p>
      </div>
      <AgentsCard />
    </div>
  )
}
