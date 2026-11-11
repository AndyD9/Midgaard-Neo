/**
 * @file Fichiers et diff d'une tâche Developer : ce que l'agent a changé, lu
 * avant de décider du merge.
 *
 * C'est la moitié du livrable de la Slice 3 que l'humain voit : « le diff est
 * consultable ». Trois choix y sont délibérés :
 *
 *  - **le diff est recalculé** à chaque événement d'outil ou de worktree, jamais
 *    figé : pendant que l'agent travaille, c'est ce qu'il y a sur le disque qui
 *    compte, travail non commité compris ;
 *  - **ce qui manque est dit** : le travail non commité de l'utilisateur, absent
 *    du worktree, et un patch tronqué, qui l'annonce plutôt que de paraître complet ;
 *  - **le patch est rendu comme du texte**, ligne par ligne. Il vient de fichiers
 *    écrits par un agent : React l'échappe, et rien n'en est interprété — pas de
 *    Markdown, pas de HTML.
 *
 * Le harness ne merge jamais : la carte montre la commande Git qui le ferait,
 * pour l'humain qui décide.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, FolderGit2, TriangleAlert } from 'lucide-react'
import type { FileChange, FileChangeKind, TaskEvent, TaskWorkspaceResponse } from '@midgaard/contracts'
import { fetchTaskWorkspace } from '@/lib/api'
import { splitPatch } from '@/lib/patch'
import { Badge, type BadgeTone } from './ui/badge'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

/** Libellé et ton de chaque nature de changement. */
const KIND: Record<FileChangeKind, { label: string; tone: BadgeTone }> = {
  added: { label: 'ajouté', tone: 'done' },
  modified: { label: 'modifié', tone: 'running' },
  deleted: { label: 'supprimé', tone: 'danger' },
  type_changed: { label: 'type changé', tone: 'waiting' },
}

/**
 * Nombre d'événements qui peuvent avoir changé le diff. Recharger à chaque
 * événement de la tâche lancerait un `git diff` par mise à jour de
 * consommation ; seuls comptent les outils et le cycle du worktree.
 */
function diffVersion(events: TaskEvent[] | undefined): number {
  return (events ?? []).filter((e) => e.type === 'tool.completed' || e.type.startsWith('workspace.')).length
}

