/**
 * @file Assemble ce que l'application autonome embarque : un Node, le harness
 * compilé, ses dépendances de production, le dashboard compilé et le lanceur
 * de la CLI. Le dossier produit (`apps/desktop/src-tauri/runtime/`) est une
 * ressource du bundle Tauri (`tauri.conf.json`, `bundle.resources`).
 *
 * ```text
 * runtime/
 *   node[.exe]                          le Node embarqué, et sa licence (NODE-LICENSE)
 *   app/
 *     standalone.json                   version, Node, commit : ce qui a été assemblé
 *     package.json                      { "type": "module" }
 *     bin/harness, bin/harness.cmd      le lanceur de la CLI
 *     dashboard/                        apps/dashboard/dist
 *     node_modules/@midgaard/<paquet>/  package.json, dist/, données (pricing.json)
 *     node_modules/<dépendance>/        la fermeture de production, telle qu'installée
 * ```
 *
 * Trois choix :
 *
 *  - **les paquets du workspace sont copiés, pas liés.** Dans le clone,
 *    `node_modules/@midgaard/*` sont des liens vers `packages/*` ; un lien ne
 *    survit ni à un bundle Windows ni à une archive. Sans la condition
 *    `midgaard-dev`, leurs `exports` mènent à `dist/` : aucune source n'est
 *    embarquée, et rien n'est à compiler chez l'utilisateur ;
 *  - **les dépendances viennent du `node_modules` du clone**, donc du
 *    `package-lock.json` : la liste est celle de `npm ls --omit=dev` pour la
 *    CLI, qui dépend du daemon, donc de tout. Aucun `npm install` ici, aucun
 *    script de paquet exécuté, aucune version résolue au moment du build ;
 *  - **le Node embarqué doit être autonome.** Celui de Homebrew ou d'une
 *    distribution Linux est lié à des bibliothèques de la machine
 *    (`libnode`, `libuv`…) : copié, il ne démarre nulle part ailleurs —
 *    constaté sur le poste de l'auteur. Le script le refuse, et prend à
 *    défaut la version officielle de nodejs.org, vérifiée par son SHA-256.
 *
 * Usage, à la racine du clone :
 *
 * ```bash
 * node apps/desktop/scripts/stage.mjs                      # télécharge le Node officiel de la version courante
 * node apps/desktop/scripts/stage.mjs --node /chemin/node  # embarque ce Node-là (celui de actions/setup-node en CI)
 * node apps/desktop/scripts/stage.mjs --skip-build --out /tmp/essai
 * node apps/desktop/scripts/stage.mjs --link-node          # essai sur ce poste : le Node courant est lié, pas embarqué
 * ```
 *
 * `--link-node` sert aux tests (`tests/standalone.ts`) sur un poste dont le
 * Node n'est pas autonome : l'arbre et le lanceur s'éprouvent sans rien
 * télécharger. Le dossier produit **n'est pas distribuable**, et
 * `standalone.json` le dit (`node_linked`).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, symlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Racine du clone : apps/desktop/scripts → trois niveaux plus haut. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WINDOWS = process.platform === 'win32'
const NODE_NAME = WINDOWS ? 'node.exe' : 'node'

/**
 * Lit les options de la ligne de commande.
 *
 * @param {string[]} argv arguments, sans `node` ni le script
 * @returns {{ node: string | null, out: string, skipBuild: boolean, linkNode: boolean }}
 */
function parseArgs(argv) {
  const options = { node: null, out: join(ROOT, 'apps', 'desktop', 'src-tauri', 'runtime'), skipBuild: false, linkNode: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--skip-build') options.skipBuild = true
    else if (arg === '--link-node') options.linkNode = true
    else if (arg === '--node' && argv[i + 1]) options.node = resolve(argv[++i])
    else if (arg === '--out' && argv[i + 1]) options.out = resolve(argv[++i])
    else throw new Error(`option inconnue ou sans valeur : ${arg}`)
  }
  return options
}

/**
 * Lance une commande et rend sa sortie. npm est un `.cmd` sous Windows, que
 * `execFile` ne lance qu'à travers un shell.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptions} [options]
 * @returns {string}
 */
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', shell: WINDOWS && command === 'npm', maxBuffer: 64 * 1024 * 1024, ...options })
}

/**
 * Pourquoi ce Node ne peut pas être embarqué, ou `null` s'il est autonome.
 *
 * Un Node lié à des bibliothèques hors du système ne démarre que sur la
 * machine qui les a. `otool` (macOS) et `ldd` (Linux) le disent ; sans eux, ou
 * sous Windows où `node.exe` est toujours lié statiquement, on ne refuse rien.
 *
 * @param {string} node chemin du binaire
 * @returns {string | null}
 */
