/**
 * @file Cycle de vie d'un worktree : inspecter le dépôt d'origine, créer le
 * worktree d'une tâche, y commiter le travail de l'agent, le retirer.
 *
 * Trois règles traversent le module :
 *
 *  - **Le dépôt de l'utilisateur n'est jamais modifié**, hors des métadonnées
 *    que `git worktree` y range lui-même (`.git/worktrees/…`) et de la branche
 *    de la tâche. Pas de checkout, pas de stash, pas de reset.
 *  - **Rien n'est supprimé hors de `worktreesDir`.** Le chemin d'un worktree
 *    vient de la base ; une ligne corrompue ou falsifiée ne doit jamais faire
 *    effacer autre chose. {@link removeWorktree} le vérifie avant tout.
 *  - **Les chemins sont canoniques.** Sous macOS, `/tmp` et bien des dossiers
 *    personnels passent par un lien symbolique : comparer un chemin réel à un
 *    chemin qui ne l'est pas a déjà fait refuser à un agent les fichiers de son
 *    propre projet (docs/SLICE2.md, bogue n° 3).
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { WORKSPACE_BRANCH_PREFIX } from '@midgaard/contracts'
import { WorkspaceError, git, gitOk } from './git.ts'

/** Délai d'un `git worktree add` : c'est un checkout complet, qui peut être long sur un gros dépôt. */
export const CHECKOUT_TIMEOUT_MS = 120_000

/** Ce qu'on sait du dépôt d'origine au moment de la délégation. */
export interface RepositoryInfo {
  /** Racine canonique du dépôt. */
  toplevel: string
  /** Sous-dossier délégué, relatif à la racine, `/` final, ou vide. */
  subdir: string
  /** Commit pointé par HEAD. */
  head: string
  /** Branche courante ; `null` si HEAD est détaché. */
  ref: string | null
  /** Chemins modifiés ou nouveaux non commités — qui ne seront **pas** dans le worktree. */
  dirty: number
}

/**
 * Inspecte le dépôt qui contient `projectDir`.
 *
 * @throws {WorkspaceError} si le dossier n'existe pas, n'est pas dans un dépôt
 *         Git, ou si le dépôt n'a aucun commit — chacun avec une phrase qui dit
 *         quoi faire
 */
export async function inspectRepository(projectDir: string): Promise<RepositoryInfo> {
  let dir: string
  try {
    dir = await realpath(projectDir)
  } catch {
    throw new WorkspaceError(`le dossier du projet n'existe pas : ${projectDir}`)
  }

  const top = await git(['rev-parse', '--show-toplevel', '--show-prefix'], { cwd: dir })
  if (top.code !== 0) {
    throw new WorkspaceError(
      `${dir} n'est pas dans un dépôt Git : un agent écrivant travaille dans un worktree, ` +
        'il lui faut un dépôt (git init, puis un premier commit)',
    )
  }
  const [toplevelRaw = '', prefix = ''] = top.stdout.split('\n')
  const toplevel = await realpath(toplevelRaw.trim())

  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: toplevel })
  if (head.code !== 0) {
    throw new WorkspaceError('le dépôt n\'a encore aucun commit : un worktree part d\'un commit, il en faut au moins un')
  }

  // Code 1 sur un HEAD détaché : c'est une réponse, pas une panne.
  const ref = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: toplevel })
  const status = await gitOk(
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    { cwd: toplevel },
    'lecture de l\'état du dépôt',
  )

  return {
    toplevel,
    subdir: prefix.trim(),
    head: head.stdout.trim(),
    ref: ref.code === 0 ? ref.stdout.trim() : null,
    dirty: countPorcelainEntries(status),
  }
}

/**
 * Compte les entrées d'un `git status --porcelain=v1 -z`.
 *
 * Une entrée renommée ou copiée occupe **deux** champs (nouveau, puis ancien
 * nom) : les compter comme deux annoncerait un fichier modifié de trop.
 */
