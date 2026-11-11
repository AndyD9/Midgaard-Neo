/**
 * @file Le terminal du dashboard (Slice 6) : les commandes des agents d'un
 * arbre et leur sortie, en direct, **en lecture seule**.
 *
 * Aucun shell n'est exposé (décision de l'auteur) : xterm.js sert ici
 * d'afficheur, sans clavier (`disableStdin`). Le contenu est composé par
 * `buildTerminal` depuis le journal, qui nettoie les séquences d'échappement
 * de la sortie avant qu'elle n'arrive ici.
 *
 * **N'écrire que le nouveau.** Le journal grossit par la fin : à chaque
 * événement, seuls les morceaux pas encore écrits le sont. Si la liste a changé
 * ailleurs qu'à la fin — une timeline chargée après coup apporte des morceaux
 * plus anciens —, le terminal est vidé et tout est réécrit, dans l'ordre.
 */
import { useEffect, useMemo, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TaskEvent } from '@midgaard/contracts'
import { buildTerminal, type TerminalSource } from '@/lib/terminal'

/**
 * Une couleur du thème, en `rgb()` : xterm ne lit pas `oklch()`, dans lequel le
 * thème est écrit. Le navigateur fait la conversion en peignant un pixel.
 */
function themeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!value) return fallback
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d')
  if (!ctx) return fallback
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${g}, ${b})`
}

export function TerminalPanel({
  sources,
  events,
}: {
  sources: TerminalSource[]
  events: Record<string, TaskEvent[] | undefined>
}) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const written = useRef<string[]>([])
  const chunks = useMemo(() => buildTerminal(sources, events), [sources, events])

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const terminal = new Terminal({
      disableStdin: true,
      convertEol: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || 'monospace',
      fontSize: 12,
      scrollback: 10_000,
      theme: {
        background: themeColor('--color-surface', '#1e1e24'),
        foreground: themeColor('--color-ink', '#e6e6ea'),
        cursor: themeColor('--color-surface', '#1e1e24'),
        selectionBackground: themeColor('--color-accent-soft', '#3a3a55'),
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(parent)
    term.current = terminal
    written.current = []
    // Le panneau se redimensionne à la souris : le terminal suit.
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // Panneau replié à zéro : rien à ajuster.
      }
    })
    observer.observe(parent)
    return () => {
      observer.disconnect()
      terminal.dispose()
      term.current = null
    }
  }, [])

  useEffect(() => {
    const terminal = term.current
    if (!terminal) return
    const keys = chunks.map((c) => c.key)
    const prefixHolds = written.current.every((k, i) => keys[i] === k)
    if (!prefixHolds) {
      terminal.reset()
      written.current = []
    }
    for (const chunk of chunks.slice(written.current.length)) {
      terminal.write(chunk.text)
      written.current.push(chunk.key)
    }
  }, [chunks])

  return (
    <div className="relative h-full min-h-0" data-testid="terminal-panel" data-chunks={chunks.length}>
      <div ref={host} className="h-full px-2 py-1" />
      {chunks.length === 0 && (
        <p className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-muted">
          Aucune commande lancée par les agents de cette tâche.
        </p>
      )}
    </div>
  )
}
