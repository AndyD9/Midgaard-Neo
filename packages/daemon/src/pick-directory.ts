/**
 * @file Choisir un dossier dans l'explorateur du système (Finder, Explorateur
 * Windows, sélecteur GTK ou KDE), à la demande du dashboard.
 *
 * Pourquoi le **daemon** ouvre le dialogue, et pas la page :
 *
 *  - une page web ne reçoit jamais le chemin absolu d'un dossier choisi
 *    (`showDirectoryPicker` rend une poignée, pas un chemin), et c'est un
 *    chemin que `POST /api/tasks` attend ;
 *  - la coque desktop n'accorde **aucune capacité Tauri** à la page (invariant
 *    du dépôt) : un dialogue de Tauri en demanderait une ;
 *  - le daemon tourne sur le poste de l'utilisateur, sous son compte : le
 *    dialogue qu'il lance est celui du système, et le même bouton vaut dans un
 *    navigateur comme dans la fenêtre desktop.
 *
 * Ce que le module garantit :
 *
 *  - **rien n'est lu ni listé** : le daemon n'apprend que le chemin que
 *    l'humain a choisi lui-même. Aucune route ne parcourt le disque ;
 *  - **aucun texte du client dans un script** : le dossier de départ voyage en
 *    argument (`argv` d'AppleScript, option de zenity) ou en variable
 *    d'environnement (PowerShell), jamais collé dans le programme ;
 *  - **un dialogue à la fois**, et **aucun dialogue ne survit** : tué quand le
 *    client abandonne et à l'arrêt du daemon, et confié à la garde des
 *    processus (`guardGroup`) pour le cas où le daemon meurt net ;
 *  - **dit quand il ne peut pas** : sans programme de dialogue (Linux sans
 *    zenity ni kdialog, session sans écran), `available()` rend le motif, la
 *    santé du daemon n'annonce pas le sélecteur, et le dashboard ne montre pas
 *    de bouton — ne rien décrire qui n'existe pas.
 *
 * Le chemin choisi n'est **pas** jugé ici : la route le passe par
 * `checkProjectDir`, comme un chemin tapé à la main.
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { guardGroup } from '@midgaard/tools'

/** Ce qu'un dialogue a rendu. */
export type PickOutcome =
  /** Le dossier choisi, tel que le système le nomme ; pas encore vérifié. */
  | { dir: string }
  /** L'humain a fermé le dialogue sans choisir. */
  | { cancelled: true }
  /** Le dialogue n'a pas pu s'ouvrir ; `reason` est lue par l'utilisateur. */
  | { unavailable: string }

/** Le sélecteur de dossier que le routeur emprunte. */
export interface DirectoryPicker {
  /** `null` si un dialogue peut s'ouvrir sur ce poste, sinon pourquoi il ne le peut pas. */
  available(): string | null
  /**
   * Ouvre le dialogue et attend le choix de l'humain — sans délai : c'est lui
   * qui décide quand il a fini.
   *
   * @param startDir dossier où ouvrir le dialogue ; ignoré s'il n'existe pas
   * @param signal   abandon du client ou arrêt du daemon : le dialogue est tué
   */
  pick(startDir: string | null, signal: AbortSignal): Promise<PickOutcome>
}

/** Une commande de dialogue, prête à lancer. */
export interface PickerCommand {
  command: string
  args: string[]
  /** Variables ajoutées à l'environnement du dialogue. */
  env?: Record<string, string>
}

/** Titre du dialogue. En français : c'est l'utilisateur qui le lit. */
const TITLE = 'Midgaard — dossier du projet'

/**
 * Script PowerShell du dialogue Windows. Le dossier de départ arrive par
 * `MIDGAARD_PICK_START`, jamais dans le texte ; la sortie est forcée en UTF-8,
 * sans quoi un nom accentué reviendrait dans la page de codes de la console.
 */
const POWERSHELL_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  `$d.Description = '${TITLE}'`,
  '$d.ShowNewFolderButton = $false',
  'if ($env:MIDGAARD_PICK_START) { $d.SelectedPath = $env:MIDGAARD_PICK_START }',
  // Une fenêtre parente au premier plan : sans elle, le dialogue s'ouvre
  // derrière la fenêtre qui l'a demandé.
  '$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
  'if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) } else { exit 1 }',
].join('; ')

/** Cherche un programme dans les entrées **absolues** du `PATH` donné. */
function findInPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    // Une entrée relative se résoudrait contre le dossier du daemon, que
    // personne ne voit : ignorée, comme pour `exec`.
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, name)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Absent de ce dossier.
    }
  }
  return null
}

/**
 * Compose la commande du dialogue pour une plateforme.
 *
 * Pure, pour être éprouvée sur les trois plateformes depuis une seule : seule
 * la branche de la machine qui teste peut être lancée pour de bon.
 *
 * @param platform `process.platform` du daemon, injecté
 * @param env      environnement du daemon, injecté (jamais lu ici)
 * @param startDir dossier de départ, déjà vérifié existant, ou `null`
 * @returns la commande, ou le motif pour lequel aucun dialogue n'est possible
 */
