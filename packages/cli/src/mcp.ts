/**
 * @file Commande `harness mcp` (Slice 8, étape 2) : déclarer un serveur MCP,
 * le tester, lire son catalogue, cocher ou décocher ses outils, le retirer.
 *
 * Comme `harness providers`, tout passe par l'API du daemon : c'est lui qui
 * tient le coffre, et c'est lui qui lance le serveur pour le tester.
 *
 * Deux règles de la CLI viennent d'ailleurs :
 *
 *  - **une valeur secrète ne figure jamais sur la ligne de commande** : elle
 *    est saisie sans écho (`--secret-env NOM`), comme une clé de fournisseur.
 *    Un argument reste dans l'historique du shell ;
 *  - **cocher un outil s'annonce et se confirme**, comme `exec allow` : c'est
 *    une autorisation durable, et la racine du projet ne la borne pas — REA
 *    lit un binaire n'importe où (docs/SLICE8.md, décision 8).
 *
 * Le programme est **résolu ici**, par le `PATH` du terminal de l'humain, puis
 * envoyé absolu : le daemon ne résout jamais rien par son propre `PATH`, qui
 * n'est pas celui du terminal, et pourrait changer d'ici le prochain lancement.
 * Pour la même raison, un argument qui désigne un fichier **relatif au dossier
 * courant** est rendu absolu : le serveur tourne ailleurs (dossier runtime au
 * test, projet de la tâche ensuite), et `node ./rea.mjs` n'y trouverait rien —
 * constaté au premier essai de la CLI.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { daemonJson, type Agent, type HarnessConfig, type McpCatalogEntry, type McpServerView } from '@midgaard/contracts'
import { ensureDaemon } from './daemon-client.ts'
import { readSecret } from './secret-input.ts'
import { bold, cmd, dim, green, red, yellow } from './ui.ts'
import { confirm } from './workspaces.ts'

/** Journalisation discrète du démarrage de daemon : la CLI a sa propre sortie. */
const quiet = () => {}

/** Ce que décrit `mcp add`, avant tout appel au daemon. */
export interface McpAddArgs {
  id: string
  name?: string | undefined
  env: Record<string, string>
  secretEnv: string[]
  /** Le programme et ses arguments, tels que tapés : le programme n'est pas encore résolu. */
  argv: string[]
}

/**
 * Lit les arguments de `mcp add`. Les options viennent **avant** `--` ; tout
 * ce qui suit est le programme du serveur et ses arguments, tels quels — sans
 * cette règle, un `--json` destiné au serveur serait pris pour une option.
 *
 * @param args `<id> [--name N] [--env K=V]… [--secret-env K]… -- <programme> [arguments…]`
 * @returns les arguments lus, ou la raison du refus
 */
export function parseMcpAddArgs(args: string[]): McpAddArgs | { error: string } {
  const [id, ...rest] = args
  if (!id || id.startsWith('-')) return { error: 'il manque l\'identifiant du serveur' }
  const out: McpAddArgs = { id, env: {}, secretEnv: [], argv: [] }
  let i = 0
  for (; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--') {
      i++
      break
    }
    if (a === '--name') out.name = rest[++i]
    else if (a === '--env') {
      const pair = rest[++i] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) return { error: `--env attend NOM=valeur, reçu « ${pair} »` }
      out.env[pair.slice(0, eq)] = pair.slice(eq + 1)
    } else if (a === '--secret-env') {
      const name = rest[++i]
      if (!name) return { error: '--secret-env attend un nom de variable' }
      out.secretEnv.push(name)
    } else return { error: `option inconnue « ${a} » : le programme du serveur se place après --` }
  }
  out.argv = rest.slice(i)
  if (out.argv.length === 0) return { error: 'il manque le programme du serveur, après --' }
  return out
}

