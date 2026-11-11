/**
 * @file Découpage d'un patch par fichier, pour l'onglet « Fichiers et diff » du
 * dashboard — éprouvé sur un **vrai** patch, produit par `diffWorktree` sur un
 * dépôt jetable, et non sur un texte recopié.
 *
 * Le piège visé : un chemin contenant une espace rend la ligne
 * `diff --git a/X b/X` ambiguë. Un découpage naïf y rattacherait le patch au
 * mauvais fichier, ou à aucun, et l'humain lirait « patch absent » pour un
 * fichier bien modifié.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createWorktree, diffWorktree, inspectRepository } from '@midgaard/workspace'
import { splitPatch } from '../../apps/dashboard/src/lib/patch.ts'

describe('splitPatch', () => {
  it('rattache chaque morceau à son fichier, chemins à espaces, ajouts et suppressions compris', async () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-patch-')))
    try {
      const repo = join(home, 'depot')
      mkdirSync(join(repo, 'dossier avec espace'), { recursive: true })
      const git = (...a: string[]) =>
        execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@example.org', '-c', 'commit.gpgsign=false', ...a], {
          cwd: repo,
          stdio: 'ignore',
        })
      git('init', '-q', '-b', 'main')
      writeFileSync(join(repo, 'dossier avec espace', 'a b.ts'), 'export const a = 1\n')
      writeFileSync(join(repo, 'ancien.ts'), 'export {}\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'initial')

      const wt = await createWorktree({ repo: await inspectRepository(repo), worktreesDir: join(home, 'wt'), taskId: '22222222-3333-4444-8555-666666666666' })
      writeFileSync(join(wt.path, 'dossier avec espace', 'a b.ts'), 'export const a = 2\n')
      writeFileSync(join(wt.path, 'nouveau.ts'), 'export const n = 1\n')
      rmSync(join(wt.path, 'ancien.ts'))

      const diff = await diffWorktree(wt.path, wt.baseCommit)
      const chunks = splitPatch(diff.patch)
      assert.deepEqual([...chunks.keys()].sort(), diff.files.map((f) => f.path).sort())
      assert.match(chunks.get('dossier avec espace/a b.ts')!, /^\+export const a = 2$/m)
      assert.match(chunks.get('nouveau.ts')!, /^\+export const n = 1$/m)
      assert.match(chunks.get('ancien.ts')!, /^-export \{\}$/m)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rend une table vide pour un patch vide', () => {
    assert.equal(splitPatch('').size, 0)
  })
})