export function pickerCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  startDir: string | null,
): PickerCommand | { unavailable: string } {
  if (platform === 'darwin') {
    // `tell me to activate` : lancé par un processus d'arrière-plan, le
    // dialogue s'ouvrirait sinon derrière les autres fenêtres.
    const choose = 'choose folder with prompt (item 1 of argv)'
    return {
      command: '/usr/bin/osascript',
      args: [
        '-e', 'on run argv',
        '-e', 'tell me to activate',
        '-e',
        startDir
          ? `return POSIX path of (${choose} default location (POSIX file (item 2 of argv)))`
          : `return POSIX path of (${choose})`,
        '-e', 'end run',
        '--', TITLE, ...(startDir ? [startDir] : []),
      ],
    }
  }
  if (platform === 'win32') {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir
    if (!root) return { unavailable: 'dossier de Windows introuvable (SystemRoot) : PowerShell ne peut pas être désigné' }
    return {
      command: join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      // `-STA` : le dialogue de dossiers exige un fil d'appartement unique.
      args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', POWERSHELL_SCRIPT],
      ...(startDir ? { env: { MIDGAARD_PICK_START: startDir } } : {}),
    }
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { unavailable: 'aucune session graphique (ni DISPLAY ni WAYLAND_DISPLAY) : aucun dialogue ne peut s\'ouvrir' }
  }
  const zenity = findInPath('zenity', env)
  if (zenity) {
    return {
      command: zenity,
      // La barre finale fait ouvrir le dossier lui-même, pas son parent.
      args: ['--file-selection', '--directory', `--title=${TITLE}`, ...(startDir ? [`--filename=${startDir}/`] : [])],
    }
  }
  const kdialog = findInPath('kdialog', env)
  if (kdialog) {
    return { command: kdialog, args: ['--title', TITLE, '--getexistingdirectory', startDir ?? '.'] }
  }
  return { unavailable: 'aucun programme de dialogue trouvé : installe zenity ou kdialog, ou saisis le chemin' }
}

/** Ce qu'il faut pour construire le sélecteur du système. */
export interface SystemPickerOptions {
  platform: NodeJS.Platform
  /** Environnement du daemon : le dialogue en hérite (écran, session, langue). */
  env: NodeJS.ProcessEnv
  log?: ((message: string) => void) | undefined
  /** Compose la commande ; {@link pickerCommand} par défaut. Les tests passent la leur. */
  command?: typeof pickerCommand | undefined
}

/**
 * Le sélecteur de dossier du système.
 *
 * Le dialogue est lancé dans son propre groupe de processus et confié à la
 * garde : un `SIGKILL` du daemon ne laisse pas une fenêtre orpheline à
 * l'écran. Sa sortie est le chemin choisi ; une sortie en échec sans chemin
 * est une annulation — c'est ainsi que les quatre programmes la disent.
 */
export function systemDirectoryPicker(options: SystemPickerOptions): DirectoryPicker {
  const build = options.command ?? pickerCommand
  return {
    available() {
      const command = build(options.platform, options.env, null)
      if ('unavailable' in command) return command.unavailable
      return existsSync(command.command) ? null : `programme de dialogue introuvable : ${command.command}`
    },

    pick(startDir, signal) {
      const start = startDir && isAbsolute(startDir) && isDirectory(startDir) ? startDir : null
      const command = build(options.platform, options.env, start)
      if ('unavailable' in command) return Promise.resolve(command)
      if (signal.aborted) return Promise.resolve({ cancelled: true })

      return new Promise<PickOutcome>((resolve) => {
        const child = spawn(command.command, command.args, {
          env: { ...options.env, ...command.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          // Chef de son groupe : c'est le groupe que la garde et l'abandon tuent.
          detached: options.platform !== 'win32',
          windowsHide: true,
        })
        const release = child.pid !== undefined ? guardGroup(child.pid, options.log) : () => {}
        const out: Buffer[] = []
        const err: Buffer[] = []
        child.stdout.on('data', (c: Buffer) => out.push(c))
        child.stderr.on('data', (c: Buffer) => err.push(c))

        const kill = () => {
          try {
            if (options.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
            else child.kill()
          } catch {
            // Déjà fermé.
          }
        }
        signal.addEventListener('abort', kill, { once: true })

        let settled = false
        const finish = (outcome: PickOutcome) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', kill)
          release()
          resolve(outcome)
        }
        child.on('error', (e) => finish({ unavailable: `le dialogue n'a pas pu s'ouvrir : ${e.message}` }))
        child.on('close', (code) => {
          // Un seul chemin, sur une ligne : les programmes ajoutent un saut de ligne.
          const dir = Buffer.concat(out).toString('utf8').replace(/[\r\n]+$/, '')
          if (code === 0 && dir) return finish({ dir })
          if (signal.aborted) return finish({ cancelled: true })
          const said = Buffer.concat(err).toString('utf8').trim()
          // Les annulations connues : osascript (-128), zenity et kdialog
          // (code 1, rien sur stderr), PowerShell (`exit 1`).
          if (code === 1 && (!said || /-128|cancel/i.test(said))) return finish({ cancelled: true })
          finish({
            unavailable: `le dialogue s'est fermé en erreur (code ${code ?? 'inconnu'})${said ? ` : ${said.split('\n')[0]}` : ''}`,
          })
        })
      })
    },
  }
}

/** Vrai si le chemin est un dossier existant. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
