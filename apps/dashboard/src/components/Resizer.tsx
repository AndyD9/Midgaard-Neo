/**
 * @file Séparateur de panneaux, à déplacer à la souris (Slice 6).
 *
 * Il ne connaît pas la taille des panneaux : il rend le déplacement, en pixels,
 * depuis le début du geste, et c'est le parent qui borne et applique. La
 * capture du pointeur garde le geste même quand la souris passe sur
 * l'éditeur ou le terminal, qui sinon la prendraient.
 */
import { useRef, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

export function Resizer({
  axis,
  onResize,
  label,
}: {
  /** `x` : séparateur vertical, qui se déplace à gauche et à droite. */
  axis: 'x' | 'y'
  /** Déplacement depuis le début du geste, en pixels. */
  onResize: (delta: number, phase: 'start' | 'move') => void
  label: string
}) {
  const origin = useRef<number | null>(null)

  const down = (e: PointerEvent<HTMLDivElement>) => {
    origin.current = axis === 'x' ? e.clientX : e.clientY
    e.currentTarget.setPointerCapture(e.pointerId)
    onResize(0, 'start')
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (origin.current === null) return
    onResize((axis === 'x' ? e.clientX : e.clientY) - origin.current, 'move')
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    origin.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      className={cn(
        'shrink-0 bg-border transition-colors hover:bg-accent',
        axis === 'x' ? 'w-px cursor-col-resize hover:w-1' : 'h-px cursor-row-resize hover:h-1',
      )}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
    />
  )
}
