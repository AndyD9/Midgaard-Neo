/**
 * @file Les commandes de la CLI `harness`.
 *
 * Chacune rend un code de sortie : `0` si ce qui était demandé a eu lieu, `1`
 * sinon. C'est ce qui permet de les enchaîner dans un script sans relire leur
 * sortie.
 *
 * Toutes les commandes qui parlent au daemon passent par `ensureDaemon`, qui le
 * démarre s'il dort — sauf `status` et `doctor`, qui doivent pouvoir constater
 * son absence sans la provoquer.
 */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import {
  daemonJson,
  execPrefixRefusal,
  formatExecRule,
  readRuntime,
  pidAlive,
  PROTOCOL_VERSION,
  type Approval,
  type ExecAllowRule,
  type HarnessConfig,
  type Health,
  type Task,
  type TaskView,
} from '@midgaard/contracts'
import { HarnessStore, SCHEMA_VERSION } from '@midgaard/persistence'
import { StaticFiles, defaultDashboardDir, installation, sameInstallation, type Installation } from '@midgaard/daemon'
import { loadPricing, packagedPricingPath, userPricingPath } from '@midgaard/providers'
import { openVault, VAULT_ENV } from '@midgaard/secrets'
import { ensureDaemon } from './daemon-client.ts'
import { inspectRepository } from '@midgaard/workspace'
import { bold, buildAdvice, cmd, colorStatus, dim, green, humanDuration, mark, red, yellow } from './ui.ts'
import { cargoVersion, DESKTOP_BUILD, desktopBinary } from './desktop.ts'

/** Version minimale de Node : `node:sqlite` sans drapeau expérimental. */
const MIN_NODE = [24, 0] as const

/** Journalisation du démarrage de daemon, discrète : la CLI a sa propre sortie. */
const quiet = () => {}

/** Récupère l'état de santé du daemon s'il tourne, sans le démarrer. */
async function probeHealth(config: HarnessConfig): Promise<Health | null> {
  const rt = readRuntime(config.runtimeFile)
  if (!rt) return null
  try {
    const { status, body } = await daemonJson<Health>(rt, '/api/health', { signal: AbortSignal.timeout(1500) })
    return status === 200 ? body : null
  } catch {
    return null
  }
}

// --- start / stop ----------------------------------------------------------

/** Démarre le daemon s'il ne tourne pas, puis affiche où le joindre. */
export async function start(config: HarnessConfig): Promise<number> {
  const rt = await ensureDaemon(config, quiet)
  const { body } = await daemonJson<Health>(rt, '/api/health')
  console.log(`${green('✔')} daemon en marche (pid ${body.pid}, protocole ${body.protocol})`)
  console.log(`  API       : http://127.0.0.1:${body.port}/api`)
  console.log(
    `  dashboard : ${body.dashboard_available ? body.dashboard_url : dim(`${body.dashboard_url}  (non compilé — ${buildAdvice})`)}`,
  )
  console.log(`  base      : ${body.db_path}`)
  const fallback = portFallbackNote(config, body.port)
  if (fallback) console.log(`  ${yellow('!')} ${fallback}`)
  return 0
}

/**
 * Dit pourquoi le dashboard n'est pas sur le port attendu, ou `null` s'il y est.
 *
 * Le daemon se rabat en silence sur un port libre quand 7777 est pris ; le
 * cas le plus courant est un daemon d'une **autre installation**, qui a son
 * propre dashboard sur 7777. À l'essai de la Slice 4 (étape 8, leçon n° 33),
 * l'auteur y a cherché une approbation qui était sur l'autre port : la page
 * était vide, et rien ne disait pourquoi. Le jeton de l'autre daemon n'étant
 * pas lisible d'ici, on ne prétend pas savoir ce qui tient le port.
 *
 * @param config configuration de cette installation
 * @param port   port où ce daemon écoute réellement
 */
export function portFallbackNote(config: Pick<HarnessConfig, 'port' | 'portIsExplicit'>, port: number): string | null {
  if (config.portIsExplicit || port === config.port) return null
  return (
    `port ${config.port} occupé — sans doute le daemon d'une autre installation, dont le dashboard ` +
    `n'est pas celui-ci : ce daemon écoute sur ${port}`
  )
}

