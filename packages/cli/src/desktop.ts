/**
 * @file `harness desktop` (Slice 6, étape 7) : ouvre la coque desktop, la
 * fenêtre Tauri du dashboard.
 *
 * La coque se construit depuis le clone par `npm run desktop:build` — Rust
 * requis, rien n'est distribué (décision du 2026-11-01). Cette commande la
 * lance en lui passant **le `node` qui tourne en ce moment** et la racine du
 * clone : la coque démarre alors le daemon par la même CLI, et vise le même
 * dossier runtime (`--home` compris). Lancée d'un double-clic, elle se sert de
 * ce que son build a retenu.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessConfig } from '@midgaard/contracts'
import { bold, dim } from './ui.ts'

/** Commande qui construit la coque, à la racine du clone. */
export const DESKTOP_BUILD = 'npm run desktop:build'

/** Racine du clone : `packages/cli/{src,dist}/desktop.*` → trois niveaux plus haut. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

/** Chemin du binaire de la coque, construit en release. */
export function desktopBinary(root: string = repoRoot()): string {
  const name = process.platform === 'win32' ? 'midgaard-desktop.exe' : 'midgaard-desktop'
  return join(root, 'apps', 'desktop', 'src-tauri', 'target', 'release', name)
}

/**
 * Version de `cargo`, ou `null` s'il n'est pas installé. La coque est
 * facultative : son absence n'est pas une panne de l'installation.
 */
export function cargoVersion(): string | null {
  try {
    return execFileSync('cargo', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * Lance la coque et attend qu'elle se ferme.
 *
 * @returns son code de sortie ; `1` si elle n'est pas construite
 */
export async function desktop(config: HarnessConfig): Promise<number> {
  const root = repoRoot()
  const binary = desktopBinary(root)
  if (!existsSync(binary)) {
    console.error(
      `La coque desktop n'est pas construite. Elle se construit depuis le clone, une fois (Rust requis) :\n\n` +
        `  ${DESKTOP_BUILD}\n\n` +
        dim('Le même dashboard reste ouvert dans un navigateur, à l\'adresse que donne `npm run harness -- start`.'),
    )
    return 1
  }
  console.log(`${bold('Midgaard')} — ouverture de la fenêtre ${dim(`(${binary})`)}`)
  const child = spawn(binary, [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      MIDGAARD_NODE: process.execPath,
      MIDGAARD_REPO: root,
      // Le dossier runtime désigné par `--home` arrive par l'environnement :
      // la coque le lit comme le fait `loadConfig`.
      ...(config.homeIsExplicit ? { MIDGAARD_HOME: config.home } : {}),
    },
  })
  return new Promise((done) => {
    child.on('error', (e) => {
      console.error(`la coque n'a pas pu démarrer : ${e.message}`)
      done(1)
    })
    child.on('exit', (code) => done(code ?? 1))
  })
}
