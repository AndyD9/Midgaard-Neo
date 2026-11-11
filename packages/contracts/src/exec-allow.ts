/**
 * @file Liste blanche `exec` : entrées exactes et **préfixes bornés** (Slice 9, étape 3).
 *
 * Une entrée exacte dispense d'approbation un argv, et lui seul (Slice 3). En
 * Python, c'est une approbation par itération : `python -m pytest` ne couvre
 * pas `python -m pytest -k foo`. Un **préfixe** couvre tout argv qui commence
 * par ses mots, comparés un à un et à la lettre.
 *
 * Un préfixe ne se juge pas comme une entrée exacte : il accepte **n'importe
 * quels arguments à la suite**, que l'agent choisit. `python` en préfixe, c'est
 * `python -c "<tout>"` sans regard humain ; `env` ou `npx` en préfixe, c'est
 * n'importe quel programme. Ce module dit donc quels préfixes sont refusés, et
 * pourquoi. Il est dans `contracts` parce que deux acteurs l'appliquent : la
 * CLI, pour refuser **avant** de demander confirmation, et le daemon, qui ne
 * fait confiance à aucun client et rejuge au départ de chaque tâche les
 * préfixes enregistrés — une règle durcie vaut aussi pour les entrées
 * anciennes.
 *
 * Ce que la règle ne prétend pas : connaître chaque programme dont un argument
 * lance un autre programme (`git -c alias.x=!…`, `tar --to-command`,
 * `rsync -e`). Elle écarte les interpréteurs, les shells et les lanceurs
 * connus, et refuse une option juste après le programme ; l'avertissement de
 * la CLI dit le reste à l'humain, qui décide.
 */

/** Une règle de la liste blanche, telle que l'applique l'outil `exec`. */
export interface ExecAllowRule {
  /** Les mots de la commande : l'argv entier, ou son début pour un préfixe. */
  argv: readonly string[]
  /** `true` : couvre tout argv qui commence par `argv`. `false` : cet argv seul. */
  prefix: boolean
}

/**
 * Shells : aucune forme de préfixe n'est bornée, ils exécutent ce qu'on leur
 * passe. `cmd /c` et `pwsh -Command` comme `sh -c`.
 */
export const SHELL_FAMILIES: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'csh', 'tcsh', 'fish', 'nu', 'elvish', 'xonsh', 'busybox',
  'cmd', 'pwsh', 'powershell',
])

/**
 * Interpréteurs sans forme « module » qu'on sache borner : leur premier
 * argument est du code ou un fichier de code, que l'agent écrit. Une entrée
 * exacte reste possible.
 */
export const INTERPRETER_FAMILIES: ReadonlySet<string> = new Set([
  'node', 'nodejs', 'ruby', 'irb', 'perl', 'php', 'lua', 'luajit', 'rscript', 'osascript', 'tclsh', 'wish',
  'awk', 'gawk', 'mawk', 'nawk', 'java', 'javaw', 'jshell', 'jrunscript', 'groovy',
])

/** Python : accepté seulement en `python -m <module>`. */
export const PYTHON_FAMILIES: ReadonlySet<string> = new Set(['python', 'pythonw', 'py', 'pypy'])

/**
 * Outils d'analyse **en lecture seule** (Slice 10, étape 4) : ils lisent un
 * fichier et **impriment** le résultat, un point c'est tout. Aucune de leurs
 * options n'exécute un autre programme ni n'écrit un fichier — c'est le critère,
 * et il est strict. Pour eux seuls, un préfixe peut commencer par une option
 * (`objdump -d`, `nm -C`, `strings -n`) : la navigation et le triage d'un
 * binaire se font ainsi, sans une approbation par appel, sans pour autant
 * ouvrir la porte à du code.
 *
 * **Écartés délibérément**, bien qu'utiles : `rg` (son `--pre`/`--hostname-bin`
 * lance une commande par fichier), `file` (`-C` compile un fichier magique
 * nommé), `xxd` (`-r` reconstruit un binaire vers un fichier nommé). Leur
 * préfixe sans approbation pourrait lancer du code ou écrire hors du worktree ;
 * ils restent sous la règle normale, approuvés au coup par coup.
 */
export const READ_ONLY_ANALYSIS: ReadonlySet<string> = new Set([
  'objdump', 'nm', 'strings', 'readelf', 'size', 'od',
])

