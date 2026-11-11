/**
 * @file Outils d'écriture : ce qu'ils écrivent, et surtout ce qu'ils refusent.
 *
 * Le plan (§8.4) demande que « écriture hors worktree » et « symlink pointant
 * hors workspace » échouent proprement. Chaque refus est vérifié **par son
 * effet** : le fichier visé hors de la racine garde son contenu, aucun fichier
 * n'apparaît dehors, `.git` n'est pas touché. Un refus qui aurait quand même
 * écrit ne serait pas un refus.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MAX_WRITE_BYTES, findTool, toolSpecs, type ToolContext } from '@midgaard/tools'
import { createWorktree, inspectRepository } from '@midgaard/workspace'

let home: string
let root: string
let outside: string

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-write-')))
  root = join(home, 'worktree')
  outside = join(home, 'dehors')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\nexport const b = 1\n')
  writeFileSync(join(root, '.git'), 'gitdir: /quelque/part\n')
  writeFileSync(join(outside, 'secret.txt'), 'original\n')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'lien-dehors.txt'))
  symlinkSync(join(root, 'src', 'a.ts'), join(root, 'lien-dedans.ts'))
  symlinkSync(outside, join(root, 'dossier-dehors'))
  symlinkSync(join(home, 'absent'), join(root, 'lien-casse'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { root, httpPolicy: 'open', allowHosts: [], log: () => {}, writable: true, ...over }
}

/** Valide puis exécute un outil, comme le fait la boucle. */
async function call(name: string, args: unknown, c: ToolContext = ctx()) {
  const tool = findTool(name)!
  const parsed = tool.schema.parse(args)
  const verdict = tool.policy(parsed as never, c)
  if (verdict.decision !== 'allow') return { verdict }
  return { verdict, result: await tool.run(parsed as never, c) }
}

async function refused(name: string, args: unknown, pattern: RegExp) {
  await assert.rejects(call(name, args), pattern)
}

describe('sans worktree, rien ne s\'écrit', () => {
  it('les trois outils refusent, sans demander d\'approbation', async () => {
    for (const [name, args] of [
      ['write_file', { path: 'x.ts', content: 'x' }],
      ['edit_file', { path: 'src/a.ts', old_string: 'a', new_string: 'z' }],
      ['delete_file', { path: 'src/a.ts' }],
    ] as const) {
      for (const writable of [false, undefined]) {
        const { verdict } = await call(name, args, ctx({ writable }))
        assert.equal(verdict.decision, 'deny', `${name} avec writable=${writable}`)
      }
    }
    assert.equal(existsSync(join(root, 'x.ts')), false)
    assert.equal(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), 'export const a = 1\nexport const b = 1\n')
  })

  it('git_diff refuse sans worktree', async () => {
    assert.equal((await call('git_diff', {}, ctx({ workspace: null }))).verdict.decision, 'deny')
  })
})