/** Arrête le daemon. Ne le démarre pas pour l'arrêter. */
export async function stop(config: HarnessConfig): Promise<number> {
  const rt = readRuntime(config.runtimeFile)
  if (!rt) {
    console.log('Aucun daemon enregistré : rien à arrêter.')
    return 0
  }
  try {
    await daemonJson(rt, '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(2000) })
    console.log(`${green('✔')} daemon arrêté (pid ${rt.pid})`)
    return 0
  } catch {
    // Le fichier de découverte survit à un `SIGKILL` : distinguer les deux cas.
    const stale = !pidAlive(rt.pid)
    console.log(stale ? 'Le daemon enregistré est mort ; rien à arrêter.' : red('Daemon injoignable.'))
    return stale ? 0 : 1
  }
}

// --- status ----------------------------------------------------------------

/** Affiche l'état du daemon et les tâches récentes. Lit la base même si le daemon dort. */
export async function status(config: HarnessConfig, limit: number): Promise<number> {
  const health = await probeHealth(config)
  if (health) {
    console.log(
      `${green('●')} daemon en marche — pid ${health.pid}, ${humanDuration(health.uptime_s * 1000)} de service, ` +
        `protocole ${health.protocol}`,
    )
    console.log(`  dashboard : ${health.dashboard_available ? health.dashboard_url : dim('non compilé')}`)
    const fallback = portFallbackNote(config, health.port)
    if (fallback) console.log(`  ${yellow('!')} ${fallback}`)
    if (health.idle_shutdown_in_ms !== null) {
      console.log(`  inactivité : arrêt dans ${humanDuration(health.idle_shutdown_in_ms)} si rien ne se passe`)
    }
  } else {
    console.log(`${dim('○')} daemon arrêté — l'historique ci-dessous est lu directement dans la base.`)
  }

  if (!existsSync(config.dbPath)) {
    console.log(dim(`\nAucune base à ${config.dbPath} : aucune tâche n'a encore été déléguée.`))
    return 0
  }

  // Lecture directe, et seule : en WAL, elle ne gêne pas le daemon s'il écrit
  // au même moment, et `status` constate sans rien changer — pas même le schéma.
  const store = HarnessStore.openReadOnly(config)
  try {
    if (store.schemaVersion !== SCHEMA_VERSION) {
      const c = schemaCheck(store.schemaVersion, null)
      console.log(`\n${mark[c.level]()} base illisible par ce code : ${c.detail}`)
      if (c.fix) console.log(`  ${dim('→ ' + c.fix)}`)
      return 1
    }
    const tasks = store.listTasks({ limit })
    const pending = store.pendingApprovals()
    if (pending.length) {
      console.log(`\n${yellow(bold(`${pending.length} approbation(s) en attente`))}`)
      for (const a of pending) console.log(`  ${a.id}  ${a.operation}`)
      console.log(dim(`  ${cmd(`approve ${pending[0]!.id}`)}`))
    }
    console.log(`\n${bold('Tâches')} (${tasks.length} sur ${store.countTasks().total})`)
    if (!tasks.length) console.log(dim('  aucune'))
    for (const t of tasks) console.log(`  ${formatTaskLine(t)}`)
    return 0
  } finally {
    store.close()
  }
}

/** Une ligne de tableau par tâche : identifiant court, statut, progression, objectif. */
function formatTaskLine(t: Task): string {
  const id = t.id.slice(0, 8)
  const progress = `${t.step}/${t.steps_total}`
  const when = new Date(t.created_at).toLocaleString()
  return `${dim(id)}  ${colorStatus(t.status.padEnd(16))} ${progress.padEnd(5)} ${dim(when)}  ${t.objective}`
}

// --- approve / reject ------------------------------------------------------

/**
 * Approuve ou refuse une demande.
 *
 * Sans identifiant, n'agit que s'il n'y a **qu'une** demande en attente : en cas
 * d'ambiguïté, c'est à l'humain de choisir, et la commande affiche une ligne
 * complète par demande, prête à copier.
 */
export async function decide(
  config: HarnessConfig,
  decision: 'approve' | 'reject',
  approvalId: string | undefined,
  reason: string | undefined,
): Promise<number> {
  const rt = readRuntime(config.runtimeFile)
  if (!rt || !(await probeHealth(config))) {
    console.error(red('Aucun daemon actif : rien n\'attend d\'approbation pour l\'instant.'))
    return 1
  }

  let id = approvalId
  if (!id) {
    const { body } = await daemonJson<{ approvals: Approval[] }>(rt, '/api/approvals')
    const pending = body.approvals
    if (pending.length === 0) {
      console.error('Aucune demande d\'approbation en attente.')
      return 1
    }
    if (pending.length > 1) {
      console.error('Plusieurs demandes attendent, précise laquelle :')
      for (const a of pending) console.error(`  harness ${decision} ${a.id}   # ${a.operation}`)
      return 1
    }
    id = pending[0]!.id
  }

  const outcome = await daemonJson<TaskView & { error?: string }>(rt, `/api/approvals/${id}/${decision}`, {
    method: 'POST',
    body: JSON.stringify({ by: 'cli', reason }),
  }).catch((e: Error) => ({ status: 0, body: { error: e.message } as TaskView & { error?: string } }))

  if (outcome.status !== 200) {
    console.error(red(`Refusé (${outcome.status || 'injoignable'}) : ${outcome.body.error ?? 'erreur inconnue'}`))
    return 1
  }
  const body = outcome.body
  const verb = decision === 'approve' ? 'Approuvé' : 'Refusé'
  console.log(`${green('✔')} ${verb} — tâche ${body.task.id.slice(0, 8)} : ${colorStatus(body.task.status)}`)
  return 0
}

// --- doctor ----------------------------------------------------------------

/** Un contrôle de `doctor` : son verdict, ce qu'il dit, et quoi faire si ça cloche. */
export interface Check {
  level: 'ok' | 'warn' | 'fail'
  label: string
  detail: string
  fix?: string
}

/**
 * Diagnostic de l'installation.
 *
 * Vérifie ce qui, en Slice 0, a réellement cassé : version de Node, dossier
 * runtime et ses permissions, schéma de la base, verrou périmé, version de
 * protocole du daemon en marche.
 *
 * @param projectDir dossier diagnostiqué ; il ne sert plus qu'à retrouver le
 *                   dépôt dont on affiche la liste blanche `exec`
 * @returns `0` si aucun contrôle n'échoue (les avertissements ne font pas échouer)
 */
export async function doctor(config: HarnessConfig, projectDir: string): Promise<number> {
  const checks: Check[] = []

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
  checks.push({
    level: nodeOk ? 'ok' : 'fail',
    label: 'Node',
    detail: `v${process.versions.node} (minimum v${MIN_NODE[0]}.${MIN_NODE[1]})`,
    ...(nodeOk ? {} : { fix: 'Mets Node à jour : node:sqlite exige Node 24 sans drapeau expérimental.' }),
  })

  // Dossier runtime : il contient le jeton du daemon, il doit rester privé.
  if (existsSync(config.home)) {
    const mode = statSync(config.home).mode & 0o777
    checks.push({
      level: mode === 0o700 ? 'ok' : 'warn',
      label: 'Dossier runtime',
      detail: `${config.home} (mode ${mode.toString(8)})`,
      ...(mode === 0o700 ? {} : { fix: `chmod 700 ${config.home}  # il contient le jeton du daemon` }),
    })
  } else {
    checks.push({ level: 'ok', label: 'Dossier runtime', detail: `${config.home} (sera créé au démarrage)` })
  }

  // La base s'ouvre en lecture seule : un diagnostic qui la migrerait
  // changerait ce qu'il rapporte (docs/SLICE3.md, leçon n° 17). Elle ne sert aux
  // contrôles suivants que si son schéma est celui de ce code ; sinon leurs
  // requêtes viseraient des tables ou des colonnes absentes.
  let store: HarnessStore | null = null
  if (existsSync(config.dbPath)) {
    try {
      const opened = HarnessStore.openReadOnly(config)
      const version = opened.schemaVersion
      if (version === SCHEMA_VERSION) store = opened
      else opened.close()
      checks.push(schemaCheck(version, store ? store.countTasks() : null))
    } catch (e) {
      checks.push({ level: 'fail', label: 'Base', detail: (e as Error).message })
    }
  } else {
    checks.push({ level: 'ok', label: 'Base', detail: 'pas encore créée' })
  }

  const rt = readRuntime(config.runtimeFile)
  const health = await probeHealth(config)
  if (health) {
    checks.push(daemonCheck(health, installation()))
  } else if (rt) {
    // Fichier de découverte sans daemon derrière : reste d'un arrêt brutal.
    const orphan = pidAlive(rt.pid)
    checks.push({
      level: 'warn',
      label: 'Daemon',
      detail: orphan ? `pid ${rt.pid} vivant mais injoignable` : `fichier de découverte périmé (pid ${rt.pid} mort)`,
      fix: orphan ? `kill ${rt.pid}` : 'Rien à faire : le prochain démarrage le remplacera.',
    })
  } else {
    checks.push({ level: 'ok', label: 'Daemon', detail: 'arrêté' })
  }

  // On regarde le disque, et non `health.dashboard_available` : celui-ci n'existe
  // que si le daemon tourne, et `doctor` doit pouvoir répondre daemon arrêté.
  // Annoncer « non compilé » faute d'avoir pu vérifier serait exactement le genre
  // d'affirmation fausse que ce diagnostic est censé attraper.
  const dashboard = new StaticFiles(config.dashboardDir ?? defaultDashboardDir())
  checks.push({
    level: dashboard.available ? 'ok' : 'warn',
    label: 'Dashboard',
    detail: dashboard.available
      ? health?.dashboard_available
        ? `compilé, servi sur ${health.dashboard_url}`
        : 'compilé (servi dès que le daemon démarre)'
      : 'non compilé',
    ...(dashboard.available ? {} : { fix: `${buildAdvice}   # sinon les approbations passent par la CLI` }),
  })

  // La coque desktop est facultative (Slice 6) : ni Rust ni son binaire ne sont
  // exigés, le dashboard s'ouvre aussi dans un navigateur. Le contrôle dit où
  // elle en est, sans jamais faire échouer le diagnostic.
  const shell = existsSync(desktopBinary())
  const cargo = shell ? null : cargoVersion()
  checks.push({
    level: 'ok',
    label: 'Coque desktop',
    detail: shell
      ? `construite — ${cmd('desktop')}`
      : cargo
        ? `facultative, non construite (${cargo}) — ${DESKTOP_BUILD}`
        : 'facultative, non construite : Rust (cargo) absent ; le dashboard s\'ouvre dans un navigateur',
  })

  // Coffre : on **mesure** lequel répond sur cette machine, plutôt que de le
  // déduire de la plateforme. Et on dit sans détour quand il ne protège rien.
  try {
    const vault = await openVault(config, process.env)
    checks.push({
      level: vault.osBacked ? 'ok' : 'warn',
      label: 'Coffre',
      detail: vault.label,
      ...(vault.osBacked ? {} : { fix: vaultAdvice(process.platform, process.env) }),
    })
  } catch (e) {
    checks.push({ level: 'fail', label: 'Coffre', detail: (e as Error).message })
  }

  // Tarifs : un tarif périmé qu'on croit courant est pire qu'un tarif absent,
  // d'où l'affichage de la date et l'avertissement au-delà de 90 jours.
  const pricing = loadPricing(config)
  const models = Object.keys(pricing.entries).length
  const ageDays = Math.floor((Date.now() - Date.parse(pricing.updated_at)) / 86_400_000)
  const stale = models === 0 || ageDays > 90
  checks.push({
    level: stale ? 'warn' : 'ok',
    label: 'Tarifs',
    detail:
      models === 0
        ? 'aucun tarif connu : les coûts seront affichés « inconnus », jamais zéro'
        : `${models} modèle(s), relevés il y a ${ageDays} jour(s)`,
    ...(stale
      ? {
          fix:
            `${cmd('pricing refresh venice')}   # relève les tarifs chez le fournisseur\n` +
            `  ${dim(`ou édite ${userPricingPath(config)} (copie livrée : ${relative(process.cwd(), packagedPricingPath())})`)}`,
        }
      : {}),
  })

  // Fournisseurs : lus en base, sans démarrer le daemon.
  if (store) {
    try {
      const declared = store.listProviders()
      const tested = declared.filter((p) => p.last_test?.ok).length
      checks.push({
        level: declared.length === 0 ? 'warn' : tested === declared.length ? 'ok' : 'warn',
        label: 'Fournisseurs',
        detail:
          declared.length === 0
            ? 'aucun : seul le profil « simulated » peut tourner'
            : `${declared.length} déclaré(s), ${tested} joignable(s) au dernier test`,
        ...(declared.length === 0
          ? { fix: cmd('providers add venice --model deepseek-v4-flash-0731') }
          : tested === declared.length
            ? {}
            : { fix: cmd('providers test <identifiant>') }),
      })
    } catch {
      // La base a déjà été signalée plus haut ; inutile de le redire.
    }
  }

  // Git : le Developer ne travaille que dans un worktree. Sans Git, il échoue
  // à chaque tâche ; le Researcher, lui, s'en passe — d'où un avertissement,
  // pas un échec.
  checks.push(gitCheck(await gitVersionOutput()))

  // Worktrees et liste blanche : lus en base, sans démarrer le daemon.
  if (store) {
    try {
      const all = store.listWorkspaces()
      let projectRepo: string | null = null
      try {
        projectRepo = (await inspectRepository(projectDir)).toplevel
      } catch {}
      const projectAllow = projectRepo ? store.listExecAllow(projectRepo) : []

      const kept = all.filter((w) => w.status === 'kept').length
      const active = all.filter((w) => w.status === 'active').length
      checks.push({
        level: 'ok',
        label: 'Worktrees',
        detail: all.length
          ? `${active} en cours, ${kept} conservé(s), ${all.length - kept - active} retiré(s) — sous ${config.worktreesDir}`
          : 'aucun pour l\'instant',
        // Conservés jusqu'au nettoyage, par décision : on rappelle comment, sans presser.
        ...(kept > 0 ? { fix: `${cmd('workspaces')}   # puis « workspaces clean » quand ils sont lus` } : {}),
      })
      checks.push(execAllowCheck(config.execAllow, projectAllow, projectRepo))
    } catch {
      // La base a déjà été signalée plus haut ; inutile de le redire.
    }
  }

  store?.close()

  for (const c of checks) {
    console.log(`${mark[c.level]()} ${bold(c.label.padEnd(18))} ${c.detail}`)
    if (c.fix) console.log(`  ${dim('→ ' + c.fix)}`)
  }
  const failed = checks.filter((c) => c.level === 'fail').length
  console.log()
  console.log(failed ? red(`${failed} contrôle(s) en échec.`) : green('Installation saine.'))
  return failed ? 1 : 0
}

/**
 * Verdict de `doctor` sur la base, d'après sa version de schéma.
 *
 * Une base **plus ancienne** que ce code n'est pas une panne : le daemon de
 * cette version la migrera à son démarrage. `doctor` le dit, sans le faire.
 * Une base **plus récente** en est une : ce code refuserait de l'ouvrir.
 *
 * @param version version de schéma lue en lecture seule
 * @param counts  tâches de la base, lues seulement quand le schéma est le bon
 * @returns le contrôle « Base »
 */
export function schemaCheck(version: number, counts: { total: number; active: number } | null): Check {
  if (version === SCHEMA_VERSION) {
    return {
      level: 'ok',
      label: 'Base',
      detail: `schéma v${version}${counts ? `, ${counts.total} tâche(s), ${counts.active} active(s)` : ''}`,
    }
  }
  if (version < SCHEMA_VERSION) {
    return {
      level: 'warn',
      label: 'Base',
      detail: `schéma v${version}, ce code attend v${SCHEMA_VERSION} : à migrer (rien n'a été écrit)`,
      fix: `${cmd('start')}   # le daemon de cette version migre la base à son démarrage`,
    }
  }
  return {
    level: 'fail',
    label: 'Base',
    detail: `schéma v${version}, plus récent que ce code (v${SCHEMA_VERSION})`,
    fix: 'Mets Midgaard à jour, ou désigne une autre base avec MIDGAARD_HOME.',
  }
}

/**
 * Verdict de `doctor` sur un daemon en marche : son protocole, puis son
 * installation (voir `@midgaard/daemon/installation`).
 *
 * @param health ce que le daemon annonce
 * @param mine   l'installation de ce code-ci
 */
export function daemonCheck(health: Health, mine: Installation): Check {
  const detail = `en marche, pid ${health.pid}, protocole ${health.protocol}`
  if (health.protocol !== PROTOCOL_VERSION) {
    return {
      level: 'warn',
      label: 'Daemon',
      detail: `${detail} (ce code : ${PROTOCOL_VERSION})`,
      fix: `Un daemon d'une autre version tourne ; ${cmd('start')} le remplacera.`,
    }
  }
  // Un daemon de protocole 8 n'annonçait pas son installation ; le protocole
  // différait alors, et le cas est traité plus haut.
  if (!sameInstallation(health.install, mine)) {
    return {
      level: 'warn',
      label: 'Daemon',
      detail: `${detail}, d'une autre installation : ${health.install.dir} v${health.install.version} (ce code : ${mine.dir} v${mine.version})`,
      fix:
        'La prochaine commande de cette installation qui s\'adresse au daemon le remplacera s\'il n\'a aucune tâche active ; ' +
        `sinon il sert tel quel jusqu'à ce qu'il le soit. ${cmd('stop')} l'arrête tout de suite.`,
    }
  }
  return { level: 'ok', label: 'Daemon', detail: `${detail}, v${mine.version}` }
}

/** Version minimale de Git : `git worktree remove` date de la 2.17. */
export const MIN_GIT: readonly [number, number] = [2, 17]

/** Sortie de `git --version`, ou `null` si Git est introuvable ou muet. */
function gitVersionOutput(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout) =>
      resolve(error ? null : String(stdout).trim()),
    )
  })
}

