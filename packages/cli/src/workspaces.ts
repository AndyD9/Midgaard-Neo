/**
 * @file Commandes `harness workspaces` et `harness exec`.
 *
 * Toutes passent par l'API du daemon, comme `providers` : c'est lui qui écrit,
 * par son bus, et un retrait de worktree doit s'inscrire dans le journal de sa
 * tâche comme toute autre transition.
 *
 * Deux règles de la Slice 3 s'y appliquent, et la CLI ne les contourne pas :
 *
 *  - **rien n'est supprimé d'office.** `clean` retire les worktrees **propres**
 *    des tâches finies ; un worktree avec du travail non commité n'est retiré
 *    qu'avec `--force`, un orphelin n'est que montré, et la branche reste
 *    toujours ;
 *  - **une commande en liste blanche n'est plus approuvée par personne.**
 *    `exec allow` le dit avant d'ajouter, et demande confirmation — ou
 *    `--yes`, en connaissance de cause, hors terminal.
 *
 * Un **préfixe** (`exec allow --prefix`, Slice 9) est jugé ici par
 * `execPrefixRefusal` **avant** l'avertissement : on ne demande pas à
 * l'humain de confirmer ce que le daemon refusera. Le daemon le rejuge.
 */
import { createInterface } from 'node:readline'
import {
  daemonJson,
  execPrefixRefusal,
  formatExecRule,
  type ExecAllowResponse,
  type HarnessConfig,
  type Workspace,
  type WorkspaceListing,
  type WorkspacesResponse,
} from '@midgaard/contracts'
import { ensureDaemon } from './daemon-client.ts'
import { bold, dim, green, red, yellow } from './ui.ts'

/** Journalisation discrète du démarrage de daemon : la CLI a sa propre sortie. */
const quiet = () => {}

// --- workspaces ---------------------------------------------------------------

/** Répartit les sous-commandes de `harness workspaces`. */
export async function workspaces(config: HarnessConfig, args: string[]): Promise<number> {
  const [sub = 'list', ...rest] = args
  const force = rest.includes('--force')
  switch (sub) {
    case 'list':
      return listWorkspaces(config)
    case 'remove':
    case 'rm':
      return removeOne(config, rest.find((a) => !a.startsWith('--')), force)
    case 'clean':
      return clean(config, force)
    default:
      console.error(`Sous-commande inconnue : workspaces ${sub}`)
      console.error('Attendu : list, remove <branche|id> [--force], clean [--force]')
      return 1
  }
}

async function fetchAll(config: HarnessConfig): Promise<WorkspacesResponse> {
  const rt = await ensureDaemon(config, quiet)
  return (await daemonJson<WorkspacesResponse>(rt, '/api/workspaces')).body
}

/** État d'un worktree en quelques mots : c'est ce qui décide s'il peut partir. */
function stateLabel(l: WorkspaceListing): string {
  if (l.workspace.status === 'removed') return dim('retiré')
  if (!l.exists) return yellow('dossier absent')
  if (l.dirty === null) return yellow('illisible')
  return l.dirty === 0 ? green('propre') : yellow(`${l.dirty} non commité(s)`)
}

/** Liste les worktrees, du plus récent au plus ancien, puis les orphelins. */
async function listWorkspaces(config: HarnessConfig): Promise<number> {
  const body = await fetchAll(config)
  const live = body.workspaces.filter((l) => l.workspace.status !== 'removed')
  console.log(`${bold('Worktrees')} ${dim(`(sous ${body.worktrees_dir})`)}`)
  if (live.length === 0) console.log(`  ${dim('aucun')}`)
  for (const l of live) {
    const w = l.workspace
    console.log(
      `  ${bold(w.branch)}  ${w.status}  tâche ${l.task_status ?? '?'}  ${stateLabel(l)}  ${dim(w.id.slice(0, 8))}`,
    )
    console.log(`    ${dim(`${w.worktree_path}`)}`)
    console.log(
      `    ${dim(`dépôt ${w.repo_dir}, depuis ${w.base_commit.slice(0, 12)}${w.base_ref ? ` (${w.base_ref})` : ''}`)}`,
    )
  }
  const removed = body.workspaces.length - live.length
  if (removed > 0) console.log(dim(`  … et ${removed} retiré(s), dont la branche reste dans son dépôt`))

  if (body.orphans.length) {
    console.log()
    console.log(`${yellow('!')} ${bold('Dossiers orphelins')} — aucune tâche ne les référence (reste d'un arrêt brutal ?) :`)
    for (const o of body.orphans) console.log(`  ${o}`)
    console.log(dim('  Rien ne dit à qui ils sont : ils ne sont jamais retirés d\'office. Depuis le dépôt concerné :'))
    console.log(dim('  git worktree remove <chemin>'))
  }
  return 0
}

/**
 * Retrouve un worktree par branche, ou par préfixe de son identifiant ou de
 * celui de sa tâche. Ambigu : on refuse en listant, plutôt que de deviner.
 */
