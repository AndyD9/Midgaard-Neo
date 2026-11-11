/**
 * @file La version de Midgaard, écrite en un seul geste partout où elle l'est.
 *
 * Une release se nomme par son tag (`v0.2.0`), et l'application installée
 * compare **sa** version à celle de la release pour savoir si elle doit se
 * mettre à jour. Or la version est écrite à plusieurs endroits, qui doivent
 * dire la même chose :
 *
 *  - `apps/desktop/src-tauri/tauri.conf.json` — celle que l'application
 *    annonce, et que portent les signatures de mise à jour ;
 *  - `apps/desktop/src-tauri/Cargo.toml` et `Cargo.lock` — le binaire (le
 *    build est `--locked` : les deux doivent bouger ensemble) ;
 *  - le `package.json` de la racine et de chaque paquet du workspace, et
 *    `package-lock.json` — la version d'une **installation** du daemon est
 *    celle de son paquet : c'est elle qui fait remplacer un daemon d'une
 *    version précédente après une mise à jour.
 *
 * Usage, à la racine du clone :
 *
 * ```bash
 * node apps/desktop/scripts/version.mjs              # dit la version, échoue si les fichiers divergent
 * node apps/desktop/scripts/version.mjs set 0.2.0    # l'écrit partout
 * node apps/desktop/scripts/version.mjs check v0.2.0 # échoue si ce n'est pas la version des fichiers
 * ```
 *
 * `check` est ce que lance le workflow de release avant de construire : un
 * tag qui ne dit pas la version des fichiers publierait une application qui
 * se croit d'une autre version que sa release.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const TAURI_DIR = join(ROOT, 'apps', 'desktop', 'src-tauri')

/** Une version publiable : `X.Y.Z`, avec une pré-version facultative. */
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Les `package.json` du workspace, relatifs à la racine : la racine, puis chaque paquet. */
function workspacePackages(root) {
  const { workspaces } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const dirs = ['']
  for (const pattern of workspaces) {
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2)
      for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json'))) dirs.push(`${parent}/${entry.name}`)
      }
    } else if (existsSync(join(root, pattern, 'package.json'))) {
      dirs.push(pattern)
    }
  }
  return dirs
}

/** La ligne `version = "…"` du paquet `midgaard-desktop`, dans un `Cargo.toml` ou un `Cargo.lock`. */
const CARGO_VERSION = /(name = "midgaard-desktop"\nversion = ")([^"]+)(")/

/**
 * Lit la version à chaque endroit où elle est écrite.
 *
 * @param {string} [root] racine du clone
 * @returns {Record<string, string>} la version, par fichier relatif à la racine
 */
export function readVersions(root = ROOT) {
  const tauri = join(root, 'apps', 'desktop', 'src-tauri')
  const found = {}
  for (const dir of workspacePackages(root)) {
    const file = dir ? `${dir}/package.json` : 'package.json'
    found[file] = JSON.parse(readFileSync(join(root, file), 'utf8')).version
  }
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  found['package-lock.json'] = lock.version
  for (const dir of workspacePackages(root)) {
    found[`package-lock.json (${dir || 'racine'})`] = lock.packages[dir]?.version
  }
  found['apps/desktop/src-tauri/tauri.conf.json'] = JSON.parse(readFileSync(join(tauri, 'tauri.conf.json'), 'utf8')).version
  for (const name of ['Cargo.toml', 'Cargo.lock']) {
    found[`apps/desktop/src-tauri/${name}`] = CARGO_VERSION.exec(readFileSync(join(tauri, name), 'utf8').replace(/\r\n/g, '\n'))?.[2]
  }
  return found
}

/**
 * La version commune à tous les fichiers.
 *
 * @param {Record<string, string>} versions ce que rend {@link readVersions}
 * @returns {string} la version
 * @throws si deux fichiers ne disent pas la même, en nommant chacun
 */
export function agreedVersion(versions) {
  const distinct = new Set(Object.values(versions))
  if (distinct.size === 1 && SEMVER.test([...distinct][0] ?? '')) return [...distinct][0]
  const lines = Object.entries(versions).map(([file, v]) => `  ${file} : ${v ?? 'absente'}`)
  throw new Error(`les fichiers ne disent pas la même version :\n${lines.join('\n')}\n` + 'Les réaligner : node apps/desktop/scripts/version.mjs set X.Y.Z')
}

/**
 * Remplace la **première** ligne `"version": "…"` d'un fichier JSON — celle du
 * paquet lui-même, écrite avant toute dépendance — sans toucher au reste : un
 * fichier relu puis réécrit par `JSON.stringify` perdrait sa mise en forme, et
 * une montée de version reformaterait tout le dépôt.
 */
function patchVersionLine(file, version) {
  const text = readFileSync(file, 'utf8')
  const line = /^(\s*"version":\s*")[^"]*(")/m
  if (!line.test(text)) throw new Error(`${file} : aucune ligne "version"`)
  writeFileSync(file, text.replace(line, `$1${version}$2`))
}

/** Réécrit `package-lock.json`, que npm écrit lui-même avec deux espaces et une fin de ligne. */
function patchLock(file, patch) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  patch(data)
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/**
 * Écrit la version partout.
 *
 * @param {string} version la nouvelle version, sans `v`
 * @param {string} [root]  racine du clone
 * @throws si ce n'est pas une version `X.Y.Z`
 */
export function writeVersion(version, root = ROOT) {
  if (!SEMVER.test(version)) throw new Error(`« ${version} » n'est pas une version (attendu X.Y.Z, sans « v »)`)
  const tauri = join(root, 'apps', 'desktop', 'src-tauri')
  const dirs = workspacePackages(root)
  for (const dir of dirs) patchVersionLine(join(root, dir, 'package.json'), version)
  patchLock(join(root, 'package-lock.json'), (lock) => {
    lock.version = version
    for (const dir of dirs) if (lock.packages[dir]) lock.packages[dir].version = version
  })
  patchVersionLine(join(tauri, 'tauri.conf.json'), version)
  for (const name of ['Cargo.toml', 'Cargo.lock']) {
    const file = join(tauri, name)
    const text = readFileSync(file, 'utf8')
    if (!CARGO_VERSION.test(text.replace(/\r\n/g, '\n'))) throw new Error(`${file} : paquet midgaard-desktop introuvable`)
    writeFileSync(file, text.replace(/(name = "midgaard-desktop"\r?\nversion = ")([^"]+)(")/, `$1${version}$3`))
  }
}

// Lancé comme script seulement : les tests importent les fonctions.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, value] = process.argv.slice(2)
  try {
    if (command === 'set') {
      writeVersion(value ?? '')
      console.log(`Version ${agreedVersion(readVersions())} écrite partout.`)
    } else if (command === 'check') {
      const version = agreedVersion(readVersions())
      const asked = (value ?? '').replace(/^v/, '')
      if (asked !== version) {
        throw new Error(
          `le tag dit ${asked || 'rien'}, les fichiers disent ${version}.\n` +
            `Avant de poser le tag : node apps/desktop/scripts/version.mjs set ${asked || 'X.Y.Z'}, puis commit.`,
        )
      }
      console.log(`Version ${version} : le tag et les fichiers concordent.`)
    } else if (command === undefined) {
      console.log(agreedVersion(readVersions()))
    } else {
      throw new Error('commande attendue : set X.Y.Z, check vX.Y.Z, ou rien')
    }
  } catch (e) {
    console.error(`version : ${e.message}`)
    process.exit(1)
  }
}
