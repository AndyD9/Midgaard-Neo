/**
 * @file Pastille d'état.
 *
 * Les variantes reprennent **les rôles de couleur du thème**, pas des couleurs
 * littérales : un statut garde ainsi la même couleur dans la liste, l'inspecteur
 * et la timeline, en clair comme en sombre.
 */
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import type { TaskStatus } from '@midgaard/contracts'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-canvas text-muted',
        running: 'border-running/30 bg-running/10 text-running',
        waiting: 'border-waiting/40 bg-waiting/15 text-waiting',
        done: 'border-done/30 bg-done/10 text-done',
        danger: 'border-danger/30 bg-danger/10 text-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type Tone = NonNullable<VariantProps<typeof badgeVariants>['tone']>
/** Alias lisible pour les composants qui indexent un ton par statut. */
export type BadgeTone = Tone

/**
 * Rôle de couleur d'un statut de tâche.
 *
 * Trois familles : ce qui avance (bleu), ce qui attend une décision ou un
 * message (ambre), ce qui s'est terminé — bien (vert) ou mal (rouge).
 */
export function toneForStatus(status: TaskStatus): Tone {
  switch (status) {
    case 'completed':
      return 'done'
    case 'waiting_approval':
    case 'waiting_input':
    case 'cancel_requested':
      return 'waiting'
    case 'failed':
    case 'cancelled':
    case 'timed_out':
    case 'budget_exceeded':
    case 'interrupted':
      return 'danger'
    default:
      return 'running'
  }
}

export function Badge({ className, tone, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
