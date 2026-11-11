/**
 * @file Worktrees des agents écrivants, éprouvés sur de **vrais** dépôts Git
 * jetables — jamais sur des sorties de `git` recopiées.
 *
 * La leçon des dettes de la Slice 2 vaut ici plus qu'ailleurs : du code écrit
 * d'après la documentation de `git`, relu et plausible, ne vaut rien tant qu'il
 * n'a pas tourné. Chaque garantie du paquet est donc vérifiée par son effet sur
 * le disque : le dépôt de l'utilisateur intact, le fichier nouveau présent dans
 * le diff, le hook **pas** exécuté, le dossier **pas** supprimé.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  WorkspaceError,
  agentIdentity,
  commitAll,
  countPorcelainEntries,
  createWorktree,
  diffWorktree,
  inspectRepository,
  listSubmodules,
  parseNameStatus,
  parseNumstat,
  removeWorktree,
  worktreeState,
} from '@midgaard/workspace'

const TASK_ID = '0b9f3c2e-4d1a-4f6b-9c7e-2a5d8e1f3b40'

let scratch: string
let repo: string
let worktreesDir: string

/** `git` pour préparer les dépôts d'essai, avec une identité et sans signature, quelle que soit la machine. */
function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Utilisateur', '-c', 'user.email=utilisateur@example.org', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

beforeEach(() => {
  // `realpath` d'emblée : sous macOS, le dossier temporaire passe par un lien
  // symbolique, et c'est précisément ce que le paquet doit savoir traverser.
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-ws-')))
  repo = join(scratch, 'mon dépôt')
  worktreesDir = join(scratch, 'home', 'worktrees')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'packages', 'api'), { recursive: true })
  sh(scratch, 'init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, 'README.md'), '# Projet\n')
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(repo, 'src', 'old.ts'), 'export const old = true\n')
  writeFileSync(join(repo, 'packages', 'api', 'index.ts'), 'export {}\n')
  writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 3, 255, 0]))
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', 'initial')
})
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('inspectRepository', () => {
  it('rend la racine canonique, le sous-dossier délégué, HEAD et la branche', async () => {
    const info = await inspectRepository(join(repo, 'packages', 'api'))
    assert.equal(info.toplevel, repo)
    assert.equal(info.subdir, 'packages/api/')
    assert.equal(info.head, sh(repo, 'rev-parse', 'HEAD').trim())
    assert.equal(info.ref, 'main')
    assert.equal(info.dirty, 0)
  })

  it('compte les chemins non commités, fichiers nouveaux compris', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2\n')
    writeFileSync(join(repo, 'src', 'nouveau.ts'), 'export {}\n')
    assert.equal((await inspectRepository(repo)).dirty, 2)
  })

  it('rend `ref: null` sur un HEAD détaché', async () => {
    sh(repo, 'checkout', '-q', '--detach')
    assert.equal((await inspectRepository(repo)).ref, null)
  })

  it('refuse un dossier hors dépôt, un dépôt sans commit et un dossier absent, en disant quoi faire', async () => {
    const plain = join(scratch, 'pas-un-depot')
    mkdirSync(plain)
    await assert.rejects(inspectRepository(plain), (e: Error) => e instanceof WorkspaceError && /pas dans un dépôt Git/.test(e.message))

    const empty = join(scratch, 'vide')
    sh(scratch, 'init', '-q', empty)
    await assert.rejects(inspectRepository(empty), /aucun commit/)

    await assert.rejects(inspectRepository(join(scratch, 'absent')), /n'existe pas/)
  })

  it('ignore un GIT_DIR hérité qui redirigerait chaque commande ailleurs', async () => {
    // Le daemon peut avoir été lancé depuis un hook Git, où GIT_DIR est posé.
    // Hérité tel quel, il ferait opérer chaque commande sur un autre dépôt.
    const saved = process.env.GIT_DIR
    process.env.GIT_DIR = join(scratch, 'ailleurs.git')
    try {
      assert.equal((await inspectRepository(repo)).toplevel, repo)
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }
  })
})

