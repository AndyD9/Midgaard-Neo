/**
 * @file Ce qu'une release GitHub publie, et le manifeste que les applications
 * installées lisent pour se mettre à jour (`latest.json`).
 *
 * Deux temps, dans le workflow `release.yml` :
 *
 *  1. **`collect`**, sur chaque poste de build (macOS, Linux, Windows), après
 *     le bundle et l'exécutable unique : range dans un dossier les fichiers à
 *     publier, sous des noms sans ambiguïté, et écrit un **fragment** qui dit
 *     quelles cibles de mise à jour ce poste fournit, avec leur signature.
 *     C'est le poste qui sait son système et son architecture : rien n'est
 *     deviné plus tard depuis un nom de fichier ;
 *  2. **`manifest`**, une fois, quand les trois postes ont fini : fusionne les
 *     fragments en `latest.json`, avec l'adresse de chaque fichier dans la
 *     release.
 *
 * Les cibles suivent le plugin de mise à jour de Tauri (`<os>-<arch>`, avec
 * `darwin`, `linux`, `windows` et `x86_64`, `aarch64`) :
 *
 *  - le bundle est annoncé sous `<os>-<arch>-<installeur>` **et** `<os>-<arch>` :
 *    le plugin cherche la première, puis la seconde quand il ne reconnaît pas
 *    la forme de l'application installée ;
 *  - l'exécutable unique sous `<os>-<arch>-portable`, la cible que la coque
 *    demande quand elle est construite ainsi (`src/update.rs`).
 *
 * **Un fichier sans signature fait échouer `collect`** : une release dont une
 * plateforme ne pourrait pas se mettre à jour aurait l'air complète. La
 * signature elle-même n'est pas vérifiée ici — c'est l'application qui la
 * vérifie, contre la clé publique qu'elle porte.
 *
 * Usage, à la racine du clone :
 *
 * ```bash
 * node apps/desktop/scripts/release.mjs collect --out release-assets
 * node apps/desktop/scripts/release.mjs manifest --dir release-assets --tag v0.2.0 --repo AndyD9/Midgaard-Neo --notes-file notes.md
 * ```
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const TAURI_DIR = join(ROOT, 'apps', 'desktop', 'src-tauri')

/** Noms du plugin de mise à jour pour les systèmes et architectures de Node. */
const OS = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
const ARCH = { x64: 'x86_64', arm64: 'aarch64' }
/** L'installeur que le bundle produit sur chaque système, tel que le plugin le nomme. */
const INSTALLER = { darwin: 'app', linux: 'deb', win32: 'nsis' }

/**
 * Les cibles de mise à jour qu'un poste de build fournit.
 *
 * @param {string} platform `process.platform` du poste
 * @param {string} arch     `process.arch` du poste
 * @returns {{ bundle: string[], portable: string }} les cibles du bundle, la plus précise d'abord, et celle de l'exécutable unique
 * @throws si le poste n'est pas une plateforme que le plugin connaît
 */
export function targetsFor(platform, arch) {
  const os = OS[platform]
  const cpu = ARCH[arch]
  if (!os || !cpu) throw new Error(`pas de cible de mise à jour pour ${platform}-${arch}`)
  return { bundle: [`${os}-${cpu}-${INSTALLER[platform]}`, `${os}-${cpu}`], portable: `${os}-${cpu}-portable` }
}

/**
 * Compose `latest.json` à partir des fragments des postes de build.
 *
 * @param {object} input
 * @param {string} input.tag       le tag de la release, `v` compris (`v0.2.0`)
 * @param {string} input.repo      `propriétaire/dépôt`
 * @param {string} input.notes     notes de version, montrées dans le dialogue de mise à jour
 * @param {string} input.pubDate   date de publication, ISO 8601
 * @param {{ version: string, targets: Record<string, { file: string, signature: string }> }[]} input.fragments
 * @returns {{ version: string, notes: string, pub_date: string, platforms: Record<string, { url: string, signature: string }> }}
 * @throws si un fragment n'est pas de la version du tag, si une cible est
 *         fournie deux fois, ou si aucune n'est fournie
 */
export function buildManifest({ tag, repo, notes, pubDate, fragments }) {
  const version = tag.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`tag « ${tag} » : pas une version (attendu vX.Y.Z)`)
  const platforms = {}
  for (const fragment of fragments) {
    if (fragment.version !== version) {
      throw new Error(`un poste a construit la version ${fragment.version}, le tag dit ${version}`)
    }
    for (const [target, { file, signature }] of Object.entries(fragment.targets)) {
      if (platforms[target]) throw new Error(`cible ${target} fournie par deux postes`)
      if (!signature?.trim()) throw new Error(`cible ${target} sans signature`)
      platforms[target] = {
        url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(file)}`,
        signature: signature.trim(),
      }
    }
  }
  if (Object.keys(platforms).length === 0) throw new Error('aucune cible de mise à jour : aucun poste n\'a rendu de fragment')
  return { version, notes, pub_date: pubDate, platforms }
}

/** Le seul fichier d'un dossier dont le nom finit par `suffix`. */
function only(dir, suffix) {
  const found = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(suffix)) : []
  if (found.length !== 1) throw new Error(`${dir} : un fichier « *${suffix} » attendu, ${found.length} trouvé(s)`)
  return join(dir, found[0])
}

/** La signature posée à côté d'un fichier par le bundler ou par `tauri signer sign`. */
function signatureOf(file) {
  if (!existsSync(`${file}.sig`)) {
    throw new Error(`${file} n'est pas signé : construire avec TAURI_SIGNING_PRIVATE_KEY (clé de signature des mises à jour)`)
  }
  return readFileSync(`${file}.sig`, 'utf8').trim()
}