function pick(all: WorkspaceListing[], ref: string): Workspace | string {
  const live = all.map((l) => l.workspace).filter((w) => w.status !== 'removed')
  const found = live.filter((w) => w.branch === ref || w.id.startsWith(ref) || w.task_id.startsWith(ref))
  if (found.length === 1) return found[0]!
  if (found.length === 0) return `aucun worktree actif ne correspond à « ${ref} » (harness workspaces pour la liste)`
  return `« ${ref} » est ambigu : ${found.map((w) => w.branch).join(', ')}`
}

async function removeOne(config: HarnessConfig, ref: string | undefined, force: boolean): Promise<number> {
  if (!ref) {
    console.error('Usage : workspaces remove <branche|id> [--force]')
    return 1
  }
  const target = pick((await fetchAll(config)).workspaces, ref)
  if (typeof target === 'string') {
    console.error(`${red('✘')} ${target}`)
    return 1
  }
  return (await removeVia(config, target, force)) ? 0 : 1
}

/** Demande le retrait au daemon, et dit ce qui s'est passé. @returns vrai si retiré */
async function removeVia(config: HarnessConfig, w: Workspace, force: boolean): Promise<boolean> {
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<{ outcome?: string; error?: string; reason?: string }>(
    rt,
    `/api/workspaces/${w.id}/remove`,
    { method: 'POST', body: JSON.stringify({ force, by: 'cli' }) },
  )
  if (status !== 200) {
    console.log(`  ${red('✘')} ${w.branch} : ${body.reason ?? body.error ?? status}`)
    return false
  }
  const how = body.outcome === 'already_gone' ? 'dossier déjà absent, métadonnées nettoyées' : 'retiré'
  console.log(`  ${green('✔')} ${w.branch} : ${how} ${dim('— la branche reste')}`)
  return true
}

/**
 * Retire les worktrees des tâches finies. Sans `--force`, ceux qui portent du
 * travail non commité sont laissés, et la commande dit lesquels et pourquoi.
 */
async function clean(config: HarnessConfig, force: boolean): Promise<number> {
  const body = await fetchAll(config)
  const done = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'budget_exceeded', 'interrupted'])
  const candidates = body.workspaces.filter((l) => l.workspace.status !== 'removed')
  if (candidates.length === 0) {
    console.log(dim('Aucun worktree à retirer.'))
    return 0
  }
  let removed = 0
  let kept = 0
  for (const l of candidates) {
    if (!l.task_status || !done.has(l.task_status)) {
      console.log(`  ${dim('·')} ${l.workspace.branch} : tâche ${l.task_status ?? 'inconnue'}, laissé`)
      kept++
      continue
    }
    if (!force && l.dirty !== null && l.dirty > 0) {
      console.log(
        `  ${yellow('!')} ${l.workspace.branch} : ${l.dirty} chemin(s) non commité(s), que la branche ne contient pas — ` +
          `laissé ${dim('(--force pour le perdre)')}`,
      )
      kept++
      continue
    }
    if (await removeVia(config, l.workspace, force)) removed++
    else kept++
  }
  console.log()
  console.log(`${removed} retiré(s), ${kept} laissé(s). ${dim('Les branches restent ; git branch -D pour les supprimer.')}`)
  return 0
}

// --- exec ----------------------------------------------------------------------

/** Répartit les sous-commandes de `harness exec`. */
export async function exec(config: HarnessConfig, args: string[]): Promise<number> {
  const [sub = 'list', ...rest] = args
  const { yes, dir, argv, prefix } = parseExecArgs(rest)
  switch (sub) {
    case 'list':
      return listAllow(config, dir)
    case 'allow':
      return allow(config, dir, argv, yes, prefix)
    case 'revoke':
      return revoke(config, dir, argv)
    default:
      console.error(`Sous-commande inconnue : exec ${sub}`)
      console.error(
        'Attendu : list, allow [--yes] [--prefix] [--dir D] [--] <commande…>, revoke [--dir D] [--] <commande…>',
      )
      return 1
  }
}

/**
 * Sépare les options de la commande. Les options viennent **avant** : tout ce
 * qui suit le premier mot qui n'en est pas une — ou `--` — est l'argv, tel
 * quel. Sans cette règle, `npx tsc --noEmit` perdrait son `--noEmit`.
 */
export function parseExecArgs(args: string[]): { yes: boolean; dir: string; argv: string[]; prefix: boolean } {
  let yes = false
  let prefix = false
  let dir = process.cwd()
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]!
    if (a === '--yes' || a === '-y') yes = true
    else if (a === '--prefix') prefix = true
    else if (a === '--dir') dir = args[++i] ?? dir
    else if (a === '--') {
      i++
      break
    } else break
  }
  return { yes, dir, argv: args.slice(i), prefix }
}

