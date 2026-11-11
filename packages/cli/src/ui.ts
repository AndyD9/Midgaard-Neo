/**
 * @file Mise en forme du terminal.
 *
 * Les couleurs ne sont émises que si la sortie est un terminal et que
 * `NO_COLOR` est absent : la sortie de `harness status` doit rester lisible
 * quand elle est redirigée dans un fichier ou un tube.
 */
import { harnessCommand } from '@midgaard/contracts'
const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR

const wrap = (code: string) => (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s)

export const bold = wrap('1')
export const dim = wrap('2')
export const red = wrap('31')
export const green = wrap('32')
export const yellow = wrap('33')
export const blue = wrap('36')

/** Pastille d'état d'un contrôle de `doctor`. */
export const mark = { ok: () => green('✔'), warn: () => yellow('!'), fail: () => red('✘') }

/** Couleur associée à un statut de tâche : vert si tout va bien, jaune si ça attend, rouge sinon. */
export function colorStatus(status: string): string {
  if (status === 'completed') return green(status)
  if (status === 'waiting_approval' || status === 'waiting_input' || status === 'cancel_requested') {
    return yellow(status)
  }
  if (['failed', 'cancelled', 'timed_out', 'budget_exceeded', 'interrupted'].includes(status)) return red(status)
  return blue(status)
}

/** Durée lisible : `1,4 s`, `3 min 12 s`. */
export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`
  const min = Math.floor(ms / 60_000)
  return `${min} min ${Math.round((ms % 60_000) / 1000)} s`
}

/**
 * Une commande `harness` telle que l'utilisateur peut la taper.
 *
 * Midgaard ne s'installe que depuis un clone du dépôt (la distribution npm a
 * été abandonnée, docs/SLICE4.md) : aucun binaire `harness` n'est dans le
 * `PATH`, la commande passe par npm. Tous les conseils passent par ici, pour
 * qu'aucun ne cite une commande qui n'existe pas — c'était le cas de quatre
 * conseils de `doctor` avant qu'ils n'y passent (Slice 4, étape 7).
 *
 * La CLI est lancée depuis le clone, d'où `npm run` sans `--prefix`. Mais si
 * elle vise un autre dossier runtime que `~/.midgaard`, ses conseils le
 * redisent (`--home`) : sans lui, `providers add` aurait déclaré la clé dans une
 * autre installation (Slice 4, étape 8). La forme est celle de
 * `harnessCommand`, que le daemon emploie aussi.
 *
 * @param args la commande, sans `harness`, par exemple `providers add venice`
 */
export function cmd(args: string): string {
  return harnessCommand(args, { home: adviceHome })
}

/** Dossier runtime que les conseils redisent ; posé une fois par `main.ts`. */
let adviceHome: string | null = null

/**
 * Fixe le dossier runtime que {@link cmd} ajoute aux commandes conseillées.
 *
 * Un réglage de module plutôt qu'un paramètre de plus : `cmd()` a une vingtaine
 * d'appelants, qui n'ont pas tous la configuration sous la main. Seul
 * `main.ts`, qui lit l'environnement, l'appelle — la règle « configuration
 * injectée, jamais lue au chargement » tient.
 *
 * @param home dossier désigné (`config.homeIsExplicit`), ou `null` pour `~/.midgaard`
 */
export function setAdviceHome(home: string | null): void {
  adviceHome = home
}

/** Que faire quand le dashboard compilé manque : le compiler, depuis le dépôt. */
export const buildAdvice = 'npm run build'