export function nodeNotPortable(node) {
  try {
    if (process.platform === 'darwin') {
      const libs = execFileSync('otool', ['-L', node], { encoding: 'utf8' }).split('\n').slice(1).map((l) => l.trim().split(' ')[0]).filter(Boolean)
      const foreign = libs.filter((l) => !l.startsWith('/usr/lib/') && !l.startsWith('/System/'))
      return foreign.length ? `il dépend de bibliothèques hors du système (${foreign.slice(0, 3).join(', ')}…)` : null
    }
    if (process.platform === 'linux') {
      const out = execFileSync('ldd', [node], { encoding: 'utf8' })
      return /libnode\.so/.test(out) ? 'il dépend de libnode.so, qui ne sera pas sur une autre machine' : null
    }
  } catch {
    // Outil absent : on ne sait pas, et on ne refuse pas sans savoir.
  }
  return null
}

/**
 * Télécharge le Node officiel de la version courante, vérifie son SHA-256
 * contre `SHASUMS256.txt`, l'extrait, et rend le chemin du binaire et de sa
 * licence.
 *
 * La somme vient du même serveur que l'archive : elle protège d'un
 * téléchargement tronqué ou corrompu, pas d'un serveur compromis.
 *
 * @returns {Promise<{ node: string, license: string | null }>}
 */