/** `collect` : range les fichiers à publier de ce poste, et écrit son fragment. */
function collect(outDir) {
  const { platform, arch } = process
  const targets = targetsFor(platform, arch)
  const { version } = JSON.parse(readFileSync(join(TAURI_DIR, 'tauri.conf.json'), 'utf8'))
  const bundle = join(TAURI_DIR, 'target', 'release', 'bundle')
  mkdirSync(outDir, { recursive: true })
  const publish = (from, name) => (copyFileSync(from, join(outDir, name)), name)
  const fragment = { version, targets: {} }

  // Le paquet que l'application installée télécharge pour se mettre à jour.
  // Sous macOS, c'est l'archive du `.app` — dont le nom ne dit ni la version
  // ni l'architecture : on les y met. Ailleurs, c'est l'installeur lui-même,
  // publié aussi pour un premier téléchargement.
  let updater
  if (platform === 'darwin') {
    const archive = only(join(bundle, 'macos'), '.app.tar.gz')
    updater = { file: publish(archive, `Midgaard_${version}_${targets.bundle[1]}.app.tar.gz`), signature: signatureOf(archive) }
    const dmg = only(join(bundle, 'dmg'), '.dmg')
    publish(dmg, dmg.split(/[\\/]/).pop())
  } else {
    const installer = platform === 'win32' ? only(join(bundle, 'nsis'), '-setup.exe') : only(join(bundle, 'deb'), '.deb')
    updater = { file: publish(installer, installer.split(/[\\/]/).pop()), signature: signatureOf(installer) }
  }
  for (const target of targets.bundle) fragment.targets[target] = updater

  // L'exécutable unique : le même fichier sert au premier téléchargement et à
  // la mise à jour.
  const portableDir = join(bundle, 'portable')
  const portable = join(portableDir, readdirSync(portableDir).find((f) => f.startsWith('Midgaard-portable-') && !f.endsWith('.sig')) ?? 'absent')
  fragment.targets[targets.portable] = { file: publish(portable, portable.split(/[\\/]/).pop()), signature: signatureOf(portable) }

  writeFileSync(join(outDir, `fragment-${platform}-${arch}.json`), `${JSON.stringify(fragment, null, 2)}\n`)
  console.log(`Fichiers à publier dans ${outDir} :`)
  for (const name of readdirSync(outDir)) console.log(`  ${name}`)
}

/** `manifest` : fusionne les fragments en `latest.json`, puis les retire — ils ne se publient pas. */
function manifest(dir, tag, repo, notesFile) {
  const names = readdirSync(dir).filter((f) => /^fragment-.+\.json$/.test(f))
  const fragments = names.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8').trim() : ''
  const built = buildManifest({ tag, repo, notes, pubDate: new Date().toISOString(), fragments })
  // Chaque fichier annoncé doit être là : une adresse vers un fichier absent
  // de la release ferait échouer la mise à jour chez l'utilisateur, pas ici.
  for (const [target, { url }] of Object.entries(built.platforms)) {
    const file = decodeURIComponent(url.split('/').pop())
    if (!existsSync(join(dir, file))) throw new Error(`cible ${target} : ${file} absent de ${dir}`)
  }
  for (const f of names) rmSync(join(dir, f))
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(built, null, 2)}\n`)
  console.log(`latest.json : version ${built.version}, cibles ${Object.keys(built.platforms).sort().join(', ')}`)
}

/** Valeur d'une option `--nom valeur`. */
function option(argv, name) {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}

// Lancé comme script seulement : les tests importent les fonctions.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...argv] = process.argv.slice(2)
  try {
    if (command === 'collect') {
      collect(resolve(option(argv, 'out') ?? 'release-assets'))
    } else if (command === 'manifest') {
      const tag = option(argv, 'tag')
      const repo = option(argv, 'repo')
      if (!tag || !repo) throw new Error('manifest : --tag et --repo sont requis')
      manifest(resolve(option(argv, 'dir') ?? 'release-assets'), tag, repo, option(argv, 'notes-file'))
    } else {
      throw new Error('commande attendue : collect ou manifest')
    }
  } catch (e) {
    console.error(`release : ${e.message}`)
    process.exit(1)
  }
}
