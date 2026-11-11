/**
 * @file L'arbre embarqué de l'application autonome, assemblé puis **lancé**
 * (`npm run test:standalone`, hors de `npm test`).
 *
 * `apps/desktop/scripts/stage.mjs` assemble ce que le bundle contient : un
 * Node, le harness compilé, ses dépendances, le dashboard, le lanceur. Cette
 * suite l'assemble dans un dossier jetable et s'en sert comme le fera
 * l'application : par le lanceur, **depuis un dossier qui n'est pas le clone**.
 *
 *  - S1 l'arbre ne contient que ce qu'il doit : aucune source TypeScript du
 *    harness, aucun lien (un lien ne survit pas à un bundle), les données
 *    lues hors de `dist/` (`pricing.json`), le dashboard ;
 *  - S2 le lanceur démarre un daemon **de l'arbre**, pas du clone : son
 *    installation (`/api/health`) est sous l'arbre, et il sert le dashboard
 *    embarqué ;
 *  - S3 une commande conseillée passe par le lanceur, jamais par npm — au
 *    dashboard (`harness_command`) comme dans la CLI —, et redit `--home` ;
 *  - S4 aucun processus ne reste après `stop` : compté en interrogeant le pid.
 *
 * **Ce que cette suite ne prouve pas, selon le poste.** Si le Node qui la
 * lance n'est pas autonome (Homebrew, paquet d'une distribution), l'arbre est
 * assemblé avec `--link-node` : le Node « embarqué » est un lien vers celui
 * du poste. L'arbre et le lanceur sont éprouvés ; la **portabilité du Node
 * embarqué ne l'est pas**, et le résumé le dit (verdict `CONSTAT`). En CI, le
 * Node de `actions/setup-node` est l'officiel : il est copié, et S1 vérifie
 * alors qu'aucun lien ne reste.
 *
 * Il lui faut `npm run build` au préalable ; elle ne compile pas elle-même,
 * pour ne pas réécrire `dist/` sous une autre suite.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pidAlive, readRuntime, type Health } from '@midgaard/contracts'
import { scenario, summarize, type Outcome } from './helpers.ts'
// Le script d'assemblage est du JavaScript hors des projets TypeScript.
// @ts-expect-error module sans déclaration de types
import { nodeNotPortable } from '../apps/desktop/scripts/stage.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const STAGE = join(ROOT, 'apps', 'desktop', 'scripts', 'stage.mjs')
const WINDOWS = process.platform === 'win32'

if (!existsSync(join(ROOT, 'apps', 'dashboard', 'dist', 'index.html')) || !existsSync(join(ROOT, 'packages', 'cli', 'dist', 'main.js'))) {
  console.error('test:standalone a besoin du build :\n\n  npm run build\n')
  process.exit(1)
}

// `.native` : sous Windows, `tmpdir()` rend un nom court que le daemon développe.
const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-standalone-')))
const out = join(work, 'runtime')
const home = join(work, 'home')
/** Un dossier de travail qui n'est ni le clone ni l'arbre : là d'où un utilisateur tape une commande. */
const elsewhere = join(work, 'ailleurs')
const launcher = join(out, 'app', 'bin', WINDOWS ? 'harness.cmd' : 'harness')
const outcomes: Outcome[] = []

/** Pourquoi le Node du poste n'est pas embarquable, ou `null`. */
const notPortable = nodeNotPortable(process.execPath) as string | null

/**
 * Lance le lanceur embarqué, depuis `elsewhere`, sans rien hériter qui
 * désignerait le clone ou un autre runtime.
 */
function harness(...args: string[]): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, MIDGAARD_PORT: '0', MIDGAARD_VAULT: 'file' }
  delete env.MIDGAARD_HOME
  delete env.MIDGAARD_LAUNCHER
  delete env.MIDGAARD_DASHBOARD_DIR
  delete env.NODE_OPTIONS
  // Un `.cmd` ne se lance qu'à travers un shell.
  // …et à travers un shell, un chemin qui porte une espace se cite.
  const r = spawnSync(WINDOWS ? `"${launcher}"` : launcher, ['--home', home, ...args], { cwd: elsewhere, env, encoding: 'utf8', shell: WINDOWS })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Tous les fichiers et dossiers sous `dir`, en chemins absolus. */
function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) => join(e.parentPath, e.name))
}