/**
 * Résout un programme comme le ferait le terminal, et rend son chemin absolu.
 *
 * Les entrées **relatives** du `PATH` sont ignorées, comme pour `exec` : `.`
 * dans le `PATH` ferait prendre un fichier du dossier courant pour le programme.
 *
 * @param program nom ou chemin tapé par l'humain
 * @param env     environnement du terminal (`PATH`, `PATHEXT`)
 * @returns le chemin absolu, ou `null` s'il n'est pas trouvé
 */
export function resolveProgram(program: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  const runnable = (path: string) => {
    try {
      if (!statSync(path).isFile()) return false
      accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (isAbsolute(program)) return runnable(program) ? program : null
  // Un chemin relatif avec séparateur (`./bin/serveur`) se lit depuis le dossier courant.
  if (program.includes('/') || program.includes('\\')) {
    const full = join(process.cwd(), program)
    return runnable(full) ? full : null
  }
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.COM').split(';').filter(Boolean)] : ['']
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    for (const ext of exts) {
      const candidate = join(dir, program + ext)
      if (runnable(candidate)) return candidate
    }
  }
  return null
}

/**
 * Rend absolus les arguments qui désignent un fichier ou un dossier existant
 * **relatif au dossier courant**. Seuls ceux qui ont l'air d'un chemin — un
 * séparateur, ou un `.` en tête — sont regardés : `mcp`, un mot, reste un mot
 * même si un fichier du même nom traîne dans le dossier courant.
 *
 * @param args arguments du serveur, tels que tapés
 * @param cwd  dossier courant du terminal
 * @returns les arguments, et ceux qui ont été rendus absolus
 */
export function absolutizeArgs(args: readonly string[], cwd: string): { args: string[]; changed: [string, string][] } {
  const changed: [string, string][] = []
  const out = args.map((a) => {
    const looksLikePath = a.startsWith('.') || a.includes('/') || a.includes('\\')
    if (!looksLikePath || isAbsolute(a) || a.startsWith('-')) return a
    const full = resolve(cwd, a)
    if (!existsSync(full)) return a
    changed.push([a, full])
    return full
  })
  return { args: out, changed }
}

/**
 * Les outils que `mcp allow --read-only` propose de cocher : ceux que le
 * serveur annonce en lecture seule et non destructifs, pas encore libres.
 *
 * Ce n'est qu'une **proposition** : les annotations sont des indications du
 * serveur, jamais une autorisation (décision 5). L'humain voit la liste et
 * confirme.
 */
export function readOnlyCandidates(tools: readonly McpCatalogEntry[]): McpCatalogEntry[] {
  return tools.filter(
    (t) => t.status !== 'allowed' && t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true,
  )
}

/** Répartit les sous-commandes de `harness mcp`. */
export async function mcp(config: HarnessConfig, args: string[]): Promise<number> {
  const [sub = 'list', ...rest] = args
  switch (sub) {
    case 'list':
      return list(config)
    case 'add':
    case 'set':
      return add(config, rest)
    case 'test':
      return test(config, rest[0])
    case 'tools':
      return tools(config, rest[0])
    case 'allow':
      return allow(config, rest)
    case 'revoke':
      return revoke(config, rest)
    case 'remove':
    case 'rm':
      return remove(config, rest[0])
    case 'attach':
      return attach(config, rest[0], rest[1], true)
    case 'detach':
      return attach(config, rest[0], rest[1], false)
    default:
      console.error(`Sous-commande inconnue : mcp ${sub}`)
      console.error('Attendu : list, add, test, tools, allow, revoke, remove, attach, detach')
      return 1
  }
}

/** Ce que le daemon rend en cas de refus. */
type Refused = { error?: string; reason?: string }

function refused(status: number, body: Refused): number {
  console.error(`${red('✘')} ${body.error ?? status}${body.reason ? ` — ${body.reason}` : ''}`)
  return 1
}

/** Badge du dernier test. */
function testBadge(s: McpServerView): string {
  if (!s.last_test) return dim('jamais testé')
  return s.last_test.ok ? green('répond') : red('ne répond pas')
}

async function list(config: HarnessConfig): Promise<number> {
  const rt = await ensureDaemon(config, quiet)
  const { body } = await daemonJson<{ servers: McpServerView[] }>(rt, '/api/mcp')
  if (body.servers.length === 0) {
    console.log('Aucun serveur MCP déclaré.')
    console.log()
    console.log('Pour en déclarer un :')
    console.log(dim(`  ${cmd('mcp add rea -- node /chemin/vers/rea/scripts/rea.mjs mcp')}`))
    return 0
  }
  for (const s of body.servers) {
    const allowed = s.tools.filter((t) => t.status === 'allowed').length
    const changed = s.tools.filter((t) => t.status === 'changed').length
    console.log(`${bold(s.id.padEnd(14))} ${testBadge(s)}  ${dim(`${s.tools.length} outil(s), ${allowed} libre(s)`)}${changed ? `  ${yellow(`${changed} changé(s)`)}` : ''}`)
    console.log(`  ${dim([s.command, ...s.args].join(' '))}`)
    if (s.secret_env.length) console.log(`  ${dim(`secrètes au coffre : ${s.secret_env.join(', ')}`)}`)
    if (s.last_test) console.log(`  ${dim(`${s.last_test.detail} (${s.last_test.at.slice(0, 19).replace('T', ' ')})`)}`)
  }
  return 0
}

async function add(config: HarnessConfig, args: string[]): Promise<number> {
  const parsed = parseMcpAddArgs(args)
  if ('error' in parsed) {
    console.error(`${red('✘')} ${parsed.error}`)
    console.error('Usage : mcp add <id> [--name N] [--env NOM=valeur]… [--secret-env NOM]… -- <programme> [arguments…]')
    return 1
  }
  const [program, ...programArgs] = parsed.argv as [string, ...string[]]
  const command = resolveProgram(program, process.env)
  if (!command) {
    console.error(`${red('✘')} programme introuvable ou non exécutable : ${program}`)
    return 1
  }
  if (command !== program) console.log(dim(`programme résolu : ${command}`))
  const absolute = absolutizeArgs(programArgs, process.cwd())
  for (const [from, to] of absolute.changed) console.log(dim(`argument rendu absolu : ${from} → ${to}`))
  if (Object.keys(parsed.env).length) {
    console.log(`${yellow('!')} les variables --env sont gardées ${bold('en clair')} en base ; un jeton va dans --secret-env.`)
  }

  const secrets: Record<string, string> = {}
  if (parsed.secretEnv.length > 1 && !process.stdin.isTTY) {
    console.error(`${red('✘')} plusieurs variables secrètes demandent un terminal : sur un tube, une seule valeur peut être lue.`)
    return 1
  }
  for (const name of parsed.secretEnv) {
    const value = await readSecret(`Valeur de ${name} (sans écho)`)
    if (!value) {
      console.error(`Aucune valeur saisie pour ${name} ; rien n'a été modifié.`)
      return 1
    }
    secrets[name] = value
  }

  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<{ server?: McpServerView } & Refused>(rt, '/api/mcp', {
    method: 'POST',
    body: JSON.stringify({
      id: parsed.id,
      ...(parsed.name ? { name: parsed.name } : {}),
      command,
      args: absolute.args,
      env: parsed.env,
      secret_env: parsed.secretEnv,
      secrets,
    }),
  })
  if (status !== 200 || !body.server) return refused(status, body)
  console.log(`${green('✔')} serveur MCP ${bold(parsed.id)} déclaré`)
  console.log()
  // On teste dans la foulée : un serveur déclaré qui ne répond pas ne se
  // découvrirait sinon qu'à la première tâche, loin de sa cause.
  return test(config, parsed.id)
}

async function test(config: HarnessConfig, id: string | undefined): Promise<number> {
  if (!id) {
    console.error('Usage : mcp test <id>')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  process.stdout.write(`Test de ${bold(id)} (lance le serveur, lit son catalogue)… `)
  const { status, body } = await daemonJson<{ server?: McpServerView } & Refused>(
    rt,
    `/api/mcp/${encodeURIComponent(id)}/test`,
    { method: 'POST' },
  )
  if (status !== 200 || !body.server?.last_test) {
    console.log(red('échec'))
    return refused(status, body)
  }
  const s = body.server
  const t = s.last_test!
  console.log(t.ok ? green('répond') : red('ne répond pas'))
  console.log(`  ${t.detail}${t.latency_ms !== null ? dim(` · ${t.latency_ms} ms`) : ''}`)
  if (!t.ok) return 1
  const changed = s.tools.filter((x) => x.status === 'changed')
  if (changed.length) {
    console.log(`  ${yellow('!')} ${changed.length} outil(s) coché(s) annoncé(s) autrement qu'au moment de les cocher, approuvés de nouveau à chaque appel :`)
    console.log(`    ${changed.map((x) => x.name).join(', ')}`)
  }
  if (s.missing.length) console.log(`  ${dim(`cochés mais plus annoncés : ${s.missing.map((m) => m.name).join(', ')}`)}`)
  console.log()
  console.log(dim(`Catalogue : ${cmd(`mcp tools ${id}`)} · cocher les outils de lecture : ${cmd(`mcp allow ${id} --read-only`)}`))
  return 0
}

/** Une ligne d'annotations, telles que le serveur les annonce. */
function hints(t: McpCatalogEntry): string {
  const a = t.annotations ?? {}
  const out: string[] = []
  if (a.readOnlyHint === true) out.push('lecture seule')
  if (a.destructiveHint === true) out.push('destructif')
  if (a.openWorldHint === true) out.push('monde ouvert')
  return out.length ? `[${out.join(', ')}] ` : ''
}

async function tools(config: HarnessConfig, id: string | undefined): Promise<number> {
  if (!id) {
    console.error('Usage : mcp tools <id>')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<{ server?: McpServerView } & Refused>(rt, `/api/mcp/${encodeURIComponent(id)}`)
  if (status !== 200 || !body.server) return refused(status, body)
  const s = body.server
  if (!s.catalog_at) {
    console.log(`Aucun catalogue : ${cmd(`mcp test ${id}`)} lance le serveur et le lit.`)
    return 1
  }
  console.log(`${bold(id)} ${dim(`— catalogue du ${s.catalog_at.slice(0, 19).replace('T', ' ')}, ${s.tools.length} outil(s)`)}`)
  for (const t of s.tools) {
    const status = t.status === 'allowed' ? green('libre   ') : t.status === 'changed' ? yellow('changé  ') : dim('approuvé')
    const description = t.description.replace(/\s+/g, ' ').slice(0, 110)
    console.log(`  ${status} ${bold(t.name)} ${dim(hints(t) + description)}`)
  }
  if (s.missing.length) console.log(`  ${dim(`cochés mais plus annoncés : ${s.missing.map((m) => m.name).join(', ')}`)}`)
  console.log()
  console.log(dim('« approuvé » : chaque appel attend un humain. Les annotations sont celles du serveur, pas une garantie.'))
  return 0
}

async function allow(config: HarnessConfig, args: string[]): Promise<number> {
  const yes = args.includes('--yes') || args.includes('-y')
  const readOnly = args.includes('--read-only')
  const [id, ...names] = args.filter((a) => !a.startsWith('-'))
  if (!id || (!readOnly && names.length === 0)) {
    console.error('Usage : mcp allow <id> [--yes] (--read-only | <outil>…)')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<{ server?: McpServerView } & Refused>(rt, `/api/mcp/${encodeURIComponent(id)}`)
  if (status !== 200 || !body.server) return refused(status, body)
  const chosen = readOnly ? [...readOnlyCandidates(body.server.tools).map((t) => t.name), ...names] : names
  if (chosen.length === 0) {
    console.log('Aucun outil à cocher : le serveur n\'en annonce pas d\'autre en lecture seule et non destructif.')
    return 0
  }
  console.log(`${yellow('!')} Ces outils de ${bold(id)} seront appelés ${bold('sans approbation')} par les agents qui ont ce serveur :`)
  console.log(`    ${chosen.join(', ')}`)
  console.log('  Leur empreinte (nom, description, schéma, annotations) est enregistrée : si le serveur les annonce')
  console.log('  autrement plus tard, ils redemanderont une approbation à chaque appel.')
  console.log(
    '  Un outil MCP n\'est pas borné au projet : il lit et écrit là où le serveur le permet. Les annotations ' +
      '« lecture seule » sont celles du serveur, pas une garantie.',
  )
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error(`${red('✘')} pas de terminal pour confirmer : relance avec --yes, en connaissance de cause.`)
      return 1
    }
    if (!(await confirm('Cocher ? (o/N) '))) {
      console.log('Rien n\'a été coché.')
      return 1
    }
  }
  const done = await daemonJson<{ server?: McpServerView } & Refused>(rt, `/api/mcp/${encodeURIComponent(id)}/allow`, {
    method: 'POST',
    body: JSON.stringify({ tools: chosen, by: 'cli' }),
  })
  if (done.status !== 200 || !done.body.server) return refused(done.status, done.body)
  console.log(`${green('✔')} ${chosen.length} outil(s) libre(s) ${dim('— vaut pour les tâches qui démarrent à partir de maintenant')}`)
  return 0
}

async function revoke(config: HarnessConfig, args: string[]): Promise<number> {
  const [id, ...names] = args
  if (!id || names.length === 0) {
    console.error('Usage : mcp revoke <id> <outil>…')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<{ server?: McpServerView } & Refused>(rt, `/api/mcp/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ tools: names, by: 'cli' }),
  })
  if (status !== 200 || !body.server) return refused(status, body)
  console.log(`${green('✔')} ${names.join(', ')} : chaque appel attendra de nouveau un humain`)
  return 0
}

async function remove(config: HarnessConfig, id: string | undefined): Promise<number> {
  if (!id) {
    console.error('Usage : mcp remove <id>')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<{ detached?: string[] } & Refused>(rt, `/api/mcp/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (status !== 200) return refused(status, body)
  console.log(`${green('✔')} serveur MCP ${bold(id)} retiré, avec ses outils cochés et ses variables secrètes`)
  if (body.detached?.length) console.log(`  ${dim(`retiré aussi des profils : ${body.detached.join(', ')}`)}`)
  return 0
}

/**
 * Donne un serveur à un profil, ou le lui retire : ses agents en reçoivent
 * les outils à partir de la tâche suivante. La route prend la liste complète ;
 * la CLI la relit et n'y change que ce serveur-là.
 */
async function attach(config: HarnessConfig, server: string | undefined, agentId: string | undefined, on: boolean): Promise<number> {
  if (!server || !agentId) {
    console.error(`Usage : mcp ${on ? 'attach' : 'detach'} <serveur> <profil>`)
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const current = await daemonJson<{ agent?: Agent } & Refused>(rt, `/api/agents/${encodeURIComponent(agentId)}`)
  if (current.status !== 200 || !current.body.agent) return refused(current.status, current.body)
  const before = current.body.agent.mcp_servers
  if (on === before.includes(server)) {
    console.log(`${bold(agentId)} ${on ? 'a déjà' : 'n\'a pas'} le serveur ${bold(server)} : rien n'a changé.`)
    return 0
  }
  const servers = on ? [...before, server] : before.filter((s) => s !== server)
  const { status, body } = await daemonJson<{ agent?: Agent } & Refused>(rt, `/api/agents/${encodeURIComponent(agentId)}/mcp`, {
    method: 'PUT',
    body: JSON.stringify({ servers }),
  })
  if (status !== 200 || !body.agent) return refused(status, body)
  console.log(
    on
      ? `${green('✔')} les agents ${bold(agentId)} reçoivent les outils de ${bold(server)} ${dim('— à partir de la tâche suivante')}`
      : `${green('✔')} ${bold(server)} retiré du profil ${bold(agentId)}`,
  )
  if (on) console.log(dim(`Outils libres ou approuvés : ${cmd(`mcp tools ${server}`)}`))
  return 0
}

