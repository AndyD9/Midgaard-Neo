/**
 * @file Le filet de l'application : une erreur d'affichage se dit, au lieu de
 * laisser une page vide.
 *
 * Sans lui, React démonte tout l'arbre à la première erreur de rendu, et il
 * ne reste que le fond de la page. C'est ce qu'a vu l'auteur le 2026-11-05 dans
 * la fenêtre desktop, qu'il a prise pour un gel : rien ne disait qu'une erreur
 * avait eu lieu, ni quoi faire. La cause de ce cas-là se corrige ailleurs
 * (`lib/bundle.ts`) ; ce filet est pour les suivants.
 */
import { Component, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from './ui/button'

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Entoure l'application. Une erreur de rendu affiche son message et un bouton
 * « Recharger » ; un rechargement reprend la tâche ouverte, que le fragment de
 * l'URL désigne.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  /** @returns l'état qui fait afficher le filet à la place de l'application */
  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div role="alert" data-testid="render-error" className="grid h-full place-items-center p-6">
        <div className="max-w-lg space-y-3 rounded-md border border-danger/40 bg-surface p-5">
          <p className="flex items-center gap-2 font-medium text-danger">
            <TriangleAlert className="size-4" /> L'affichage a rencontré une erreur
          </p>
          <p className="font-mono text-xs break-words text-muted">{error.message}</p>
          <p className="text-sm text-muted">
            Le daemon a peut-être été mis à jour pendant que cette page restait ouverte. Les tâches
            continuent : seul l'affichage s'est arrêté.
          </p>
          <Button onClick={() => location.reload()}>Recharger</Button>
        </div>
      </div>
    )
  }
}
