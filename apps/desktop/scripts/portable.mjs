/**
 * @file Construit l'**exécutable unique** : un seul fichier à copier et à
 * lancer, sans installeur. L'arbre embarqué (`runtime/` : Node, harness
 * compilé, dépendances, dashboard, lanceur) est archivé puis inclus **dans**
 * le binaire de la coque (`--features portable`), qui le déplie à son premier
 * lancement dans le dossier de données de l'application.
 *
 * Ce que cela change par rapport au bundle (`bundle.mjs`) :
 *  - rien à installer, rien à désinstaller par un installeur : pour retirer
 *    l'application, on supprime le fichier et son dossier de données ;
 *  - **le premier lancement déplie** quelques milliers de fichiers avant
 *    d'ouvrir la fenêtre — plusieurs secondes, davantage sous un antivirus ;
 *  - sous Windows, le moteur web (WebView2) n'est pas installé par
 *    l'exécutable : il est livré avec Windows 11 et les Windows 10 à jour,
 *    mais une machine qui ne l'a pas n'ouvrira pas la fenêtre.
 *
 * Usage, à la racine du clone :
 *
 * ```bash
 * node apps/desktop/scripts/portable.mjs                 # assemble, archive, compile
 * node apps/desktop/scripts/portable.mjs --skip-stage    # l'arbre est déjà assemblé
 * node apps/desktop/scripts/portable.mjs --skip-build    # passé à l'assemblage
 * ```
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const TAURI_DIR = join(ROOT, 'apps', 'desktop', 'src-tauri')
const WINDOWS = process.platform === 'win32'

const argv = process.argv.slice(2)
const skipStage = argv.includes('--skip-stage')
const stageArgs = argv.filter((a) => a !== '--skip-stage')

try {
  if (!skipStage) execFileSync(process.execPath, [join(HERE, 'stage.mjs'), ...stageArgs], { cwd: ROOT, stdio: 'inherit' })
  if (!existsSync(join(TAURI_DIR, 'runtime', 'app', 'standalone.json'))) throw new Error('arbre embarqué absent : lancer sans --skip-stage')

  // L'archive garde le dossier `runtime/` en tête et les droits d'exécution.
  // `tar` est livré avec les trois systèmes (bsdtar sous Windows).
  const archive = join(TAURI_DIR, 'runtime.tar.gz')
  console.log('Archivage de l\'arbre embarqué…')
  execFileSync('tar', ['-czf', archive, '-C', TAURI_DIR, 'runtime'], { stdio: 'inherit' })

  // Un `cargo build` simple : pas de bundler, donc pas de CLI Tauri. Le
  // dossier cible est à part, pour ne pas recompiler la coque ordinaire à
  // chaque changement de fonctionnalité.
  const target = join(TAURI_DIR, 'target', 'portable')
  execFileSync('cargo', ['build', '--release', '--locked', '--features', 'portable', '--manifest-path', join(TAURI_DIR, 'Cargo.toml'), '--target-dir', target], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, MIDGAARD_RUNTIME_ARCHIVE: archive },
  })

  const built = join(target, 'release', WINDOWS ? 'midgaard-desktop.exe' : 'midgaard-desktop')
  const outDir = join(TAURI_DIR, 'target', 'release', 'bundle', 'portable')
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `Midgaard-portable-${process.platform}-${process.arch}${WINDOWS ? '.exe' : ''}`)
  copyFileSync(built, out)
  console.log(`\nExécutable unique : ${out} (${Math.round(statSync(out).size / 1024 / 1024)} Mo)`)
} catch (e) {
  console.error(`portable : ${e.message}`)
  process.exit(1)
}
