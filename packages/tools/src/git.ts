/**
 * @file `git_diff` : ce que l'agent a changé dans son worktree depuis le début
 * de la tâche.
 *
 * C'est le seul accès à Git que reçoit un agent, et il est en lecture. La
 * Slice 3 laissait la question ouverte (docs/SLICE3.md) ; elle est tranchée
 * ainsi, pour trois raisons :
 *
 *  - **le commit est un acte du harness**, fait à `submit_result` : un agent
 *    qui commite lui-même produirait une histoire que personne ne relit, et la
 *    fin de tâche cesserait d'être le seul moment où la branche bouge ;
 *  - **`status` et `log` n'apprennent rien de plus** que ce diff, qui couvre
 *    commits, modifications et fichiers nouveaux ;
 *  - **chaque sous-commande Git est une surface** — `git -c`, `--upload-pack`,
 *    `--output`, les alias de la configuration. Un outil `git` à arguments
 *    libres demanderait de les filtrer tous ; un outil qui n'en prend aucun
 *    n'a rien à filtrer.
 *
 * Le diff vient de `@midgaard/workspace`, qui ne lance aucun programme désigné
 * par l'arbre de travail (hooks, pilotes de diff, conversions de texte).
 */
import { z } from 'zod'
import type { ToolResult } from '@midgaard/contracts'
import { diffWorktree } from '@midgaard/workspace'
import { MAX_TOOL_RESULT_BYTES, ToolError, truncate, type Tool } from './types.ts'

const diffSchema = z.object({
  stat_only: z
    .boolean()
    .default(false)
    .describe('Only list changed files with line counts, without the patch. Cheaper; use it first.'),
})

/** Diff du worktree contre son commit de départ. */
export const gitDiffTool: Tool<z.infer<typeof diffSchema>> = {
  name: 'git_diff',
  description:
    'Show what you changed in your workspace since the task started: modified, deleted and NEW files, ' +
    'committed or not. Use stat_only first on large changes. This is your only git access: the harness ' +
    'commits your work itself when you call submit_result.',
  schema: diffSchema,
  policy: (_args, ctx) =>
    ctx.workspace
      ? { decision: 'allow', reason: 'lecture du worktree de la tâche' }
      : { decision: 'deny', reason: 'this agent has no workspace, so there is no diff to show' },

  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.workspace) throw new ToolError('this agent has no workspace')
    // Le patch est plafonné à ce que le modèle peut recevoir : inutile de
    // demander à `git` un mégaoctet pour en rendre soixante kilo-octets.
    const diff = await diffWorktree(ctx.workspace.path, ctx.workspace.baseCommit, MAX_TOOL_RESULT_BYTES)
    if (diff.files.length === 0) {
      return { content: 'No changes yet.', bytes: 0, summary: 'aucun changement', untrusted: false }
    }
    const lines = diff.files.map((f) =>
      f.binary ? `${f.kind.padEnd(9)} ${f.path} (binary)` : `${f.kind.padEnd(9)} ${f.path} +${f.additions} -${f.deletions}`,
    )
    const header = `${diff.files.length} file(s) changed, +${diff.additions} -${diff.deletions}\n${lines.join('\n')}`
    const body = args.stat_only
      ? header
      : `${header}\n\n${diff.patch}${diff.patch_truncated ? `\n[…patch truncated: ${diff.patch_bytes} bytes in total]` : ''}`
    const { text, bytes } = truncate(body)
    return {
      content: text,
      bytes,
      summary: `${diff.files.length} fichier(s), +${diff.additions} -${diff.deletions}`,
      untrusted: false,
    }
  },
}