describe('write_file', () => {
  it('crée un fichier et ses dossiers, puis le remplace', async () => {
    const created = await call('write_file', { path: 'src/routes/health.ts', content: 'export {}\n' })
    assert.match(created.result!.content, /^Created src\/routes\/health\.ts/)
    const replaced = await call('write_file', { path: 'src/routes/health.ts', content: 'export const ok = 1\n' })
    assert.match(replaced.result!.content, /^Replaced/)
    assert.equal(readFileSync(join(root, 'src', 'routes', 'health.ts'), 'utf8'), 'export const ok = 1\n')
  })

  it('accepte un chemin absolu sous la racine', async () => {
    await call('write_file', { path: join(root, 'abs.txt'), content: 'ok' })
    assert.equal(readFileSync(join(root, 'abs.txt'), 'utf8'), 'ok')
  })

  it('refuse de sortir de la racine, par ../ ou par un chemin absolu', async () => {
    await refused('write_file', { path: '../dehors/nouveau.txt', content: 'x' }, /outside your workspace/)
    await refused('write_file', { path: join(outside, 'nouveau.txt'), content: 'x' }, /outside your workspace/)
    await refused('write_file', { path: '.', content: 'x' }, /outside your workspace/)
    assert.equal(existsSync(join(outside, 'nouveau.txt')), false)
  })

  it('refuse tout ce qui est sous .git, quelle que soit la casse', async () => {
    for (const path of ['.git', '.git/config', '.GIT/hooks/pre-commit', 'src/.git/x']) {
      await refused('write_file', { path, content: 'x' }, /\.git/)
    }
    assert.equal(readFileSync(join(root, '.git'), 'utf8'), 'gitdir: /quelque/part\n', '.git est intact')
  })

  it('n\'écrit jamais à travers un lien, même vers un fichier de la racine', async () => {
    await refused('write_file', { path: 'lien-dehors.txt', content: 'pwned' }, /symbolic link/)
    await refused('write_file', { path: 'lien-dedans.ts', content: 'pwned' }, /symbolic link/)
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'original\n')
    assert.equal(lstatSync(join(root, 'lien-dehors.txt')).isSymbolicLink(), true, 'le lien n\'a pas été remplacé')
  })

  it('refuse un dossier-lien qui mène dehors, et n\'y crée rien', async () => {
    await refused('write_file', { path: 'dossier-dehors/nouveau.txt', content: 'x' }, /symbolic link/)
    await refused('write_file', { path: 'dossier-dehors/sous/nouveau.txt', content: 'x' }, /symbolic link/)
    assert.equal(existsSync(join(outside, 'nouveau.txt')), false)
    assert.equal(existsSync(join(outside, 'sous')), false)
  })

  it('refuse un lien cassé et un parent qui est un fichier, avec une phrase', async () => {
    await refused('write_file', { path: 'lien-casse/x.txt', content: 'x' }, /broken symbolic link/)
    await refused('write_file', { path: 'src/a.ts/x.txt', content: 'x' }, /parent of this path is a file/)
  })

  it('borne la taille d\'un contenu', () => {
    const tool = findTool('write_file')!
    const big = 'x'.repeat(MAX_WRITE_BYTES + 1)
    assert.equal(tool.schema.safeParse({ path: 'gros.txt', content: big }).success, false)
  })
})

describe('edit_file', () => {
  it('remplace un passage unique, sans interpréter les $ du remplacement', async () => {
    const { result } = await call('edit_file', {
      path: 'src/a.ts',
      old_string: 'export const a = 1',
      new_string: 'export const a = `$& $1 $$`',
    })
    assert.match(result!.content, /1 replacement/)
    assert.equal(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), 'export const a = `$& $1 $$`\nexport const b = 1\n')
  })

  it('refuse un passage ambigu, sauf replace_all', async () => {
    await refused('edit_file', { path: 'src/a.ts', old_string: '= 1', new_string: '= 2' }, /occurs 2 times/)
    const { result } = await call('edit_file', { path: 'src/a.ts', old_string: '= 1', new_string: '= 2', replace_all: true })
    assert.match(result!.content, /2 replacement/)
    assert.equal(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), 'export const a = 2\nexport const b = 2\n')
  })

  it('dit quoi faire quand le passage ou le fichier manque', async () => {
    await refused('edit_file', { path: 'src/a.ts', old_string: 'introuvable', new_string: 'x' }, /not found.*Read the file/)
    await refused('edit_file', { path: 'src/absent.ts', old_string: 'a', new_string: 'b' }, /Create it with write_file/)
  })

  it('n\'édite pas à travers un lien', async () => {
    await refused('edit_file', { path: 'lien-dehors.txt', old_string: 'original', new_string: 'pwned' }, /symbolic link/)
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'original\n')
  })
})

describe('sous-modules', () => {
  // Ce qu'un agent écrit dans un sous-module vide est ignoré sans un mot par le
  // commit de fin (constaté dans workspace.test.ts) : il faut le refuser avant.
  const sub = () => ctx({ workspace: { path: root, baseCommit: 'a'.repeat(40), submodules: ['vendor/lib'] } })

  it('refuse d\'écrire dans un sous-module, à toute profondeur et quelle que soit la casse', async () => {
    mkdirSync(join(root, 'vendor', 'lib'), { recursive: true })
    for (const path of ['vendor/lib/a.ts', 'vendor/lib/deep/b.ts', 'Vendor/LIB/c.ts']) {
      await assert.rejects(call('write_file', { path, content: 'x' }, sub()), /inside the git submodule vendor\/lib.*silently/)
    }
    await assert.rejects(call('delete_file', { path: 'vendor/lib' }, sub()), /git submodule/)
    assert.equal(existsSync(join(root, 'vendor', 'lib', 'deep')), false, 'aucun dossier créé avant le refus')
  })

  it('n\'est pas trompé par un lien qui mène dans le sous-module', async () => {
    mkdirSync(join(root, 'vendor', 'lib'), { recursive: true })
    symlinkSync(join(root, 'vendor', 'lib'), join(root, 'raccourci'))
    await assert.rejects(call('write_file', { path: 'raccourci/a.ts', content: 'x' }, sub()), /git submodule/)
  })

  it('laisse écrire à côté, y compris sous un nom qui commence pareil', async () => {
    await call('write_file', { path: 'vendor/library.ts', content: 'x' }, sub())
    await call('write_file', { path: 'vendor/lib2/a.ts', content: 'x' }, sub())
    assert.equal(readFileSync(join(root, 'vendor', 'lib2', 'a.ts'), 'utf8'), 'x')
  })
})