export function countPorcelainEntries(output: string): number {
  const fields = output.split('\0')
  let n = 0
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    if (f.length < 3) continue
    n++
    if (f[0] === 'R' || f[0] === 'C') i++
  }
  return n
}

/** Un worktree créé pour une tâche. */
export interface CreatedWorktree {
  /** Chemin canonique du worktree. */
  path: string
  /** Racine de travail de l'agent : le worktree, plus le sous-dossier délégué. */
  root: string
  branch: string
  baseCommit: string
  /**
   * Sous-modules du commit de départ, chemins relatifs à la racine du worktree,
   * séparateur `/`. Ils y sont **vides** : voir {@link listSubmodules}.
   */
  submodules: string[]
}

/**
 * Sous-modules d'un commit : les chemins que `git worktree add` laisse vides.
 *
 * Un worktree neuf n'initialise aucun sous-module, et c'est voulu : le faire
 * irait chercher sur le réseau des dépôts que `.gitmodules` désigne — un fichier
 * du projet, donc de quiconque a pu y écrire. Mais un agent qui trouve un
 * dossier vide là où le code attend une bibliothèque tâtonne, et ce qu'il y
 * écrit est **ignoré sans un mot** par `git add -A` : constaté, code de sortie
 * `0`, rien dans `git status`. Le harness doit donc le savoir pour le dire.
 *
 * On lit les chemins dans `.gitmodules` (`git config --blob`, qui ne suit aucun
 * `include`), puis on ne garde que ceux qui sont bien des liens de sous-module
 * (mode `160000`) dans l'arbre du commit — `ls-tree` limité à ces chemins, pour
 * que la sortie reste bornée sur un gros dépôt. Un dépôt imbriqué sans
 * `.gitmodules` n'est pas vu ; `git submodule` ne l'initialiserait pas non plus.
 *
 * @param repoDir dépôt (ou worktree) où lire le commit
 * @param commit  commit dont on lit l'arbre
 * @returns les chemins, relatifs à la racine du dépôt, triés ; vide sans `.gitmodules`
 */
export async function listSubmodules(repoDir: string, commit: string): Promise<string[]> {
  const declared = await git(
    ['config', '-z', '--blob', `${commit}:.gitmodules`, '--get-regexp', String.raw`^submodule\..*\.path$`],
    { cwd: repoDir },
  )
  // Code 1 : aucune clé ; 128 : pas de `.gitmodules`, ou illisible. Dans les
  // deux cas, rien que Git lui-même saurait initialiser.
  if (declared.code !== 0) return []
  // `-z` : chaque entrée est « clé\nvaleur\0 », ce qui tient un chemin à espaces.
  const paths = declared.stdout
    .split('\0')
    .map((entry) => entry.slice(entry.indexOf('\n') + 1))
    .filter((p) => p.length > 0)
  if (!paths.length) return []
  const tree = await gitOk(
    ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', ...paths],
    { cwd: repoDir },
    'lecture des sous-modules',
  )
  return tree
    .split('\0')
    .filter((line) => line.startsWith('160000 '))
    .map((line) => line.slice(line.indexOf('\t') + 1))
    .sort()
}

/**
 * Crée le worktree d'une tâche, sur une branche neuve partant de HEAD.
 *
 * Le worktree part du **dernier commit** : les modifications non commitées de
 * l'utilisateur n'y sont pas. C'est voulu — les recopier mêlerait son travail
 * en cours à celui de l'agent, dans un diff où plus personne ne les distingue —
 * et c'est annoncé par {@link RepositoryInfo.dirty}.
 *
 * @param worktreesDir dossier des worktrees du harness, hors de tout dépôt
 * @throws {WorkspaceError} si `git worktree add` échoue
 */