async function downloadNode() {
  const version = process.version
  const os = WINDOWS ? 'win' : process.platform
  const name = `node-${version}-${os}-${process.arch}`
  const archive = `${name}.${WINDOWS ? 'zip' : 'tar.gz'}`
  const base = `https://nodejs.org/dist/${version}`
  console.log(`Node ${version} officiel : ${base}/${archive}`)

  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
  const expected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, file]) => file === archive)?.[0]
  if (!expected) throw new Error(`${archive} absent de SHASUMS256.txt : pas de build officiel pour ${os}-${process.arch} ?`)
  const response = await fetch(`${base}/${archive}`)
  if (!response.ok) throw new Error(`téléchargement refusé : ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new Error(`SHA-256 de ${archive} inattendu : ${actual}, annoncé ${expected}`)

  const work = mkdtempSync(join(tmpdir(), 'midgaard-node-'))
  writeFileSync(join(work, archive), bytes)
  // `tar` lit aussi les zip sous Windows (bsdtar, livré avec le système).
  execFileSync('tar', ['-xf', archive], { cwd: work })
  const extracted = join(work, name)
  return { node: WINDOWS ? join(extracted, NODE_NAME) : join(extracted, 'bin', NODE_NAME), license: join(extracted, 'LICENSE') }
}

/**
 * La licence d'un Node désigné par `--node`, là où ses distributions la
 * rangent ; `null` si elle n'y est pas.
 *
 * @param {string} node chemin du binaire
 * @returns {string | null}
 */
function licenseNear(node) {
  const dir = dirname(node)
  for (const candidate of [join(dir, 'LICENSE'), join(dir, '..', 'LICENSE'), join(dir, '..', 'share', 'doc', 'node', 'LICENSE')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Les paquets de production dont la CLI a besoin, chemins relatifs à la racine
 * (`node_modules/zod`, `node_modules/express/node_modules/content-type`…).
 * La CLI dépend du daemon : sa fermeture est celle de tout le harness, sans le
 * dashboard (dont seul le build est embarqué) ni les tests.
 *
 * @returns {string[]}
 */
function productionPackages() {
  const listed = run('npm', ['ls', '--omit=dev', '--all', '--parseable', '-w', '@midgaard/cli'])
  return listed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && resolve(line) !== ROOT)
    .map((line) => relative(ROOT, line))
}

/**
 * Copie un paquet du workspace : son `package.json`, son `dist/`, et ses
 * données de premier niveau (`pricing.json`). Ni sources, ni tests, ni
 * configuration de compilation.
 *
 * @param {string} from dossier du paquet dans le clone (`packages/<nom>`)
 * @param {string} to   destination (`…/node_modules/@midgaard/<nom>`)
 */
function copyWorkspacePackage(from, to) {
  if (!existsSync(join(from, 'dist'))) throw new Error(`${relative(ROOT, from)} n'est pas compilé : lancer \`npm run build\``)
  mkdirSync(to, { recursive: true })
  cpSync(join(from, 'dist'), join(to, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.tsbuildinfo') })
  for (const entry of readdirSync(from)) {
    if (entry.endsWith('.json') && !entry.startsWith('tsconfig')) cpSync(join(from, entry), join(to, entry))
  }
}

/**
 * Assemble le dossier embarqué.
 *
 * @param {{ node: string | null, out: string, skipBuild: boolean, linkNode: boolean }} options
 * @returns {Promise<void>}
 */
async function stage(options) {
  if (!options.skipBuild) {
    console.log('Compilation des paquets et du dashboard (npm run build)…')
    run('npm', ['run', 'build'], { stdio: 'inherit' })
  }
  const dashboard = join(ROOT, 'apps', 'dashboard', 'dist')
  if (!existsSync(join(dashboard, 'index.html'))) throw new Error('dashboard non compilé : lancer `npm run build`')

  // La garde vient avant tout effacement : on ne supprime que le dossier
  // qu'on produit, et jamais un dossier qui contiendrait le clone.
  const out = options.out
  if (ROOT === out || ROOT.startsWith(out + sep)) throw new Error(`--out ${out} contient le clone : refusé`)
  rmSync(out, { recursive: true, force: true })
  const app = join(out, 'app')
  mkdirSync(join(app, 'bin'), { recursive: true })

  // 1. Le Node embarqué.
  let license = null
  if (options.linkNode) {
    // Essai sur place : un lien vers le Node qui tourne. Jamais un bundle.
    symlinkSync(process.execPath, join(out, NODE_NAME))
  } else {
    let node = options.node
    if (node) {
      const refusal = nodeNotPortable(node)
      if (refusal) throw new Error(`${node} ne peut pas être embarqué : ${refusal}. Relancer sans --node pour prendre le Node officiel.`)
      license = licenseNear(node)
    } else if (nodeNotPortable(process.execPath) === null) {
      // Le Node qui lance ce script, s'il est autonome, est déjà le bon : même
      // version, même plateforme, et rien à télécharger.
      node = process.execPath
      license = licenseNear(node)
    } else {
      const official = await downloadNode()
      node = official.node
      license = official.license
    }
    cpSync(node, join(out, NODE_NAME))
    if (!WINDOWS) chmodSync(join(out, NODE_NAME), 0o755)
    if (license && existsSync(license)) cpSync(license, join(out, 'NODE-LICENSE'))
    else console.warn('⚠ licence de Node introuvable près du binaire : NODE-LICENSE manque au bundle, à joindre avant de distribuer')
  }
  // Le binaire posé doit démarrer d'ici : c'est tout ce que l'application aura.
  const embedded = execFileSync(join(out, NODE_NAME), ['--version'], { encoding: 'utf8' }).trim()

  // 2. Les paquets : ceux du workspace copiés depuis leur build, les autres tels qu'installés.
  let workspace = 0
  let external = 0
  for (const rel of productionPackages()) {
    // Le nom du paquet est ce qui suit le dernier `node_modules/`, y compris
    // en tête de chemin : sans le `^`, `node_modules/@midgaard/cli` gardait son
    // préfixe, n'était pas reconnu, et le paquet partait avec ses sources.
    const name = rel.split(/(?:^|[\\/])node_modules[\\/]/).pop().split(sep).join('/')
    const target = join(app, rel)
    if (name.startsWith('@midgaard/')) {
      copyWorkspacePackage(join(ROOT, 'packages', basename(rel)), target)
      workspace++
    } else {
      // `dereference` : un lien ne survit pas à un bundle. `.bin` n'est pas
      // copié — ce ne sont que des liens vers des scripts que rien ne lance.
      cpSync(join(ROOT, rel), target, { recursive: true, dereference: true, filter: (src) => basename(src) !== '.bin' })
      external++
    }
  }

  // 3. Le dashboard, le lanceur, et ce qui dit ce qu'on a assemblé.
  cpSync(dashboard, join(app, 'dashboard'), { recursive: true })
  for (const file of ['harness', 'harness.cmd']) cpSync(join(ROOT, 'apps', 'desktop', 'launcher', file), join(app, 'bin', file))
  if (!WINDOWS) chmodSync(join(app, 'bin', 'harness'), 0o755)
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  let commit = null
  try {
    commit = run('git', ['rev-parse', 'HEAD']).trim()
  } catch {
    // Hors d'un dépôt Git (archive des sources) : le commit reste inconnu.
  }
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'midgaard-app', private: true, version, type: 'module' }, null, 2) + '\n')
  writeFileSync(join(app, 'standalone.json'), JSON.stringify({ version, node: embedded, node_linked: options.linkNode, platform: process.platform, arch: process.arch, commit }, null, 2) + '\n')

  console.log(`Assemblé dans ${out} : Node ${embedded}${options.linkNode ? ' (lié, non distribuable)' : ''}, ${workspace} paquets du harness, ${external} dépendances, ${size(out)} Mo`)
}

/**
 * Taille d'un dossier, en mégaoctets arrondis.
 *
 * @param {string} dir
 * @returns {number}
 */
function size(dir) {
  let bytes = 0
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) bytes += statSync(join(entry.parentPath, entry.name)).size
  }
  return Math.round(bytes / 1024 / 1024)
}

// Lancé comme script, pas importé (le test importe `nodeNotPortable`).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await stage(parseArgs(process.argv.slice(2)))
  } catch (e) {
    console.error(`stage : ${e.message}`)
    process.exit(1)
  }
}
