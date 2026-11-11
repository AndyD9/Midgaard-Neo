/**
 * @file Le début d'une commande `harness` que le dashboard cite.
 *
 * Le dashboard conseille quelques commandes (déclarer un serveur MCP, un
 * fournisseur). Leur forme dépend de l'installation : `npm run harness --`
 * depuis un clone, le lanceur embarqué dans l'application autonome, et
 * `--home` quand le dossier runtime est désigné. Le daemon l'annonce dans
 * `/api/health` (`harness_command`) ; une commande écrite en dur serait, dans
 * l'application autonome, un conseil que personne ne peut lancer.
 */
import { createContext, useContext } from 'react'

/** Ce qu'on cite tant que le daemon n'a rien annoncé, ou s'il est plus ancien. */
export const DEFAULT_HARNESS_COMMAND = 'npm run harness --'

/** Le début de commande annoncé par le daemon, fourni par `App`. */
export const HarnessCommandContext = createContext<string>(DEFAULT_HARNESS_COMMAND)

/**
 * Le début d'une commande `harness`, et où la taper.
 *
 * @returns `prefix`, à faire suivre des arguments ; `where`, la précision à
 *          afficher avant — « à la racine du dépôt » pour npm, rien pour le
 *          lanceur de l'application autonome, qui est un chemin absolu
 */
export function useHarnessCommand(): { prefix: string; where: string } {
  const prefix = useContext(HarnessCommandContext)
  return { prefix, where: commandPlace(prefix) }
}

/** Où se tape une commande, d'après son début. Fonction pure, testée. */
export function commandPlace(prefix: string): string {
  return prefix.startsWith('npm ') ? 'dans un terminal, à la racine du dépôt' : 'dans un terminal'
}