/**
 * Contrôle de Git, à partir de la sortie de `git --version`.
 *
 * @param output par exemple `git version 2.54.0 (Apple Git-157)` ; `null` si
 *               Git est absent
 */
export function gitCheck(output: string | null): Check {
  const fix = 'Installe Git (2.17 ou plus) : le profil developer travaille dans un worktree Git.'
  if (!output) return { level: 'warn', label: 'Git', detail: 'introuvable : le profil developer ne peut pas travailler', fix }
  const m = /git version (\d+)\.(\d+)/.exec(output)
  if (!m) return { level: 'warn', label: 'Git', detail: `version illisible : ${output}`, fix }
  const [major, minor] = [Number(m[1]), Number(m[2])]
  const ok = major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1])
  return ok
    ? { level: 'ok', label: 'Git', detail: output }
    : { level: 'warn', label: 'Git', detail: `${output} — trop ancien pour retirer un worktree`, fix }
}

/**
 * Contrôle de la liste blanche `exec`. Vide, tout va bien : chaque commande
 * attend un humain. Non vide, c'est un **avertissement** — non une erreur —
 * qui rappelle ce que la variable ne dit pas : une commande qui exécute le
 * code du projet exécute ce que l'agent a écrit.
 *
 * @param global      liste de `MIDGAARD_EXEC_ALLOW`
 * @param project     liste du dépôt diagnostiqué, préfixes compris (Slice 9)
 * @param projectRepo racine de ce dépôt ; `null` hors dépôt Git
 */