describe('createWorktree', () => {
  it('crée le worktree hors du dépôt, sur une branche midgaard/, sans toucher au dépôt de l\'utilisateur', async () => {
    // Du travail en cours chez l'utilisateur : il doit rester où il est, et ne
    // pas apparaître chez l'agent.
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 42 // en cours\n')
    const before = sh(repo, 'status', '--porcelain')
    const headBefore = sh(repo, 'rev-parse', 'HEAD')

    const info = await inspectRepository(join(repo, 'packages', 'api'))
    const wt = await createWorktree({ repo: info, worktreesDir, taskId: TASK_ID })

    assert.equal(wt.branch, 'midgaard/0b9f3c2e')
    assert.ok(wt.path.startsWith(join(worktreesDir, 'mon-d')), `worktree sous worktreesDir : ${wt.path}`)
    assert.equal(wt.root, join(wt.path, 'packages/api/'))
    assert.equal(wt.baseCommit, info.head)
    // Fins de ligne normalisées : sous Windows, Git convertit en CRLF au
    // checkout (`core.autocrlf`), comme il le fait pour le dépôt de
    // l'utilisateur. Ce qui est vérifié ici, c'est que le travail en cours
    // n'est pas recopié — constaté en CI, passage 41050259725.
    assert.equal(
      readFileSync(join(wt.path, 'src', 'a.ts'), 'utf8').replaceAll('\r\n', '\n'),
      'export const a = 1\n',
      'le travail non commité n\'est pas recopié',
    )

    assert.equal(sh(repo, 'status', '--porcelain'), before, 'le dépôt de l\'utilisateur est intact')
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), headBefore)
    assert.equal(sh(repo, 'branch', '--show-current').trim(), 'main', 'aucun checkout dans le dépôt de l\'utilisateur')
  })

  it('prend l\'identifiant entier si la branche courte existe déjà, plutôt que d\'écraser', async () => {
    sh(repo, 'branch', 'midgaard/0b9f3c2e')
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    assert.equal(wt.branch, `midgaard/${TASK_ID}`)
  })

  it('n\'exécute pas le hook post-checkout du dépôt', async () => {
    const marker = installHook('post-checkout')
    await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    assert.equal(existsSync(marker), false, 'le hook ne doit pas avoir tourné')
  })
})

/**
 * Pose un hook dans `.husky/` — **dans l'arbre de travail**, comme le fait
 * Husky — et pointe `core.hooksPath` dessus. C'est le cas dangereux : dans un
 * worktree, cet arbre est écrit par l'agent.
 *
 * @returns le fichier que le hook crée s'il s'exécute
 */
function installHook(name: string): string {
  const marker = join(scratch, `${name}-a-tourne`)
  mkdirSync(join(repo, '.husky'), { recursive: true })
  const hook = join(repo, '.husky', name)
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(hook, 0o755)
  sh(repo, 'config', 'core.hooksPath', '.husky')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '--no-verify', '-m', 'hooks')
  return marker
}

describe('sous-modules', () => {
  /**
   * Déclare des sous-modules sans réseau ni `protocol.file` : le lien (mode
   * `160000`) est posé directement dans l'index, comme `git submodule add` le
   * ferait, vers un commit qui n'a pas besoin d'exister ici.
   */
  function addSubmodules(entries: Record<string, string>, extraGitmodules = ''): void {
    const fake = sh(repo, 'rev-parse', 'HEAD').trim()
    let gitmodules = ''
    for (const [name, path] of Object.entries(entries)) {
      gitmodules += `[submodule "${name}"]\n\tpath = ${path}\n\turl = https://example.invalid/${name}.git\n`
      sh(repo, 'update-index', '--add', '--cacheinfo', `160000,${fake},${path}`)
    }
    writeFileSync(join(repo, '.gitmodules'), gitmodules + extraGitmodules)
    sh(repo, 'add', '.gitmodules')
    sh(repo, 'commit', '-q', '-m', 'sous-modules')
  }

  it('les nomme à la création du worktree, chemins à espaces compris', async () => {
    addSubmodules({ lib: 'vendor/lib', autre: 'deps/avec espace' })
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    assert.deepEqual(wt.submodules, ['deps/avec espace', 'vendor/lib'])
  })

  it('ignore un chemin de .gitmodules qui n\'est pas un sous-module dans le commit', async () => {
    // `.gitmodules` est un fichier du projet : il peut mentir, ou dater.
    addSubmodules({ lib: 'vendor/lib' }, '[submodule "fantome"]\n\tpath = src\n\turl = https://example.invalid/x.git\n')
    assert.deepEqual(await listSubmodules(repo, 'HEAD'), ['vendor/lib'])
  })

  it('rend une liste vide sans .gitmodules', async () => {
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    assert.deepEqual(wt.submodules, [])
  })

  it('constat qui motive le refus d\'écrire : git add -A ignore en silence ce qui est écrit dans un sous-module vide', async () => {
    // Si une version de Git change cela, ce test le dira — et le refus des
    // outils d'écriture pourra être reconsidéré.
    addSubmodules({ lib: 'vendor/lib' })
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    writeFileSync(join(wt.path, 'vendor', 'lib', 'perdu.ts'), 'export {}\n')
    assert.equal(await commitAll(wt.path, 'essai', agentIdentity('developer')), null, 'rien à commiter : le fichier est ignoré')
  })
})

