/**
 * @file Application du dashboard : un atelier façon VS Code (Slice 6).
 *
 * ```text
 *  ┌ barre d'état ───────────────────────────────────────────────────────┐
 *  │act.│ panneau latéral │ onglets : Détails │ Navigateur    │ conver- │
 *  │    │ tâches          │ ──────────────────────────────────│ sation  │
 *  │    │                 │ détails de la tâche, ou navigateur│         │
 *  │    │                 │ ──────────────────────────────────│         │
 *  │    │                 │ terminal (sortie des commandes)   │         │
 *  └────┴─────────────────┴───────────────────────────────────┴─────────┘
 * ```
 *
 * Ce qui est affiché suit **la tâche sélectionnée**, et son arbre : la
 * conversation et le terminal sont ceux de sa racine (l'orchestrateur) et de
 * ses sous-tâches.
 *
 * L'onglet « Navigateur » (Slice 7) apparaît dès qu'un agent de l'arbre a
 * ouvert un navigateur, et s'ouvre seul à chaque nouvelle session si l'on
 * regardait les détails : l'humain doit voir ce que voit l'agent.
 *
 * Le routage se fait par le fragment d'URL, sans bibliothèque : `#/tasks/<id>`,
 * `#/new` (le formulaire « Nouvelle tâche ») et `#/agents` (les profils). Le
 * daemon sert `index.html` pour toute route inconnue, donc un rechargement
 * fonctionne aussi. Rien ici n'écrit un fichier : le daemon n'en a pas les routes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Globe, ListTree, MessagesSquare, Plus, SlidersHorizontal, SquareTerminal, X } from 'lucide-react'
import type { Task } from '@midgaard/contracts'
import { useHarness } from '@/lib/useHarness'
import { speaker } from '@/lib/thread'
import { cn } from '@/lib/utils'
import { McpServersCard } from './components/McpServersCard'
import { ProvidersCard } from './components/ProvidersCard'
import { AgentsCard } from './components/AgentsCard'
import { BrowserPanel, browserSources } from './components/BrowserPanel'
import { ChatPanel } from './components/ChatPanel'
import { NewTaskForm } from './components/NewTaskForm'
import { Resizer } from './components/Resizer'
import { StatusBar } from './components/StatusBar'
import { TaskInspector } from './components/TaskInspector'
import { TerminalView } from './components/TerminalView'
import { TaskList } from './components/TaskList'
import { TerminalPanel } from './components/TerminalPanel'
import { Button } from './components/ui/button'

/** Ce que montre l'onglet « Détails », lu dans le fragment d'URL. */
type View =
  | { kind: 'task'; id: string }
  | { kind: 'terminal'; id: string }
  | { kind: 'new' }
  | { kind: 'agents' }
  | { kind: 'none' }

/** Tailles des panneaux, en pixels, retenues d'une visite à l'autre. */
interface Layout {
  side: number
  chat: number
  bottom: number
}

const LAYOUT_KEY = 'midgaard.layout'
const DEFAULT_LAYOUT: Layout = { side: 320, chat: 380, bottom: 220 }

/** Vue désignée par le fragment courant. */
function viewFromHash(): View {
  if (location.hash === '#/new') return { kind: 'new' }
  if (location.hash === '#/agents') return { kind: 'agents' }
  const term = /^#\/terminal\/([0-9a-f-]{36})$/i.exec(location.hash)
  if (term) return { kind: 'terminal', id: term[1]! }
  const match = /^#\/tasks\/([0-9a-f-]{36})$/i.exec(location.hash)
  return match ? { kind: 'task', id: match[1]! } : { kind: 'none' }
}

/** Disposition retenue ; celle par défaut si le navigateur refuse le stockage. */
function savedLayout(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<Layout> | null
    return { ...DEFAULT_LAYOUT, ...(raw ?? {}) }
  } catch {
    return DEFAULT_LAYOUT
  }
}

