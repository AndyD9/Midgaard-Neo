/**
 * @file Les préfixes de la liste blanche `exec` (Slice 9, étape 3).
 *
 * Ce qui est éprouvé ici, sans daemon : la règle qui juge un préfixe
 * (`execPrefixRefusal`), la comparaison mot à mot, la politique de l'outil
 * `exec` qui nomme le préfixe, le dépôt (migration 15, ajout, élargissement,
 * retrait) et le rejugement au départ d'une tâche (`execRulesForTask`). Le
 * chemin complet — route, moteur, commande lancée sans humain — est le
 * scénario V14 de `tests/developer.ts`.
 *
 * Chaque refus attendu est un cas où un préfixe laisserait l'agent faire
 * tourner du code qu'aucun humain n'a lu : `python -c`, un shell, un lanceur,
 * un exécuteur qui ne nomme pas son programme, un fichier du worktree.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { execPrefixRefusal, execRuleMatches, formatExecRule, loadConfig, programFamily } from '@midgaard/contracts'
import { HarnessStore, MIGRATIONS } from '@midgaard/persistence'
import { execAllowed, findTool, type ToolContext } from '@midgaard/tools'
import { execRulesForTask } from '@midgaard/daemon'

describe('execPrefixRefusal — ce qui est accepté', () => {
  const accepted: string[][] = [
    ['python', '-m', 'pytest'],
    ['python3.12', '-m', 'pytest'],
    ['/usr/bin/python3', '-m', 'http.server'],
    ['py', '-m', 'pytest'],
    ['uv', 'run', 'pytest'],
    ['uv', 'run', 'python', '-m', 'pytest'],
    ['uv', 'tool', 'run', 'ruff'],
    ['npx', 'tsc'],
    ['/opt/homebrew/bin/npx', 'tsc', '--noEmit'],
    ['npm', 'test'],
    ['npm', 'run', 'lint'],
    ['git', 'status'],
    ['/usr/bin/git', 'rev-parse'],
    ['pytest', 'tests'],
    ['cargo', 'test'],
    ['ruff', 'check'],
    ['sigma', 'check'],
    // Outils d'analyse en lecture seule (Slice 10) : une option en tête est
    // acceptée, parce qu'ils ne font que lire et imprimer.
    ['objdump', '-d'],
    ['objdump', '-d', '--no-show-raw-insn'],
    ['nm', '-C'],
    ['nm', '--dynamic'],
    ['strings', '-n', '8'],
    ['readelf', '-h'],
    ['readelf', '-a'],
    ['size', '-A'],
    ['od', '-A', 'x'],
    ['/usr/bin/objdump', '-d'],
  ]
  for (const argv of accepted) {
    it(argv.join(' '), () => assert.equal(execPrefixRefusal(argv), null))
  }
})

describe('execPrefixRefusal — ce qui est refusé, avec son motif', () => {
  const refused: [string[], RegExp][] = [
    [[], /vide/],
    [['pytest'], /seul mot/],
    [['npm'], /seul mot/],
    // Python : seul `-m <module>` borne ce qui tourne.
    [['python', '-c'], /module nommé/],
    [['python', 'script.py'], /module nommé/],
    [['python', '-m'], /module nommé/],
    [['python', '-m', '-c'], /module nommé/],
    [['PYTHON.EXE', '-c'], /module nommé/],
    [['pythonw', 'x.pyw'], /module nommé/],
    // Interpréteurs sans forme module, shells, lanceurs.
    [['node', 'x.js'], /interpréteur/],
    [['ruby', 'x.rb'], /interpréteur/],
    [['bash', 'run.sh'], /shell/],
    [['powershell.exe', 'Invoke-Pester'], /shell/],
    [['pwsh', 'tests'], /shell/],
    [['cmd', 'build'], /shell/],
    [['env', 'python'], /lance d'autres programmes/],
    [['xargs', 'rm'], /lance d'autres programmes/],
    [['find', '.'], /lance d'autres programmes/],
    [['ssh', 'vm'], /lance d'autres programmes/],
    // Une option juste après le programme change ce qu'il fait.
    [['node', '--test'], /option/],
    [['git', '-c'], /option/],
    [['npm', '--prefix'], /option/],
    [['bash', '-c'], /option/],
    // Les outils d'analyse écartés de la safelist (Slice 10) : option-first
    // refusée, car leurs options peuvent lancer du code ou écrire un fichier.
    [['rg', '-n'], /option/], // --pre lance une commande par fichier
    [['file', '-C'], /option/], // -C compile un fichier magique nommé
    [['xxd', '-r'], /option/], // -r reconstruit un binaire vers un fichier
    // Un outil en lecture seule reste refusé en chemin relatif (fichier du worktree).
    [['./objdump', '-d'], /chemin relatif/],
    // Et à un seul mot : un préfixe « objdump » couvrirait tout objdump.
    [['objdump'], /seul mot/],
    // Les exécuteurs : le programme qu'ils lancent est jugé à son tour.
    [['uv', 'run'], /exécuteur/],
    [['npm', 'exec'], /exécuteur/],
    [['uv', 'run', 'python'], /module nommé/],
    [['uv', 'run', 'bash'], /shell/],
    [['uvx', 'python'], /module nommé/],
    [['npx', '-y'], /option/],
    [['npx', './x.js'], /chemin relatif/],
    [['npm', 'x', 'sh'], /shell/],
    [['/opt/homebrew/bin/npx', 'bash'], /shell/],
    [['uv', 'run', 'env', 'x'], /lance d'autres programmes/],
    // Les sous-commandes qui exécutent un fichier ou du code.
    [['deno', 'run'], /exécute le fichier ou le code/],
    [['deno', 'eval'], /exécute le fichier ou le code/],
    [['bun', 'run'], /exécute le fichier ou le code/],
    // Un fichier du worktree : l'agent l'écrit.
    [['./scripts/test.sh', 'all'], /chemin relatif/],
    [['.venv/bin/pytest', 'tests'], /chemin relatif/],
    [['scripts\\t.bat', 'x'], /chemin relatif/],
  ]
  for (const [argv, why] of refused) {
    it(argv.join(' ') || '(vide)', () => assert.match(execPrefixRefusal(argv) ?? '(accepté)', why))
  }
})

describe('programFamily', () => {
  it('ramène un interpréteur à sa famille, quelle que soit sa casse, sa version ou son extension', () => {
    assert.equal(programFamily('/usr/bin/python3.12'), 'python')
    assert.equal(programFamily('C:\\Python312\\PYTHON.EXE'), 'python')
    assert.equal(programFamily('pwsh.exe'), 'pwsh')
    assert.equal(programFamily('node22'), 'node')
    assert.equal(programFamily('git'), 'git')
  })
})

describe('execRuleMatches', () => {
  const prefix = { argv: ['pytest', 'tests'], prefix: true }
  const exact = { argv: ['pytest', 'tests'], prefix: false }

  it('un préfixe couvre tout argv qui commence par ses mots, lui compris', () => {
    assert.equal(execRuleMatches(prefix, ['pytest', 'tests']), true)
    assert.equal(execRuleMatches(prefix, ['pytest', 'tests', '-k', 'foo']), true)
  })

  it('compare mot à mot, jamais le texte', () => {
    assert.equal(execRuleMatches(prefix, ['pytest', 'tests_evil']), false)
    assert.equal(execRuleMatches(prefix, ['pytest']), false)
    assert.equal(execRuleMatches(prefix, ['PYTEST', 'tests']), false, 'la casse compte : c\'est un autre programme')
  })

  it('une entrée exacte ne couvre que son argv', () => {
    assert.equal(execRuleMatches(exact, ['pytest', 'tests']), true)
    assert.equal(execRuleMatches(exact, ['pytest', 'tests', '-x']), false)
  })

  it('un préfixe s\'affiche avec …', () => {
    assert.equal(formatExecRule(prefix), 'pytest tests …')
    assert.equal(formatExecRule(exact), 'pytest tests')
  })
})

describe('exec : la politique nomme le préfixe qui laisse passer', () => {
  const exec = findTool('exec')!
  const ctx = (execAllow: ToolContext['execAllow']): ToolContext => ({
    root: tmpdir(), httpPolicy: 'open', allowHosts: [], log: () => {}, writable: true, execAllow,
  })
  const allow = [
    { argv: ['python', '-m', 'pytest'], prefix: true },
    { argv: ['python', '-m', 'pytest', '-q'], prefix: false },
  ]
  const policy = (args: Record<string, unknown>) => exec.policy(exec.schema.parse(args) as never, ctx(allow))

  it('autorise sans humain ce qu\'un préfixe couvre, et le dit', () => {
    const v = policy({ command: 'python', args: ['-m', 'pytest', '-k', 'foo'] })
    assert.equal(v.decision, 'allow')
    assert.match(v.reason, /préfixe « python -m pytest … »/)
  })

  it('demande un humain pour le reste', () => {
    const v = policy({ command: 'python', args: ['-m', 'pip', 'install', 'x'] })
    assert.equal(v.decision, 'approval')
  })

  it('nomme l\'entrée exacte quand l\'argv est couvert des deux façons', () => {
    assert.equal(execAllowed(['python', '-m', 'pytest', '-q'], allow)?.prefix, false)
    const v = policy({ command: 'python', args: ['-m', 'pytest', '-q'] })
    assert.doesNotMatch(v.reason, /préfixe/)
  })
})

describe('dépôt : préfixes de la liste blanche (migration 15)', () => {
  let home: string
  let store: HarnessStore
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'midgaard-prefix-'))
    store = HarnessStore.open(loadConfig({ MIDGAARD_HOME: home }))
  })
  afterEach(() => {
    store.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('garde exactes les entrées d\'avant', () => {
    // Une base arrêtée au schéma 14, comme l'a laissée l'étape 1 de la Slice 9.
    const path = join(home, 'v14.db')
    const old = new DatabaseSync(path)
    for (const m of MIGRATIONS.filter((m) => m.version <= 14)) old.exec(m.sql)
    old.exec('PRAGMA user_version = 14')
    old.exec(`INSERT INTO exec_allow (repo_dir, argv_json, added_at, added_by)
              VALUES ('/depot', '["npm","test"]', '2026-11-01T00:00:00.000Z', 'cli')`)
    old.close()
    const migrated = HarnessStore.open({ dbPath: path })
    try {
      assert.deepEqual(
        migrated.listExecAllow('/depot').map((e) => [e.argv, e.prefix]),
        [[['npm', 'test'], false]],
      )
    } finally {
      migrated.close()
    }
  })

  it('ajoute, élargit en préfixe, ne rétrécit jamais, retire', () => {
    assert.equal(store.addExecAllow('/depot', ['uv', 'run', 'pytest'], 'cli'), 'added')
    assert.equal(store.addExecAllow('/depot', ['uv', 'run', 'pytest'], 'cli'), 'unchanged')
    assert.equal(store.addExecAllow('/depot', ['uv', 'run', 'pytest'], 'dashboard', true), 'widened')
    const [e] = store.listExecAllow('/depot')
    assert.equal(e!.prefix, true)
    assert.equal(e!.added_by, 'dashboard', 'l\'élargissement est une autorisation de plus : son auteur est gardé')
    assert.equal(store.addExecAllow('/depot', ['uv', 'run', 'pytest'], 'cli'), 'unchanged', 'exact sur un préfixe : rien ne rétrécit')
    assert.equal(store.listExecAllow('/depot')[0]!.prefix, true)
    assert.equal(store.addExecAllow('/depot', ['uv', 'run', 'pytest'], 'cli', true), 'unchanged')
    assert.equal(store.removeExecAllow('/depot', ['uv', 'run', 'pytest']), true)
    assert.equal(store.listExecAllow('/depot').length, 0)
  })

  it('refuse en base une valeur de préfixe qui n\'est ni 0 ni 1', () => {
    assert.throws(() =>
      store.db
        .prepare(`INSERT INTO exec_allow (repo_dir, argv_json, added_at, added_by, prefix) VALUES ('/d', '["a","b"]', 'x', 'y', 2)`)
        .run(),
    )
  })
})

describe('execRulesForTask : chaque préfixe rejugé au départ', () => {
  const entry = (argv: string[], prefix: boolean) => ({ repo_dir: '/depot', argv, prefix, added_at: '2026-11-07T00:00:00.000Z', added_by: 'cli' })

  it('garde la liste globale en exact, et les préfixes valides', () => {
    const { rules, ignored } = execRulesForTask([['npm', 'test']], [entry(['uv', 'run', 'pytest'], true)])
    assert.deepEqual(rules, [
      { argv: ['npm', 'test'], prefix: false },
      { argv: ['uv', 'run', 'pytest'], prefix: true },
    ])
    assert.deepEqual(ignored, [])
  })

  it('écarte un préfixe que la règle refuse aujourd\'hui, sans le changer en entrée exacte', () => {
    // Ajouté avant un durcissement de la règle, ou écrit en base à la main.
    const { rules, ignored } = execRulesForTask([], [entry(['python', '-c'], true)])
    assert.deepEqual(rules, [])
    assert.equal(ignored.length, 1)
    assert.match(ignored[0]!.reason, /module nommé/)
  })

  it('ne juge pas une entrée exacte : l\'humain a lu l\'argv entier', () => {
    const { rules } = execRulesForTask([], [entry(['node', '-e', 'console.log(1)'], false)])
    assert.deepEqual(rules, [{ argv: ['node', '-e', 'console.log(1)'], prefix: false }])
  })
})