export function WorkspaceCard({ taskId, events }: { taskId: string; events: TaskEvent[] | undefined }) {
  const [view, setView] = useState<TaskWorkspaceResponse | null>(null)
  const version = diffVersion(events)

  useEffect(() => {
    let abandoned = false
    fetchTaskWorkspace(taskId)
      .then((body) => {
        if (!abandoned) setView(body)
      })
      .catch(() => {
        if (!abandoned) setView(null)
      })
    return () => {
      abandoned = true
    }
  }, [taskId, version])

  // Une tâche sans worktree — Researcher, simulée — n'a rien à montrer ici.
  if (!view?.workspace) return null
  const { workspace, diff } = view

  return (
    <Card data-testid="workspace-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderGit2 className="size-4 text-muted" /> Fichiers et diff
        </CardTitle>
        <span className="text-xs text-muted">
          {diff ? `${diff.files.length} fichier(s) · +${diff.additions} −${diff.deletions}` : workspace.status}
        </span>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted">Branche</dt>
          <dd className="font-mono" data-testid="workspace-branch">{workspace.branch}</dd>
          <dt className="text-muted">Depuis</dt>
          <dd className="font-mono">
            {workspace.base_commit.slice(0, 12)}
            {workspace.base_ref ? ` (${workspace.base_ref})` : ' (HEAD détaché)'}
          </dd>
          <dt className="text-muted">Worktree</dt>
          <dd className="break-all font-mono">
            {workspace.worktree_path} <span className="text-muted">— {workspace.status}</span>
          </dd>
        </dl>

        {workspace.base_dirty > 0 && (
          <p className="flex gap-2 rounded-md border border-waiting/40 bg-waiting/10 px-3 py-2 text-xs text-waiting">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            {workspace.base_dirty} fichier(s) non commité(s) du dépôt d'origine ne sont pas dans ce worktree : l'agent
            est parti du dernier commit, et ne les a pas vus.
          </p>
        )}

        {workspace.submodules.length > 0 && (
          <p className="flex gap-2 rounded-md border border-waiting/40 bg-waiting/10 px-3 py-2 text-xs text-waiting">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Sous-module(s) vide(s) dans ce worktree, jamais initialisé(s) :{' '}
              <span className="font-mono">{workspace.submodules.join(', ')}</span>. L'agent n'a pu ni les lire ni
              les modifier.
            </span>
          </p>
        )}

        {view.unavailable && <p className="text-xs text-muted">{view.unavailable}</p>}

        {diff && diff.files.length === 0 && <p className="text-xs text-muted">Aucun changement pour l'instant.</p>}

        {diff && diff.files.length > 0 && (
          <>
            <Patch patch={diff.patch} files={diff.files} />
            {diff.patch_truncated && (
              <p className="text-xs text-waiting">
                Patch tronqué : {diff.patch_bytes} octets au total. La liste des fichiers et les compteurs, eux, sont
                complets ; la branche contient tout.
              </p>
            )}
            <p className="text-xs text-muted">
              Le harness ne merge jamais. Pour intégrer ce travail, depuis le dépôt :{' '}
              <code className="rounded bg-canvas px-1 font-mono">git merge {workspace.branch}</code>
            </p>
          </>
        )}
      </CardBody>
    </Card>
  )
}

/** Le patch, découpé fichier par fichier, chaque fichier dépliable. */
function Patch({ patch, files }: { patch: string; files: FileChange[] }) {
  const chunks = useMemo(() => splitPatch(patch), [patch])
  return (
    <ul className="divide-y divide-border rounded-md border border-border" data-testid="workspace-files">
      {files.map((f) => (
        <FileDiff key={f.path} file={f} chunk={chunks.get(f.path) ?? null} />
      ))}
    </ul>
  )
}

function FileDiff({ file, chunk }: { file: FileChange; chunk: string | null }) {
  const [open, setOpen] = useState(false)
  // Une nature inconnue vient d'un daemon plus récent que la page : montrée
  // telle quelle plutôt que de démonter l'interface.
  const look = (KIND as Partial<Record<string, { label: string; tone: BadgeTone }>>)[file.kind]
    ?? { label: file.kind, tone: 'waiting' as BadgeTone }
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-canvas"
      >
        <ChevronRight className={`size-3 shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
        <Badge tone={look.tone}>{look.label}</Badge>
        <span className="shrink-0 font-mono text-[11px]">
          {file.binary ? (
            <span className="text-muted">binaire</span>
          ) : (
            <>
              <span className="text-done">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>
            </>
          )}
        </span>
      </button>
      {open && (
        <pre className="max-h-[32rem] overflow-auto border-t border-border bg-canvas py-1 font-mono text-[11px] leading-snug">
          {chunk === null ? (
            <span className="px-3 text-muted">
              {file.binary ? 'Fichier binaire : pas de patch lisible.' : 'Patch absent : il a été tronqué avant ce fichier.'}
            </span>
          ) : (
            chunk.split('\n').map((line, i) => (
              <div key={i} className={`px-3 ${lineClass(line)}`}>
                {line || ' '}
              </div>
            ))
          )}
        </pre>
      )}
    </li>
  )
}

/** Couleur d'une ligne de patch unifié. Les en-têtes `+++`/`---` ne sont ni des ajouts ni des retraits. */
function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted'
  if (line.startsWith('+')) return 'bg-done/10 text-done'
  if (line.startsWith('-')) return 'bg-danger/10 text-danger'
  if (line.startsWith('@@')) return 'text-running'
  return ''
}