describe('diffWorktree', () => {
  it('voit les commits, les modifications, les suppressions, les binaires et les fichiers nouveaux', async () => {
    const info = await inspectRepository(repo)
    const wt = await createWorktree({ repo: info, worktreesDir, taskId: TASK_ID })

    // Un commit de l'agent…
    writeFileSync(join(wt.path, 'README.md'), '# Projet\n\nAvec une route /health.\n')
    await commitAll(wt.path, 'premier jet', agentIdentity('developer'))
    // …puis du travail non commité, dont un fichier que git ne suit pas encore,
    // et un fichier ignoré qui ne doit pas apparaître.
    writeFileSync(join(wt.path, 'src', 'a.ts'), 'export const a = 1\nexport const b = 2\n')
    writeFileSync(join(wt.path, 'src', 'health.ts'), 'export const health = () => "ok"\n')
    rmSync(join(wt.path, 'src', 'old.ts'))
    writeFileSync(join(wt.path, 'logo.bin'), Buffer.from([9, 9, 0, 9]))
    mkdirSync(join(wt.path, 'node_modules'))
    writeFileSync(join(wt.path, 'node_modules', 'x.js'), 'ignored\n')

    const statusBefore = sh(wt.path, 'status', '--porcelain')
    const diff = await diffWorktree(wt.path, wt.baseCommit)

    assert.deepEqual(
      diff.files.map((f) => [f.path, f.kind]),
      [
        ['README.md', 'modified'],
        ['logo.bin', 'modified'],
        ['src/a.ts', 'modified'],
        ['src/health.ts', 'added'],
        ['src/old.ts', 'deleted'],
      ],
    )
    const bin = diff.files.find((f) => f.path === 'logo.bin')!
    assert.equal(bin.binary, true)
    assert.equal(bin.additions, null, 'un binaire n\'a pas de lignes')
    assert.equal(diff.files.find((f) => f.path === 'src/health.ts')!.additions, 1)
    assert.match(diff.patch, /\+\+\+ b\/src\/health\.ts/)
    assert.doesNotMatch(diff.patch, /node_modules/)
    assert.equal(diff.patch_truncated, false)
    assert.equal(diff.additions, diff.files.reduce((n, f) => n + (f.additions ?? 0), 0))

    // Calculer le diff ne doit rien changer à ce que l'agent voit ensuite.
    assert.equal(sh(wt.path, 'status', '--porcelain'), statusBefore, 'l\'index du worktree est intact')
  })

  it('tronque le patch au plafond et le dit, sans rien perdre de la liste des fichiers', async () => {
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    writeFileSync(join(wt.path, 'gros.txt'), 'ligne\n'.repeat(5000))
    const diff = await diffWorktree(wt.path, wt.baseCommit, 1024)
    assert.equal(diff.patch_truncated, true)
    assert.ok(Buffer.byteLength(diff.patch) <= 1024)
    assert.ok(diff.patch_bytes > 1024)
    assert.equal(diff.files.length, 1)
    assert.equal(diff.files[0]!.additions, 5000)
  })

  it('voit une réécriture de même taille faite dans la seconde du checkout', async () => {
    // Le cas *racy git* (diff.ts) : sans la date d'origine sur la copie de
    // l'index, ce fichier passait pour intact dès que le diff tombait dans la
    // seconde suivante — cinq fois sur cinq. Trouvé par un test du dashboard qui
    // n'échouait que sous la charge de la suite complète.
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    writeFileSync(join(wt.path, 'src', 'a.ts'), 'export const a = 2\n') // même taille que « = 1 »
    await new Promise((r) => setTimeout(r, 1100))
    const diff = await diffWorktree(wt.path, wt.baseCommit)
    assert.deepEqual(diff.files.map((f) => f.path), ['src/a.ts'])
  })

  it('rend un diff vide sur un worktree intact', async () => {
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    const diff = await diffWorktree(wt.path, wt.baseCommit)
    assert.deepEqual(diff.files, [])
    assert.equal(diff.patch, '')
  })
})