// Sous Windows, Git convertit le worktree en CRLF au checkout ; un modèle écrit
// `\n` (docs/SLICE3.md, leçon n° 20). Ces cas valent sur toutes les plateformes.
describe('edit_file et les fins de ligne', () => {
  const crlf = 'export function a() {\r\n  return 1\r\n}\r\nexport const b = `$1`\r\n'

  it('trouve en CRLF un passage écrit en LF, et le remplace en CRLF', async () => {
    writeFileSync(join(root, 'src', 'w.ts'), crlf)
    const { result } = await call('edit_file', {
      path: 'src/w.ts',
      old_string: 'export function a() {\n  return 1\n}',
      new_string: 'export function a() {\n  return `$&`\n}',
    })
    assert.match(result!.content, /1 replacement.*Line endings were adapted/)
    assert.equal(
      readFileSync(join(root, 'src', 'w.ts'), 'utf8'),
      'export function a() {\r\n  return `$&`\r\n}\r\nexport const b = `$1`\r\n',
      'aucune fin de ligne mêlée, et les $ restent littéraux',
    )
  })

  it('écrit en CRLF les lignes ajoutées sous un passage d\'une seule ligne', async () => {
    writeFileSync(join(root, 'src', 'w.ts'), crlf)
    await call('edit_file', { path: 'src/w.ts', old_string: 'export const b = `$1`', new_string: 'const b = 1\nconst c = 2' })
    assert.equal(
      readFileSync(join(root, 'src', 'w.ts'), 'utf8'),
      'export function a() {\r\n  return 1\r\n}\r\nconst b = 1\r\nconst c = 2\r\n',
    )
  })

  it('laisse un fichier LF en LF, même si le modèle écrit CRLF', async () => {
    const { result } = await call('edit_file', {
      path: 'src/a.ts',
      old_string: 'export const a = 1\r\nexport const b = 1',
      new_string: 'export const a = 2\r\nexport const b = 2',
    })
    assert.match(result!.content, /adapted/)
    assert.equal(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), 'export const a = 2\nexport const b = 2\n')
  })

  it('ne dit rien quand rien n\'a été adapté', async () => {
    const { result } = await call('edit_file', { path: 'src/a.ts', old_string: 'const a = 1', new_string: 'const a = 3' })
    assert.doesNotMatch(result!.content, /adapted/)
  })

  it('tient pour ambigu un passage présent une fois en LF et une fois en CRLF', async () => {
    // La tolérance ne doit pas choisir à la place du modèle.
    writeFileSync(join(root, 'src', 'm.ts'), 'x\ny\r\nx\r\ny\n')
    await refused('edit_file', { path: 'src/m.ts', old_string: 'x\ny', new_string: 'z' }, /occurs 2 times/)
    await call('edit_file', { path: 'src/m.ts', old_string: 'x\ny', new_string: 'z\nw', replace_all: true })
    assert.equal(readFileSync(join(root, 'src', 'm.ts'), 'utf8'), 'z\nw\r\nz\r\nw\n', 'chaque passage garde sa fin de ligne')
  })

  it('lit littéralement les caractères spéciaux des expressions régulières', async () => {
    writeFileSync(join(root, 'src', 'r.ts'), 'const r = /a.b+(c)?[d]\\$/\r\nconst s = "aXb"\r\n')
    // Lu comme motif, `a.b` trouverait aussi `aXb` : deux occurrences, refusées.
    writeFileSync(join(root, 'src', 's.ts'), 'aXb\r\n')
    await refused('edit_file', { path: 'src/s.ts', old_string: 'a.b', new_string: 'q' }, /not found/)
    const { result } = await call('edit_file', { path: 'src/r.ts', old_string: '/a.b+(c)?[d]\\$/\n', new_string: '/x/\n' })
    assert.match(result!.content, /1 replacement/)
    assert.equal(readFileSync(join(root, 'src', 'r.ts'), 'utf8'), 'const r = /x/\r\nconst s = "aXb"\r\n')
  })

  it('dans un vrai dépôt en CRLF, le diff ne montre que les lignes changées', async () => {
    // `.gitattributes` force le checkout en CRLF, quelle que soit la plateforme :
    // c'est ce que `core.autocrlf` fait sous Windows.
    const repo = join(home, 'depot-crlf')
    mkdirSync(repo)
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@example.org', '-c', 'commit.gpgsign=false', ...a], {
        cwd: repo,
        stdio: 'ignore',
      })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, '.gitattributes'), '*.ts text eol=crlf\n')
    writeFileSync(join(repo, 'app.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
    const wt = await createWorktree({
      repo: await inspectRepository(repo),
      worktreesDir: join(home, 'worktrees'),
      taskId: '22222222-2222-4333-8444-555555555555',
    })
    assert.match(readFileSync(join(wt.root, 'app.ts'), 'utf8'), /\r\n/, 'le worktree doit être en CRLF')
    const c = ctx({ root: wt.root, workspace: { path: wt.path, baseCommit: wt.baseCommit } })

    await call('edit_file', { path: 'app.ts', old_string: 'const b = 2\nconst c', new_string: 'const b = 20\nconst c' }, c)
    const stat = await call('git_diff', { stat_only: true }, c)
    assert.match(stat.result!.content, /app\.ts \+1 -1/, 'une ligne changée, pas tout le fichier')
  })
})