export async function createWorktree(input: {
  repo: RepositoryInfo
  worktreesDir: string
  taskId: string
}): Promise<CreatedWorktree> {
  const { repo, taskId } = input
  // Un dossier par dépôt, nommé pour être reconnu dans un `ls`, et suffixé par
  // une empreinte du chemin : deux dépôts nommés `api` ne se mélangent pas.
  const repoKey = `${slug(basename(repo.toplevel))}-${createHash('sha256').update(repo.toplevel).digest('hex').slice(0, 8)}`
  await mkdir(join(input.worktreesDir, repoKey), { recursive: true, mode: 0o700 })

  // Huit caractères suffisent à reconnaître une tâche ; en cas de collision —
  // improbable, mais une branche laissée par un essai précédent suffit — on
  // prend l'identifiant entier plutôt que d'écraser quoi que ce soit.
  const short = taskId.slice(0, 8)
  let branch = `${WORKSPACE_BRANCH_PREFIX}${short}`
  let path = join(input.worktreesDir, repoKey, short)
  if ((await branchExists(repo.toplevel, branch)) || existsSync(path)) {
    branch = `${WORKSPACE_BRANCH_PREFIX}${taskId}`
    path = join(input.worktreesDir, repoKey, taskId)
  }

  await gitOk(
    ['worktree', 'add', '-b', branch, path, repo.head],
    { cwd: repo.toplevel, timeoutMs: CHECKOUT_TIMEOUT_MS },
    'création du worktree',
  )
  const canonical = await realpath(path)
  const submodules = await listSubmodules(canonical, repo.head)
  return { path: canonical, root: join(canonical, repo.subdir), branch, baseCommit: repo.head, submodules }
}

/** Vrai si la branche locale existe. */
async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const r = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoDir })
  return r.code === 0
}

/** Nom de dossier sûr dérivé d'un nom de dépôt. */
function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 40) || 'repo'
}

/** Auteur d'un commit fait au nom d'un agent. */
export interface CommitIdentity {
  name: string
  email: string
}

/**
 * Identité des commits d'un agent.
 *
 * **Jamais celle de l'utilisateur.** Un commit signé de son nom attesterait
 * qu'il a écrit ce code ; ce n'est pas le cas, et `git blame` doit le dire dans
 * six mois. Le domaine `.invalid` est réservé (RFC 2606) : l'adresse ne peut
 * appartenir à personne.
 */
export function agentIdentity(agentId: string): CommitIdentity {
  return { name: `Midgaard ${agentId}`, email: `${slug(agentId)}@midgaard.invalid` }
}

/**
 * Commite tout ce que contient le worktree : modifications, suppressions et
 * fichiers nouveaux (hors `.gitignore`).
 *
 * C'est l'acte qui fait d'une branche **le résultat** de la tâche : merger
 * `midgaard/…` suffit ensuite, sans rien recopier à la main.
 *
 * Deux refus délibérés : aucun hook (voir `git.ts`), et **aucune signature** —
 * `commit.gpgsign` de l'utilisateur apposerait sa clé sur du code qu'il n'a pas
 * écrit, ou ouvrirait une invite de phrase secrète que personne ne verrait.
 *
 * @returns le commit créé, ou `null` s'il n'y avait rien à commiter
 * @throws {WorkspaceError} si `git` refuse
 */
export async function commitAll(worktreePath: string, message: string, identity: CommitIdentity): Promise<string | null> {
  await gitOk(['add', '-A'], { cwd: worktreePath }, 'préparation du commit')
  const pending = await git(['diff', '--cached', '--quiet', '--no-ext-diff'], { cwd: worktreePath })
  if (pending.code === 0) return null
  await gitOk(
    ['commit', '--no-verify', '--no-gpg-sign', '--quiet', '-m', message],
    {
      cwd: worktreePath,
      env: {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      },
    },
    'commit du travail de l\'agent',
  )
  return (await gitOk(['rev-parse', 'HEAD'], { cwd: worktreePath }, 'lecture du commit créé')).trim()
}