/**
 * Lanceurs : leur rôle est de faire tourner un **autre** programme, nommé dans
 * leurs arguments (`env X=1 prog`, `xargs prog`, `find . -exec prog`). Leurs
 * options rendent ce programme impossible à repérer sûrement : refusés comme
 * tête de préfixe.
 */
const LAUNCHERS = new Set([
  'env', 'sudo', 'doas', 'su', 'runas', 'nice', 'ionice', 'nohup', 'timeout', 'gtimeout', 'time', 'xargs',
  'parallel', 'stdbuf', 'caffeinate', 'arch', 'exec', 'command', 'builtin', 'start', 'wsl', 'ssh', 'chroot',
  'unshare', 'nsenter', 'setsid', 'taskset', 'watch', 'script', 'find',
])

/**
 * Exécuteurs de paquets ou d'environnements : le mot qui les suit est un
 * programme, jugé à son tour (`uv run pytest` oui, `uv run python` non).
 * Du plus long au plus court, pour que `uv tool run` passe avant `uv`.
 */
const RUNNERS: readonly (readonly string[])[] = [
  ['uv', 'tool', 'run'],
  ['uv', 'run'], ['poetry', 'run'], ['pdm', 'run'], ['hatch', 'run'], ['pipenv', 'run'], ['pipx', 'run'],
  ['conda', 'run'], ['npm', 'exec'], ['npm', 'x'], ['pnpm', 'exec'], ['pnpm', 'dlx'], ['yarn', 'exec'],
  ['yarn', 'dlx'], ['bun', 'x'],
  ['npx'], ['bunx'], ['uvx'], ['pnpx'],
]

/**
 * Sous-commandes qui exécutent un fichier ou du code passé en argument : un
 * préfixe qui commence par elles couvre tout script que l'agent écrirait.
 */
const CODE_SUBCOMMANDS: readonly (readonly string[])[] = [
  ['deno', 'run'], ['deno', 'eval'], ['deno', 'repl'], ['bun', 'run'], ['bun', 'exec'], ['bun', 'repl'],
]

/** Nom d'un module Python : `pytest`, `http.server`, `mypy`. */
const PYTHON_MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

/**
 * Nom de famille d'un programme : base du chemin, en minuscules, sans
 * extension Windows ni numéro de version (`/usr/bin/python3.12` → `python`,
 * `PWSH.EXE` → `pwsh`). Un interpréteur ne doit pas passer pour un autre
 * programme en changeant de casse ou de version.
 */
export function programFamily(word: string): string {
  const base = (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '')
  return base.replace(/[\d.]+$/, '') || base
}

/**
 * Vrai si `argv`, à partir de `from`, commence par les mots de `head`. Le
 * premier se compare par famille : `/opt/homebrew/bin/npx` est `npx`.
 */
function startsWith(argv: readonly string[], head: readonly string[], from = 0): boolean {
  return head.every((w, i) => {
    const word = argv[from + i]
    if (word === undefined) return false
    return i === 0 ? programFamily(word) === w : word.toLowerCase() === w
  })
}

/**
 * Juge le programme à la position `i` d'un préfixe : celui de tête, ou celui
 * qu'un exécuteur (`uv run`, `npx`) fera tourner.
 *
 * @returns le motif du refus, ou `null`
 */
