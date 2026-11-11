/**
 * @file Construit l'application autonome : assemble l'arbre embarqué
 * (`stage.mjs`), puis lance le bundler de Tauri avec la configuration de
 * bundle (`tauri.bundle.conf.json`), fusionnée à celle de base.
 *
 * La configuration de base garde `bundle.active: false` : la coque construite
 * depuis un clone (`npm run desktop:build`, un simple `cargo build`) n'a pas
 * à trouver un dossier `runtime/` — une ressource déclarée et absente fait
 * échouer le build. Le bundle, lui, l'exige : d'où ce second fichier.
 *
 * Un format par système, choisi ici plutôt que « tous » :
 *  - macOS : `.app` et `.dmg`. Signature **ad hoc** (`signingIdentity: "-"`) :
 *    sans elle, un binaire arm64 ne démarre pas du tout. Ce n'est pas une
 *    signature Developer ID : Gatekeeper refuse l'application téléchargée
 *    tant que l'utilisateur ne l'a pas autorisée ;
 *  - Linux : `.deb`. Pas d'AppImage : elle se monte à un chemin qui change à
 *    chaque lancement, alors que l'identité d'une installation est le dossier
 *    du paquet daemon, et qu'une commande conseillée cite le lanceur par son
 *    chemin — les deux seraient faux au lancement suivant ;
 *  - Windows : installeur NSIS, non signé.
 *
 * **Avec la clé de signature des mises à jour** dans l'environnement
 * (`TAURI_SIGNING_PRIVATE_KEY`, posée par le workflow de release), le bundler
 * produit aussi les paquets que l'application installée télécharge pour se
 * mettre à jour, chacun avec sa signature (`createUpdaterArtifacts`). Sans la
 * clé — un build local, la CI ordinaire —, rien de tel n'est demandé : le
 * bundler échouerait à signer.
 *
 * Usage, à la racine du clone :
 *
 * ```bash
 * node apps/desktop/scripts/bundle.mjs                      # assemble puis construit
 * node apps/desktop/scripts/bundle.mjs --node /chemin/node  # passe --node à l'assemblage
 * node apps/desktop/scripts/bundle.mjs --skip-stage         # l'arbre est déjà assemblé
 * ```
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const TAURI_DIR = join(ROOT, 'apps', 'desktop', 'src-tauri')
const WINDOWS = process.platform === 'win32'

/** Formats de bundle par système. */
const BUNDLES = { darwin: 'app,dmg', linux: 'deb', win32: 'nsis' }

const argv = process.argv.slice(2)
const skipStage = argv.includes('--skip-stage')
const stageArgs = argv.filter((a) => a !== '--skip-stage')
const bundles = BUNDLES[process.platform]
if (!bundles) {
  console.error(`bundle : pas de format prévu pour ${process.platform}`)
  process.exit(1)
}

try {
  if (!skipStage) execFileSync(process.execPath, [join(HERE, 'stage.mjs'), ...stageArgs], { cwd: ROOT, stdio: 'inherit' })
  if (!existsSync(join(TAURI_DIR, 'runtime', 'app', 'standalone.json'))) {
    throw new Error('arbre embarqué absent : lancer sans --skip-stage')
  }
  // La CLI de Tauri est une dépendance de développement du clone ; `npx` est
  // un `.cmd` sous Windows, que `execFile` ne lance qu'à travers un shell.
  // Elle se lance depuis `apps/desktop` : c'est de là qu'elle cherche `src-tauri/`.
  // Les paquets de mise à jour ne se construisent qu'avec la clé qui les signe.
  const updater = process.env.TAURI_SIGNING_PRIVATE_KEY
    ? ['--config', join(TAURI_DIR, 'tauri.release.conf.json')]
    : []
  execFileSync('npx', ['tauri', 'build', '--config', join(TAURI_DIR, 'tauri.bundle.conf.json'), ...updater, '--bundles', bundles], {
    cwd: join(ROOT, 'apps', 'desktop'),
    stdio: 'inherit',
    shell: WINDOWS,
  })
  console.log(`\nBundle construit : ${join(TAURI_DIR, 'target', 'release', 'bundle')}`)
} catch (e) {
  console.error(`bundle : ${e.message}`)
  process.exit(1)
}
