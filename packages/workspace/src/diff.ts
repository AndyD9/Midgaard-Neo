/**
 * @file Ce qu'un agent a changé dans son worktree, depuis le commit de départ.
 *
 * ## Pourquoi un index temporaire
 *
 * Le diff doit couvrir trois choses à la fois : les commits de l'agent, ses
 * modifications non commitées, **et ses fichiers nouveaux**. `git diff <base>`
 * ignore les fichiers non suivis — or un agent qui crée `src/health.ts` produit
 * précisément un fichier non suivi, et un diff qui l'oublie ment sur l'essentiel.
 *
 * La solution habituelle, `git add -N`, modifie l'index du worktree : calculer
 * un diff changerait alors ce que le prochain `git status` de l'agent lui
 * montre. On travaille donc sur une **copie** de l'index (`GIT_INDEX_FILE`) :
 * on y ajoute tout l'arbre de travail, on compare au commit de départ, on jette
 * la copie. Le worktree n'en garde aucune trace — seuls quelques objets Git
 * orphelins, que le ramasse-miettes de `git` collecte.
 *
 * Copier l'index plutôt que repartir de zéro n'est pas un détail : l'index
 * porte les informations de `stat` qui permettent à `git add` de ne pas relire
 * les fichiers inchangés. Sans elles, chaque diff relirait tout le dépôt.
 *
 * ## La copie garde la date de l'index
 *
 * Git juge un fichier inchangé quand sa taille et sa date correspondent à
 * l'index — à la seconde près, selon la plateforme. Un fichier réécrit dans la
 * même seconde que l'index, à taille égale, passerait donc pour intact ; Git
 * s'en garde en relisant le contenu de toute entrée **pas plus ancienne que
 * l'index lui-même** (*racy git*). Une copie ordinaire prend la date du moment
 * de la copie : les entrées paraissent alors plus anciennes qu'elle, la garde
 * de Git ne joue plus, et la modification disparaît du diff. Constaté : un
 * test du dashboard échouait sous charge, et le cas se reproduit cinq fois sur
 * cinq en attendant une seconde avant le diff (docs/SLICE4.md, étape 4). La
 * copie reçoit donc la date de l'original, arrondie **vers le passé** — dans le
 * doute, Git relit davantage, jamais moins.
 */
import { copyFile, mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FileChange, FileChangeKind, WorkspaceDiff } from '@midgaard/contracts'
import { git, gitOk, WorkspaceError } from './git.ts'

/**
 * Taille maximale du patch rendu. Au-delà, il est tronqué **et le dit** : la
 * liste des fichiers et les compteurs restent complets, eux.
 */
export const MAX_PATCH_BYTES = 1024 * 1024

/**
 * Options communes à tous les `git diff` du module. Voir `git.ts`, règle n° 2 :
 * calculer un diff ne lance aucun programme désigné par l'arbre de travail.
 * Les préfixes et `--no-relative` neutralisent les réglages de l'utilisateur
 * (`diff.noprefix`, `diff.relative`) qui changeraient la forme de la sortie.
 */
const DIFF_FLAGS = ['--cached', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative'] as const

/**
 * Calcule le diff d'un worktree contre son commit de départ.
 *
 * @param worktreePath chemin canonique du worktree
 * @param baseCommit   commit de départ, enregistré à la création
 * @throws {WorkspaceError} si le worktree n'est pas lisible par `git`
 */
export async function diffWorktree(
  worktreePath: string,
  baseCommit: string,
  maxPatchBytes = MAX_PATCH_BYTES,
): Promise<WorkspaceDiff> {
  const scratch = await mkdtemp(join(tmpdir(), 'midgaard-index-'))
  try {
    const index = join(scratch, 'index')
    const real = resolve(
      worktreePath,
      (await gitOk(['rev-parse', '--git-path', 'index'], { cwd: worktreePath }, 'lecture de l\'index')).trim(),
    )
    try {
      const original = await stat(real)
      await copyFile(real, index)
      // Voir l'en-tête : sans la date d'origine, Git ne relit plus les fichiers
      // réécrits dans la même seconde que l'index.
      await utimes(index, original.atime, Math.floor(original.mtimeMs) / 1000)
    } catch {
      // Pas d'index (worktree tout neuf, jamais touché) : on part de l'arbre du
      // commit de départ, ce qui donne le même résultat, juste plus lentement.
      await gitOk(['read-tree', baseCommit], { cwd: worktreePath, env: { GIT_INDEX_FILE: index } }, 'préparation du diff')
    }
    const opts = { cwd: worktreePath, env: { GIT_INDEX_FILE: index } }

    await gitOk(['add', '-A'], opts, 'préparation du diff')
    const names = await gitOk(['diff', ...DIFF_FLAGS, '--name-status', '-z', baseCommit], opts, 'calcul du diff')
    const stats = await gitOk(['diff', ...DIFF_FLAGS, '--numstat', '-z', baseCommit], opts, 'calcul du diff')
    const patch = await git(
      ['diff', ...DIFF_FLAGS, '--no-color', '--src-prefix=a/', '--dst-prefix=b/', baseCommit],
      { ...opts, maxOutputBytes: maxPatchBytes },
    )
    if (patch.code !== 0) throw new WorkspaceError(`calcul du patch : ${patch.stderr.trim() || `code ${patch.code}`}`)

    const files = mergeChanges(parseNameStatus(names), parseNumstat(stats))
    return {
      base_commit: baseCommit,
      files,
      additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
      patch: patch.stdout,
      patch_bytes: patch.stdoutBytes,
      patch_truncated: patch.truncated,
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Traduction des lettres de `--name-status`. */
const KINDS: Record<string, FileChangeKind> = { A: 'added', M: 'modified', D: 'deleted', T: 'type_changed' }

/**
 * Analyse `git diff --name-status -z --no-renames` : une lettre, puis un chemin.
 *
 * Sans `--no-renames`, une entrée `R` porterait deux chemins et un score ; on
 * s'en passe volontairement — un renommage apparaît comme une suppression plus
 * un ajout, ce qui est moins élégant mais impossible à mal lire.
 */
export function parseNameStatus(output: string): Map<string, FileChangeKind> {
  const fields = output.split('\0')
  const out = new Map<string, FileChangeKind>()
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const letter = fields[i]!.charAt(0)
    const path = fields[i + 1]!
    if (!path) continue
    out.set(path, KINDS[letter] ?? 'modified')
  }
  return out
}

/** Analyse `git diff --numstat -z --no-renames` : `ajouts\tsuppressions\tchemin`, `-` pour un binaire. */
export function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null }> {
  const out = new Map<string, { additions: number | null; deletions: number | null }>()
  for (const record of output.split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record)
    if (!m) continue
    out.set(m[3]!, {
      additions: m[1] === '-' ? null : Number(m[1]),
      deletions: m[2] === '-' ? null : Number(m[2]),
    })
  }
  return out
}

/** Réunit les deux analyses, triées par chemin pour un affichage stable. */
function mergeChanges(
  kinds: Map<string, FileChangeKind>,
  stats: Map<string, { additions: number | null; deletions: number | null }>,
): FileChange[] {
  return [...kinds.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, kind]) => {
      const s = stats.get(path) ?? { additions: null, deletions: null }
      return { path, kind, additions: s.additions, deletions: s.deletions, binary: s.additions === null }
    })
}