async function listAllow(config: HarnessConfig, dir: string): Promise<number> {
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<ExecAllowResponse & { reason?: string }>(
    rt,
    `/api/exec-allow?project_dir=${encodeURIComponent(dir)}`,
  )
  if (status !== 200) {
    console.error(`${red('✘')} ${body.reason ?? status}`)
    return 1
  }
  console.log(`${bold('exec sans approbation')} ${dim(`— dépôt ${body.repo_dir}`)}`)
  if (body.entries.length === 0) console.log(`  ${dim('aucune commande : chacune attend un humain')}`)
  for (const e of body.entries) {
    const kind = e.prefix ? 'préfixe, ' : ''
    console.log(`  ${formatExecRule(e)}  ${dim(`${kind}ajoutée le ${e.added_at.slice(0, 10)} par ${e.added_by}`)}`)
    // Le moteur rejuge chaque préfixe au départ d'une tâche : celui que la
    // règle refuse désormais ne vaut plus rien, et la liste doit le dire
    // plutôt que de le montrer comme actif.
    const refusal = e.prefix ? execPrefixRefusal(e.argv) : null
    if (refusal) console.log(`    ${yellow('!')} ${dim(`écarté au départ de chaque tâche : ${refusal}`)}`)
  }
  if (body.global.length) {
    console.log(`${bold('et pour tous les dépôts')} ${dim('(MIDGAARD_EXEC_ALLOW)')}`)
    for (const g of body.global) console.log(`  ${g.join(' ')}`)
  }
  return 0
}

async function allow(config: HarnessConfig, dir: string, argv: string[], yes: boolean, prefix: boolean): Promise<number> {
  if (argv.length === 0) {
    console.error('Usage : exec allow [--yes] [--prefix] [--dir D] [--] <commande> [arguments…]')
    return 1
  }
  const line = argv.join(' ')
  if (prefix) {
    const refusal = execPrefixRefusal(argv)
    if (refusal) {
      console.error(`${red('✘')} préfixe refusé : ${refusal}`)
      return 1
    }
    console.log(
      `${yellow('!')} « ${bold(line)} » ${bold('et tout ce qui le suit')} tournera ${bold('sans approbation')} ` +
        'dans les worktrees des agents de ce dépôt.',
    )
    console.log(
      `  Les arguments ajoutés après le préfixe, l'agent les choisit et personne ne les lira : c'est le programme ` +
        'qui décide de ce qu\'ils font. Certains font tourner un autre programme ou écrivent un fichier ' +
        '(git -c, tar --to-command, rsync -e, git log --output=) ; la règle écarte les interpréteurs, les shells ' +
        'et les lanceurs connus, pas chacun de ceux-là.',
    )
  } else {
    console.log(`${yellow('!')} « ${bold(line)} » tournera ${bold('sans approbation')} dans les worktrees des agents de ce dépôt.`)
    console.log('  Seul cet argv exact est concerné : un argument de plus, et l\'approbation redevient nécessaire.')
  }
  console.log(
    '  Mais si cette commande exécute le code du projet — tests (pytest lit conftest.py), scripts de package.json, ' +
      'build —, elle exécute ce que l\'agent a écrit dans son worktree : l\'approbation était la seule frontière.',
  )
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error(`${red('✘')} pas de terminal pour confirmer : relance avec --yes, en connaissance de cause.`)
      return 1
    }
    if (!(await confirm('Ajouter ? (o/N) '))) {
      console.log('Rien n\'a été ajouté.')
      return 1
    }
  }
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<ExecAllowResponse & { error?: string; reason?: string }>(rt, '/api/exec-allow', {
    method: 'POST',
    body: JSON.stringify({ project_dir: dir, argv, prefix, by: 'cli' }),
  })
  if (status !== 200) {
    console.error(`${red('✘')} ${body.reason ?? body.error ?? status}`)
    return 1
  }
  const what =
    body.outcome === 'widened'
      ? 'entrée exacte élargie en préfixe'
      : body.outcome === 'unchanged'
        ? prefix
          ? 'déjà là en préfixe, rien n\'a changé'
          : 'déjà là (exacte, ou en préfixe sur ce même argv), rien n\'a changé'
        : 'ajoutée'
  console.log(`${green('✔')} ${what} pour ${body.repo_dir} ${dim('— vaut pour les tâches qui démarrent à partir de maintenant')}`)
  return 0
}

async function revoke(config: HarnessConfig, dir: string, argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.error('Usage : exec revoke [--dir D] [--] <commande> [arguments…]')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<{ error?: string; reason?: string }>(rt, '/api/exec-allow/remove', {
    method: 'POST',
    body: JSON.stringify({ project_dir: dir, argv, by: 'cli' }),
  })
  if (status === 404) {
    console.error(`${red('✘')} « ${argv.join(' ')} » n'est pas dans la liste de ce dépôt`)
    return 1
  }
  if (status !== 200) {
    console.error(`${red('✘')} ${body.reason ?? body.error ?? status}`)
    return 1
  }
  console.log(`${green('✔')} « ${argv.join(' ')} » retirée : elle attendra de nouveau un humain`)
  return 0
}

/** Pose une question oui/non sur le terminal. Tout ce qui n'est pas « o » ou « oui » vaut non. */
export function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(/^(o|oui|y|yes)$/i.test(answer.trim()))
    })
  })
}