export function execAllowCheck(
  global: string[][],
  project: readonly ExecAllowRule[],
  projectRepo: string | null,
): Check {
  const all = [
    ...global.map((a) => `${a.join(' ')} (tous dépôts)`),
    // Un préfixe que le moteur écarterait se dit tel : `doctor` ne doit pas
    // le montrer comme une autorisation active.
    ...project.map((r) => (r.prefix && execPrefixRefusal(r.argv) ? `${formatExecRule(r)} (préfixe écarté)` : formatExecRule(r))),
  ]
  if (all.length === 0) {
    return {
      level: 'ok',
      label: 'Exec',
      detail: `chaque commande attend une approbation${projectRepo ? '' : ' (dossier hors dépôt Git)'}`,
    }
  }
  return {
    level: 'warn',
    label: 'Exec',
    detail: `sans approbation : ${all.join(' ; ')}`,
    fix:
      'Si l\'une exécute le code du projet (tests, scripts, build), elle exécute ce que l\'agent a écrit ; ' +
      'un préfixe (…) accepte en plus tout argument que l\'agent choisit. ' +
      `${cmd('exec revoke <commande…>')} pour la retirer.`,
  }
}

/**
 * Ce qu'il faut faire quand le coffre retenu ne protège rien.
 *
 * Le conseil **dépend de la plateforme parce que la cause en dépend**. Sous
 * Linux il manque un paquet, et on peut l'installer. Sous macOS et Windows le
 * magasin est livré avec le système : son silence ne se corrige pas en
 * installant quoi que ce soit, il signale autre chose — un environnement
 * restreint, un `PATH` amputé. Un conseil unique — « installe libsecret » —
 * envoyait donc dans le mur partout ailleurs que sous Linux. C'est la dette
 * n° 5 de la Slice 2, et c'est la même famille que les défauts de l'essai en
 * vraie session : un message qui ne mène pas à une manette atteignable.
 *
 * Le repli **demandé** passe en premier : quand {@link VAULT_ENV} vaut `file`,
 * rien ne manque, et proposer un paquet enverrait chercher ce qu'on a soi-même
 * écarté. C'est le cas de toutes les suites de tests du dépôt.
 *
 * Les branches suivent `openVault` plutôt que la liste des plateformes : tout
 * ce qui n'est ni macOS ni Windows tente `secret-tool`, et reçoit donc le
 * conseil de `secret-tool`.
 *
 * @param platform `process.platform` de la machine qui diagnostique
 * @param env      environnement, pour repérer un coffre forcé
 * @returns le texte affiché sous le contrôle « Coffre », prêt à lire
 *
 * @example
 * vaultAdvice('linux', {})         // → « … Installe libsecret (« secret-tool ») … »
 * vaultAdvice('darwin', {})        // → « … vérifie que « security default-keychain » nomme un trousseau … »
 */