/** Borne une taille de panneau. */
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export function App() {
  const { state, loadEvents, reportError } = useHarness()
  const [view, setView] = useState<View>(viewFromHash)
  /** Compte les changements de fournisseurs, pour relire la carte des exécutants. */
  const [providersRev, setProvidersRev] = useState(0)
  const [activeTab, setActiveTab] = useState<'details' | 'browser'>('details')
  const [layout, setLayout] = useState<Layout>(savedLayout)
  const [showTerminal, setShowTerminal] = useState(true)
  const [showChat, setShowChat] = useState(true)
  const [width, setWidth] = useState(() => innerWidth)
  const selectedId = view.kind === 'task' || view.kind === 'terminal' ? view.id : null

  // Le fragment est la source de vérité de la vue : les boutons Précédent et
  // Suivant du navigateur fonctionnent, et un lien partagé ouvre la bonne tâche.
  useEffect(() => {
    const onHashChange = () => {
      const next = viewFromHash()
      setView(next)
      // Le formulaire et les profils s'ouvrent dans l'onglet « Détails ».
      if (next.kind === 'new' || next.kind === 'agents') setActiveTab('details')
    }
    addEventListener('hashchange', onHashChange)
    return () => removeEventListener('hashchange', onHashChange)
  }, [])

  // La fenêtre peut rétrécir (app desktop, écran partagé) : les panneaux se
  // bornent à sa largeur, pour que la zone centrale garde toujours de la place.
  useEffect(() => {
    const onResize = () => setWidth(innerWidth)
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
    } catch {
      // Stockage refusé : la disposition se perd au rechargement, rien d'autre.
    }
  }, [layout])

  const select = useCallback((id: string) => {
    location.hash = `#/tasks/${id}`
    setActiveTab('details')
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

  // Les timelines dont le fil et le terminal ont besoin, chargées une fois :
  // ensuite, la WebSocket les tient à jour.
  const requested = useRef(new Set<string>())
  useEffect(() => {
    const needed = [task?.id, root?.id, ...children.map((c) => c.id)]
    for (const id of needed) {
      if (!id || state.events[id] !== undefined || requested.current.has(id)) continue
      requested.current.add(id)
      void loadEvents(id)
    }
  }, [task?.id, root?.id, children, state.events, loadEvents])

  // Les sessions de navigateur de l'arbre. Une nouvelle ouverture amène
  // l'onglet au premier plan.
  const tree = useMemo(() => (root ? [root, ...children] : []), [root, children])
  const browsers = useMemo(() => browserSources(tree, state.events), [tree, state.events])
  // Comparé à la séquence d'**ouverture**, pas à celle de la dernière action :
  // l'onglet ne reprend pas le premier plan à chaque clic de l'agent. La
  // première valeur vue est retenue sans basculer — une session déjà ouverte
  // au chargement de la page n'est pas une nouvelle session.
  const lastOpened = useRef<number | null>(null)
  const newestOpen = browsers.filter((b) => b.open).reduce((max, b) => Math.max(max, b.openedSeq), 0)
  useEffect(() => {
    if (lastOpened.current !== null && newestOpen > lastOpened.current) {
      setActiveTab('browser')
    }
    if (newestOpen > 0) lastOpened.current = Math.max(lastOpened.current ?? 0, newestOpen)
    else lastOpened.current ??= 0
  }, [newestOpen])

  const terminalSources = useMemo(
    () => (root ? [root, ...children].map((t) => ({ taskId: t.id, label: speaker(t, t.id === root.id) })) : []),
    [root, children],
  )

  const showBrowser = activeTab === 'browser' && root !== null && browsers.length > 0

  // Largeurs effectives : celles retenues, bornées pour laisser à la zone
  // centrale au moins 40 % de la fenêtre.
  const sideWidth = Math.min(layout.side, Math.round(width * 0.26))
  const chatWidth = showChat ? Math.min(layout.chat, Math.round(width * 0.3)) : 0

  // Le redimensionnement part de la taille au début du geste.
  const start = useRef(layout)
  const resize = (panel: keyof Layout, sign: 1 | -1, min: number, max: number) => (delta: number, phase: 'start' | 'move') => {
    if (phase === 'start') start.current = layout
    else setLayout((l) => ({ ...l, [panel]: clamp(start.current[panel] + sign * delta, min, max) }))
  }

  return (
    <div className="flex h-full flex-col">
      <StatusBar status={state.status} health={state.health} error={state.error} gap={state.gap} />

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-canvas py-2" aria-label="Activités">
          {/* Seule activité du panneau latéral : le bouton reste, comme repère. */}
          <ActivityButton label="Tâches" active onClick={() => {}} testId="activity-tasks">
            <ListTree />
          </ActivityButton>
          <ActivityButton label="Terminal" active={showTerminal} onClick={() => setShowTerminal((v) => !v)} testId="activity-terminal">
            <SquareTerminal />
          </ActivityButton>
          <ActivityButton label="Conversation" active={showChat} onClick={() => setShowChat((v) => !v)} testId="activity-chat">
            <MessagesSquare />
          </ActivityButton>
        </nav>

        <aside className="min-h-0 shrink-0 overflow-hidden" style={{ width: sideWidth }}>
          <div className="h-full overflow-y-auto">
            <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-surface px-3 py-1.5">
              <h1 className="mr-auto text-xs font-semibold tracking-wide text-muted uppercase">Tâches</h1>
              <Button size="sm" variant="ghost" onClick={() => (location.hash = '#/agents')} data-testid="nav-agents">
                <SlidersHorizontal /> Profils
              </Button>
              <Button size="sm" onClick={() => (location.hash = '#/new')} data-testid="nav-new">
                <Plus /> Nouvelle tâche
              </Button>
            </div>
            <TaskList tasks={state.tasks} approvals={state.approvals} selectedId={effectiveId} onSelect={select} />
          </div>
        </aside>
        <Resizer axis="x" label="Largeur du panneau latéral" onResize={resize('side', 1, 220, 640)} />

        {view.kind === 'terminal' ? (
          <div className="flex min-w-0 flex-1 flex-col" data-testid="terminal-column">
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-canvas px-3 py-1 text-xs" role="tablist">
              <SquareTerminal className="size-3.5 text-muted" />
              <span className="font-semibold tracking-wide text-muted uppercase">Flux terminal</span>
              <button
                type="button"
                className="ml-auto text-muted hover:text-ink"
                onClick={() => (location.hash = root ? `#/tasks/${root.id}` : '#/')}
                data-testid="terminal-to-workbench"
              >
                Atelier →
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <TerminalView root={root} tasks={state.tasks} events={state.events} onError={reportError} />
            </div>
          </div>
        ) : (
        <>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-canvas text-xs" role="tablist">
            <Tab active={activeTab === 'details'} onClick={() => setActiveTab('details')} testId="tab-details">
              Détails
            </Tab>
            {browsers.length > 0 && (
              <Tab active={activeTab === 'browser'} onClick={() => setActiveTab('browser')} testId="tab-browser">
                <span className="inline-flex items-center gap-1">
                  <Globe className="size-3" /> Navigateur
                  {browsers.some((b) => b.open) && <span className="size-1.5 rounded-full bg-running" aria-label="session ouverte" />}
                </span>
              </Tab>
            )}
            {effectiveId && (
              <button
                type="button"
                className="ml-auto flex items-center gap-1 px-3 text-muted hover:text-ink"
                onClick={() => (location.hash = `#/terminal/${effectiveId}`)}
                data-testid="nav-terminal-view"
                title="Vue terminal : le flux de l'arbre en lignes, lecture seule"
              >
                <SquareTerminal className="size-3.5" /> Flux terminal
              </button>
            )}
          </div>

          <section className="min-h-0 flex-1 overflow-hidden">
            {showBrowser ? (
              <BrowserPanel tasks={tree} events={state.events} approvals={state.approvals} root={root!} onError={reportError} />
            ) : (
              <div className="h-full overflow-y-auto p-5">
                {view.kind === 'new' ? (
                  <NewTaskForm onCreated={select} />
                ) : view.kind === 'agents' ? (
                  <div className="mx-auto max-w-2xl space-y-4">
                    {/* Un fournisseur ajouté ou retiré active ou désactive des
                        profils : la carte des exécutants se remonte pour les relire. */}
                    <ProvidersCard onChanged={() => setProvidersRev((n) => n + 1)} />
                    <AgentsCard key={providersRev} editable />
                    <McpServersCard />
                  </div>
                ) : task ? (
                  <TaskInspector
                    task={task}
                    tasks={state.tasks}
                    approval={approval}
                    events={state.events[task.id]}
                    onLoadEvents={loadEvents}
                    onError={reportError}
                    onSelect={select}
                  />
                ) : (
                  <Empty />
                )}
              </div>
            )}
          </section>

          {showTerminal && (
            <>
              <Resizer axis="y" label="Hauteur du terminal" onResize={resize('bottom', -1, 80, 600)} />
              <div className="flex shrink-0 flex-col" style={{ height: layout.bottom }}>
                <div className="flex items-center gap-2 border-b border-border bg-canvas px-3 py-1 text-xs">
                  <SquareTerminal className="size-3.5 text-muted" />
                  <span className="font-semibold tracking-wide text-muted uppercase">Terminal</span>
                  <span className="hidden truncate text-muted xl:inline">— commandes des agents, lecture seule</span>
                  <button type="button" className="ml-auto text-muted hover:text-ink" onClick={() => setShowTerminal(false)} aria-label="Fermer le terminal">
                    <X className="size-3.5" />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <TerminalPanel sources={terminalSources} events={state.events} />
                </div>
              </div>
            </>
          )}
        </div>

        {showChat && (
          <>
            <Resizer axis="x" label="Largeur de la conversation" onResize={resize('chat', -1, 280, 720)} />
            <aside className="min-h-0 shrink-0 overflow-hidden bg-canvas" style={{ width: chatWidth }}>
              <ChatPanel root={root} tasks={state.tasks} events={state.events} onSelect={select} onError={reportError} />
            </aside>
          </>
        )}
        </>
        )}
      </div>
    </div>
  )
}

/** Un bouton de la barre d'activité. */
function ActivityButton(props: { label: string; active: boolean; onClick: () => void; testId: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      onClick={props.onClick}
      data-testid={props.testId}
      className={cn(
        'grid size-8 place-items-center rounded-md text-muted hover:text-ink [&_svg]:size-4.5',
        props.active && 'bg-accent-soft text-accent',
      )}
    >
      {props.children}
    </button>
  )
}

/** Un onglet de la zone centrale. */
function Tab(props: { active: boolean; onClick: () => void; testId: string; children: React.ReactNode }) {
  return (
    <div
      role="tab"
      aria-selected={props.active}
      className={cn(
        'flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 py-1.5',
        props.active ? 'bg-surface text-ink' : 'text-muted hover:text-ink',
      )}
      onClick={props.onClick}
      data-testid={props.testId}
    >
      <span className="font-mono">{props.children}</span>
    </div>
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
    <div className="mx-auto max-w-xl space-y-5 pt-10">
      <div className="space-y-3 text-center">
        <h2 className="text-lg font-semibold">Rien à observer pour l'instant</h2>
        <p className="text-sm text-muted">
          Lance une conversation avec « Nouvelle tâche ». Elle apparaîtra ici en direct.
        </p>
      </div>
      <AgentsCard />
    </div>
  )
}