try {
  execFileSync(process.execPath, [STAGE, '--skip-build', '--out', out, ...(notPortable ? ['--link-node'] : [])], { cwd: ROOT, stdio: 'inherit' })
  mkdirSync(elsewhere)

  await scenario(outcomes, 'S1 l’arbre embarqué ne contient que ce qu’il doit', async () => {
    const all = walk(out)
    const sources = all.filter((p) => p.includes(`${sep}@midgaard${sep}`) && /\.ts$/.test(p) && !/\.d\.ts$/.test(p))
    if (sources.length) return { verdict: 'FAIL', detail: `source embarquée : ${sources[0]}` }
    const nodeName = WINDOWS ? 'node.exe' : 'node'
    const links = all.filter((p) => lstatSync(p).isSymbolicLink() && !(notPortable && p === join(out, nodeName)))
    if (links.length) return { verdict: 'FAIL', detail: `lien dans l’arbre : ${links[0]}` }
    for (const needed of [
      join('app', 'node_modules', '@midgaard', 'providers', 'pricing.json'),
      join('app', 'node_modules', '@midgaard', 'daemon', 'dist', 'main.js'),
      join('app', 'node_modules', 'playwright', 'cli.js'),
      join('app', 'dashboard', 'index.html'),
      join('app', 'bin', 'harness'),
      join('app', 'bin', 'harness.cmd'),
    ]) {
      if (!existsSync(join(out, needed))) return { verdict: 'FAIL', detail: `absent de l’arbre : ${needed}` }
    }
    const meta = JSON.parse(readFileSync(join(out, 'app', 'standalone.json'), 'utf8')) as { node: string; node_linked: boolean }
    if (meta.node !== process.version) return { verdict: 'FAIL', detail: `Node annoncé ${meta.node}, ${process.version} attendu` }
    if (meta.node_linked !== (notPortable !== null)) return { verdict: 'FAIL', detail: 'standalone.json ne dit pas vrai sur le Node lié' }
    return { verdict: 'PASS', detail: `${all.length} entrées, aucune source du harness, aucun lien, données et dashboard présents` }
  })

  let health: Health | null = null
  let daemonPid = 0
  await scenario(outcomes, 'S2 le lanceur démarre un daemon de l’arbre, qui sert le dashboard embarqué', async () => {
    const started = harness('start')
    if (started.status !== 0) return { verdict: 'FAIL', detail: `start a échoué : ${started.out.trim().slice(0, 300)}` }
    const rt = readRuntime(join(home, 'daemon.json'))
    if (!rt) return { verdict: 'FAIL', detail: 'pas de fichier de découverte dans le runtime désigné' }
    daemonPid = rt.pid
    const res = await fetch(`http://127.0.0.1:${rt.port}/api/health`, { headers: { authorization: `Bearer ${rt.token}` } })
    health = (await res.json()) as Health
    // L'installation est celle de l'arbre : un daemon du clone aurait
    // `packages/daemon` pour dossier.
    const expected = realpathSync.native(join(out, 'app', 'node_modules', '@midgaard', 'daemon'))
    if (health.install.dir !== expected) return { verdict: 'FAIL', detail: `daemon d’une autre installation : ${health.install.dir}` }
    if (!health.dashboard_available) return { verdict: 'FAIL', detail: 'le dashboard embarqué n’est pas servi' }
    const page = await (await fetch(rt.dashboard_url!, { headers: { 'sec-fetch-site': 'none' } })).text()
    const bundled = readFileSync(join(out, 'app', 'dashboard', 'index.html'), 'utf8')
    if (page !== bundled) return { verdict: 'FAIL', detail: 'la page servie n’est pas l’index.html embarqué' }
    return { verdict: 'PASS', detail: `pid ${rt.pid}, installation sous l’arbre, index.html embarqué servi` }
  })

  await scenario(outcomes, 'S3 une commande conseillée passe par le lanceur, jamais par npm', async () => {
    if (!health) return { verdict: 'FAIL', detail: 'S2 n’a pas démarré de daemon' }
    const prefix = health.harness_command ?? ''
    const quoted = `"${realpathSync.native(launcher)}"`
    if (!prefix.startsWith(quoted)) return { verdict: 'FAIL', detail: `le daemon conseille : ${prefix}` }
    if (!prefix.includes(`--home "${home}"`)) return { verdict: 'FAIL', detail: `--home absent du conseil du daemon : ${prefix}` }
    // La CLI, elle : `agents` conseille `providers add` tant qu'aucun fournisseur n'existe.
    const advice = harness('agents').out.split('\n').find((l) => l.includes('providers add')) ?? ''
    if (!advice.trim().startsWith(quoted)) return { verdict: 'FAIL', detail: `la CLI conseille : ${advice.trim() || '(rien)'}` }
    if (/\bnpm\b/.test(prefix) || /\bnpm\b/.test(advice)) return { verdict: 'FAIL', detail: 'npm conseillé là où il n’y a pas de clone' }
    // Et la commande conseillée se lance telle quelle : c'est une affirmation à prouver.
    const status = harness('status')
    if (status.status !== 0 || !status.out.includes(String(daemonPid))) return { verdict: 'FAIL', detail: `status par le lanceur : ${status.out.trim().slice(0, 200)}` }
    return { verdict: 'PASS', detail: 'daemon et CLI conseillent le lanceur avec --home ; relancé tel quel, il répond' }
  })

  await scenario(outcomes, 'S4 aucun processus ne reste après stop', async () => {
    if (!daemonPid) return { verdict: 'FAIL', detail: 'S2 n’a pas démarré de daemon' }
    const stopped = harness('stop')
    if (stopped.status !== 0) return { verdict: 'FAIL', detail: `stop a échoué : ${stopped.out.trim().slice(0, 200)}` }
    for (let i = 0; i < 50 && pidAlive(daemonPid); i++) await new Promise((r) => setTimeout(r, 100))
    if (pidAlive(daemonPid)) return { verdict: 'FAIL', detail: `le daemon ${daemonPid} vit encore` }
    return { verdict: 'PASS', detail: `daemon ${daemonPid} arrêté, pid interrogé au système` }
  })

  // Un test qui ne prouve pas tout doit le dire, jamais ressembler à un succès entier.
  outcomes.push(
    notPortable
      ? { name: 'S5 le Node embarqué est autonome', verdict: 'CONSTAT', detail: `NON ÉPROUVÉ ici — le Node de ce poste n’est pas embarquable (${notPortable}) : arbre assemblé avec un lien` }
      : { name: 'S5 le Node embarqué est autonome', verdict: 'PASS', detail: 'copié dans l’arbre, et c’est lui qui a lancé le daemon' },
  )
} finally {
  // Si un scénario a échoué en route, le daemon peut encore tourner.
  if (existsSync(join(home, 'daemon.json'))) harness('stop')
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

process.exit(summarize(outcomes, 'Résumé — application autonome (arbre embarqué)'))