function judgeProgram(argv: readonly string[], i: number): string | null {
  const word = argv[i]
  if (word === undefined) {
    return `« ${argv.join(' ')} » s'arrête sur un exécuteur : il ferait tourner n'importe quel programme. Nomme le programme (${argv.join(' ')} pytest).`
  }
  if (word.startsWith('-')) {
    return `« ${word} » est une option, pas un programme : l'exécuteur ferait tourner ce que l'agent nommerait après.`
  }
  // Un chemin relatif désigne un fichier du worktree, que l'agent écrit : un
  // préfixe dessus accepterait son code avec n'importe quels arguments.
  if (/[\\/]/.test(word) && !/^([\\/]|[A-Za-z]:[\\/])/.test(word)) {
    return `« ${word} » est un chemin relatif : dans un worktree, c'est un fichier que l'agent écrit. Un préfixe se pose sur un programme du PATH ou un chemin absolu.`
  }
  const family = programFamily(word)
  if (SHELL_FAMILIES.has(family)) {
    return `« ${word} » est un shell : en préfixe, il exécuterait n'importe quelle commande. Seule une entrée exacte est possible.`
  }
  if (INTERPRETER_FAMILIES.has(family)) {
    return `« ${word} » est un interpréteur : en préfixe, il exécuterait n'importe quel code ou script que l'agent écrit. Seule une entrée exacte est possible.`
  }
  if (LAUNCHERS.has(family)) {
    return `« ${word} » lance d'autres programmes : en préfixe, il ferait tourner n'importe lequel. Seule une entrée exacte est possible.`
  }
  if (PYTHON_FAMILIES.has(family)) {
    const module = argv[i + 1] === '-m' ? argv[i + 2] : undefined
    if (module === undefined || !PYTHON_MODULE.test(module)) {
      return `« ${word} » n'est accepté en préfixe que suivi d'un module nommé (${word} -m pytest) : ${word} -c ou ${word} script.py ferait tourner sans regard le code de l'agent.`
    }
    return null
  }
  for (const head of CODE_SUBCOMMANDS) {
    if (startsWith(argv, head, i)) {
      return `« ${argv.slice(i, i + head.length).join(' ')} » exécute le fichier ou le code qui suit : en préfixe, n'importe quel script de l'agent. Seule une entrée exacte est possible.`
    }
  }
  for (const head of RUNNERS) {
    if (startsWith(argv, head, i)) return judgeProgram(argv, i + head.length)
  }
  return null
}

/**
 * Dit si un argv peut devenir un **préfixe** de la liste blanche, et sinon
 * pourquoi — en français : le motif s'adresse à l'humain qui l'ajoute.
 *
 * Refusés : un seul mot (`npm` couvrirait `npm install` et `npm exec`) ; une
 * option juste après le programme (`git -c`, `node -e`, `pytest -p`) ; un
 * chemin relatif ; un shell, un interpréteur, un lanceur ; Python hors de
 * `python -m <module>` ; un exécuteur (`uv run`, `npx`) qui ne nomme pas un
 * programme acceptable à son tour.
 *
 * @param argv les mots du préfixe proposé
 * @returns le motif du refus, ou `null` si le préfixe est accepté
 */
export function execPrefixRefusal(argv: readonly string[]): string | null {
  if (argv.length === 0) return 'un préfixe vide couvrirait toutes les commandes'
  if (argv.length < 2) {
    return `un préfixe d'un seul mot couvrirait tout « ${argv[0]} » (${argv[0]} install, ${argv[0]} exec…) : ajoute au moins une sous-commande ou un argument.`
  }
  const second = argv[1]!
  const head = programFamily(argv[0]!)
  // Python a sa propre règle (`-m <module>` seulement), au motif plus précis ;
  // les outils d'analyse en lecture seule (objdump, nm, strings…) acceptent une
  // option en tête, puisqu'ils ne font que lire et imprimer ; partout ailleurs
  // une option en tête change ce que fait le programme avant même sa
  // sous-commande, et peut lui faire lancer du code (git -c, node -e).
  if (second.startsWith('-') && !PYTHON_FAMILIES.has(head) && !READ_ONLY_ANALYSIS.has(head)) {
    return `« ${second} » est une option placée juste après le programme : elle changerait ce qu'il fait (git -c, node -e). Commence par une sous-commande ou un argument nommé, ou ajoute une entrée exacte.`
  }
  return judgeProgram(argv, 0)
}

/**
 * Vrai si une règle couvre cet argv : égalité mot à mot pour une entrée
 * exacte, début mot à mot pour un préfixe. Jamais de comparaison de texte :
 * le préfixe `pytest tests` ne couvre pas `pytest tests_evil`.
 */
export function execRuleMatches(rule: ExecAllowRule, argv: readonly string[]): boolean {
  if (rule.prefix ? argv.length < rule.argv.length : argv.length !== rule.argv.length) return false
  return rule.argv.every((w, i) => w === argv[i])
}

/** Affiche une règle pour un humain : un préfixe se termine par `…`. */
export function formatExecRule(rule: ExecAllowRule): string {
  return rule.prefix ? `${rule.argv.join(' ')} …` : rule.argv.join(' ')
}