describe('delete_file', () => {
  it('supprime un fichier, refuse un dossier', async () => {
    await call('delete_file', { path: 'src/a.ts' })
    assert.equal(existsSync(join(root, 'src', 'a.ts')), false)
    await refused('delete_file', { path: 'src' }, /is a directory/)
    await refused('delete_file', { path: 'src/absent.ts' }, /no such file/)
  })

  it('supprime un lien lui-même, jamais sa cible', async () => {
    await call('delete_file', { path: 'lien-dehors.txt' })
    assert.equal(existsSync(join(root, 'lien-dehors.txt')), false)
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'original\n')
  })

  it('refuse .git et l\'extérieur', async () => {
    await refused('delete_file', { path: '.git' }, /\.git/)
    await refused('delete_file', { path: '../dehors/secret.txt' }, /outside your workspace/)
    assert.ok(existsSync(join(root, '.git')))
    assert.ok(existsSync(join(outside, 'secret.txt')))
  })
})

describe('git_diff', () => {
  it('montre le fichier qu\'un agent vient de créer dans son worktree', async () => {
    const repo = join(home, 'depot')
    mkdirSync(repo)
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@example.org', '-c', 'commit.gpgsign=false', ...a], {
        cwd: repo,
        stdio: 'ignore',
      })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'index.ts'), 'export {}\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')
    const wt = await createWorktree({
      repo: await inspectRepository(repo),
      worktreesDir: join(home, 'worktrees'),
      taskId: '11111111-2222-4333-8444-555555555555',
    })
    const c = ctx({ root: wt.root, workspace: { path: wt.path, baseCommit: wt.baseCommit } })

    assert.equal((await call('git_diff', {}, c)).result!.content, 'No changes yet.')
    await call('write_file', { path: 'health.ts', content: 'export const health = 1\n' }, c)
    const stat = await call('git_diff', { stat_only: true }, c)
    assert.match(stat.result!.content, /added\s+health\.ts \+1 -0/)
    assert.doesNotMatch(stat.result!.content, /@@/, 'stat_only ne rend pas le patch')
    const full = await call('git_diff', {}, c)
    assert.match(full.result!.content, /\+export const health = 1/)
  })
})

describe('description aux modèles', () => {
  it('décrit les outils d\'écriture, replace_all facultatif', () => {
    const [edit] = toolSpecs(['edit_file'])
    const required = (edit!.parameters as { required?: string[] }).required ?? []
    assert.deepEqual(required.sort(), ['new_string', 'old_string', 'path'])
  })
})
