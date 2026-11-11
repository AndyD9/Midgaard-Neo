/**
 * @file Options globales de la CLI, analysées avant toute commande.
 *
 * Séparé de `main.ts`, qui exécute la commande dès son chargement : un test
 * peut ainsi importer l'analyse sans lancer la CLI.
 */
import { resolve } from 'node:path'

/**
 * Retire l'option globale `--home <dossier>` (ou `--home=dossier`) des
 * arguments, où qu'elle soit avant un éventuel `--`.
 *
 * Elle vaut `MIDGAARD_HOME`, et c'est la forme que redisent les commandes
 * conseillées hors de la CLI (`harnessCommand`) : une variable d'environnement
 * ne se préfixe pas de la même façon sous zsh, PowerShell et cmd. Retirée avant
 * tout le reste, pour qu'aucune commande ne la prenne pour un de ses arguments
 * — `init --home x` aurait déclaré le serveur dans un dossier `--home`. Après
 * `--`, rien n'est lu : `exec allow -- outil --home x` met en liste blanche
 * l'argv exact qu'on lui donne, `--home x` compris.
 *
 * @param argv arguments, sans `node` ni le chemin du script
 * @param cwd  dossier contre lequel résoudre un chemin relatif : celui d'où
 *             l'utilisateur a lancé npm (`INIT_CWD`), pas la racine du clone
 *             où npm exécute le script
 * @returns le dossier désigné (absolu) ou `null`, et les arguments restants
 * @throws si `--home` n'est suivi d'aucun dossier
 */
export function extractHome(argv: string[], cwd: string): { home: string | null; rest: string[] } {
  let home: string | null = null
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') {
      rest.push(...argv.slice(i))
      break
    }
    if (arg === '--home' || arg.startsWith('--home=')) {
      const value = arg === '--home' ? argv[++i] : arg.slice('--home='.length)
      if (!value) throw new Error('--home attend un dossier')
      home = resolve(cwd, value)
    } else {
      rest.push(arg)
    }
  }
  return { home, rest }
}