export function vaultAdvice(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  // La première phrase ne dépend de rien : elle dit ce qui est vrai dans tous
  // les cas, y compris celui du repli choisi exprès.
  const exposed = 'Les clés seront en clair sur le disque, et une sauvegarde de ce dossier les emportera. '

  if (env[VAULT_ENV]?.trim() === 'file') {
    return `${exposed}Ce repli est demandé par ${VAULT_ENV}=file : retire la variable pour reprendre le coffre système.`
  }
  if (platform === 'darwin') {
    return (
      `${exposed}Le trousseau est pourtant livré avec macOS : vérifie que « security default-keychain » ` +
      `nomme un trousseau. Un HOME qui n'est pas celui de ta session n'en a pas, et un environnement ` +
      `restreint peut refuser « security ».`
    )
  }
  if (platform === 'win32') {
    return (
      `${exposed}DPAPI passe par « powershell.exe » — Windows PowerShell 5.1, livré avec le système : ` +
      `vérifie qu'il est dans le PATH. « pwsh » seul ne suffit pas.`
    )
  }
  return (
    `${exposed}Installe libsecret (« secret-tool ») et ouvre une session de bureau. ` +
    `Sur un serveur sans trousseau de session, il n'y a rien à installer : ce repli est la bonne réponse, ` +
    `et c'est pour cela qu'il existe.`
  )
}