/** État d'un worktree sur le disque. */
export interface WorktreeState {
  exists: boolean
  /** Chemins modifiés ou nouveaux non commités ; `0` si le worktree n'existe pas. */
  dirty: number
  /** Commit courant du worktree ; `null` s'il n'existe pas. */
  head: string | null
}

/** Lit l'état d'un worktree sans rien modifier. */
export async function worktreeState(worktreePath: string): Promise<WorktreeState> {
  if (!existsSync(worktreePath)) return { exists: false, dirty: 0, head: null }
  const status = await gitOk(
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    { cwd: worktreePath },
    'lecture de l\'état du worktree',
  )
  const head = await gitOk(['rev-parse', 'HEAD'], { cwd: worktreePath }, 'lecture du commit du worktree')
  return { exists: true, dirty: countPorcelainEntries(status), head: head.trim() }
}

/** Issue d'un retrait. */
export type RemoveOutcome = 'removed' | 'already_gone'

/**
 * Retire un worktree. La branche est **conservée** : c'est elle qui porte le
 * travail, et la supprimer est une décision distincte.
 *
 * @param input.worktreesDir dossier des worktrees du harness : tout chemin hors
 *        de lui est refusé **avant** toute opération
 * @param input.force retirer même si le worktree contient du travail non
 *        commité. Sans lui, `git` refuse, et le refus est rendu tel quel : du
 *        travail non commité dans un worktree, c'est du travail que la branche
 *        ne contient pas
 * @throws {WorkspaceError} sur chemin hors du dossier des worktrees, ou refus de `git`
 */
export async function removeWorktree(input: {
  repoDir: string
  worktreePath: string
  worktreesDir: string
  force?: boolean
}): Promise<RemoveOutcome> {
  const base = await realpath(input.worktreesDir).catch(() => input.worktreesDir)
  if (!isStrictlyUnder(base, input.worktreePath)) {
    throw new WorkspaceError(
      `refus de retirer ${input.worktreePath} : ce chemin n'est pas sous le dossier des worktrees (${base})`,
    )
  }

  if (!existsSync(input.worktreePath)) {
    // Le dossier a disparu (supprimé à la main) : il ne reste que les
    // métadonnées dans le dépôt, que `prune` retire. Sans dépôt, rien à faire.
    if (existsSync(input.repoDir)) await git(['worktree', 'prune'], { cwd: input.repoDir })
    return 'already_gone'
  }

  if (!existsSync(input.repoDir)) {
    // Dépôt d'origine supprimé : `git worktree remove` n'a plus de dépôt à qui
    // parler. Le dossier est sous `worktreesDir`, vérifié plus haut ; on ne le
    // supprime que sur demande explicite, puisque rien ne dit s'il est propre.
    if (!input.force) {
      throw new WorkspaceError(
        `le dépôt d'origine ${input.repoDir} n'existe plus : retire le worktree avec l'option de forçage si son contenu est perdu de vue`,
      )
    }
    await rm(input.worktreePath, { recursive: true, force: true })
    return 'removed'
  }

  const args = ['worktree', 'remove', ...(input.force ? ['--force'] : []), input.worktreePath]
  const r = await git(args, { cwd: input.repoDir })
  if (r.code !== 0) {
    const reason = r.stderr.includes('modified or untracked')
      ? 'le worktree contient du travail non commité, que la branche ne contient pas ; force le retrait pour le perdre'
      : r.stderr.trim().split('\n')[0] ?? `git a rendu le code ${r.code}`
    throw new WorkspaceError(`retrait du worktree refusé : ${reason}`)
  }
  return 'removed'
}

/**
 * Vrai si `candidate` est **strictement** sous `base` — jamais `base` lui-même,
 * qui contient les worktrees de tous les dépôts.
 */
function isStrictlyUnder(base: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false
  const rel = relative(base, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..')
}