describe('commitAll', () => {
  it('commite au nom de l\'agent, jamais de l\'utilisateur, et rend null s\'il n\'y a rien', async () => {
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    assert.equal(await commitAll(wt.path, 'rien', agentIdentity('developer')), null)

    writeFileSync(join(wt.path, 'src', 'health.ts'), 'export {}\n')
    const sha = await commitAll(wt.path, 'route /health', agentIdentity('developer'))
    assert.match(sha ?? '', /^[0-9a-f]{40}$/)
    assert.equal(sh(wt.path, 'log', '-1', '--format=%an <%ae>|%cn').trim(), 'Midgaard developer <developer@midgaard.invalid>|Midgaard developer')
    assert.equal(sh(wt.path, 'status', '--porcelain'), '', 'tout est commité, fichier nouveau compris')
    // La branche porte le travail : c'est elle qu'un humain mergera.
    assert.equal(sh(repo, 'rev-parse', wt.branch).trim(), sha)
  })

  it('n\'exécute pas un hook que l\'agent aurait écrit dans l\'arbre de travail', async () => {
    const marker = installHook('pre-commit')
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    // L'attaque : l'agent réécrit le hook dans SON worktree, puis attend que le
    // harness commite à la fin de la tâche.
    writeFileSync(join(wt.path, '.husky', 'pre-commit'), `#!/bin/sh\ntouch "${marker}"\n`)
    chmodSync(join(wt.path, '.husky', 'pre-commit'), 0o755)
    writeFileSync(join(wt.path, 'src', 'x.ts'), 'export {}\n')
    assert.ok(await commitAll(wt.path, 'avec hook', agentIdentity('developer')))
    assert.equal(existsSync(marker), false, 'le hook écrit par l\'agent ne doit pas avoir tourné')
  })

  it('ne signe pas, même quand l\'utilisateur signe tous ses commits', async () => {
    // Un programme de signature qui échoue : si `commitAll` tentait de signer,
    // le commit échouerait.
    sh(repo, 'config', 'commit.gpgsign', 'true')
    sh(repo, 'config', 'gpg.program', 'false')
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    writeFileSync(join(wt.path, 'src', 'x.ts'), 'export {}\n')
    assert.ok(await commitAll(wt.path, 'non signé', agentIdentity('developer')))
  })
})

describe('removeWorktree', () => {
  it('refuse de perdre du travail non commité sans forçage, et garde la branche', async () => {
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    writeFileSync(join(wt.path, 'src', 'pas-commite.ts'), 'export {}\n')
    assert.equal((await worktreeState(wt.path)).dirty, 1)

    await assert.rejects(
      removeWorktree({ repoDir: repo, worktreePath: wt.path, worktreesDir }),
      /travail non commité/,
    )
    assert.ok(existsSync(wt.path), 'rien n\'a été retiré')

    assert.equal(await removeWorktree({ repoDir: repo, worktreePath: wt.path, worktreesDir, force: true }), 'removed')
    assert.equal(existsSync(wt.path), false)
    assert.equal((await worktreeState(wt.path)).exists, false)
    assert.ok(sh(repo, 'branch', '--list', wt.branch).includes(wt.branch), 'la branche survit au worktree')
  })

  it('ne supprime jamais rien hors du dossier des worktrees', async () => {
    // Une ligne de base corrompue qui désignerait le dépôt de l'utilisateur.
    for (const target of [repo, worktreesDir, join(worktreesDir, '..', 'ailleurs')]) {
      await assert.rejects(
        removeWorktree({ repoDir: repo, worktreePath: target, worktreesDir, force: true }),
        /pas sous le dossier des worktrees/,
      )
    }
    assert.ok(existsSync(join(repo, 'README.md')), 'le dépôt est intact')
  })

  it('constate un worktree déjà supprimé à la main, et nettoie ses métadonnées', async () => {
    const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir, taskId: TASK_ID })
    rmSync(wt.path, { recursive: true, force: true })
    assert.equal(await removeWorktree({ repoDir: repo, worktreePath: wt.path, worktreesDir }), 'already_gone')
    assert.doesNotMatch(sh(repo, 'worktree', 'list'), /0b9f3c2e/)
  })
})

describe('analyse des sorties de git', () => {
  it('compte une entrée renommée une seule fois', () => {
    assert.equal(countPorcelainEntries(' M a.ts\0R  neuf.ts\0ancien.ts\0?? x\0'), 3)
    assert.equal(countPorcelainEntries(''), 0)
  })

  it('lit --name-status et --numstat en -z, chemins exotiques compris', () => {
    const kinds = parseNameStatus('A\0dossier avec espace/é.ts\0D\0b\tc.ts\0')
    assert.equal(kinds.get('dossier avec espace/é.ts'), 'added')
    assert.equal(kinds.get('b\tc.ts'), 'deleted')
    const stats = parseNumstat('3\t1\ta.ts\0-\t-\timg.png\0')
    assert.deepEqual(stats.get('a.ts'), { additions: 3, deletions: 1 })
    assert.deepEqual(stats.get('img.png'), { additions: null, deletions: null })
  })
})
