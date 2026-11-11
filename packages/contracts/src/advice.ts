/**
 * @file Forme des commandes que Midgaard conseille à l'utilisateur.
 *
 * Depuis un clone, aucune commande `harness` n'est dans le `PATH` : tout passe
 * par `npm run harness -- …` à la racine du clone. Dans l'application
 * autonome, il n'y a ni clone ni npm : la commande est le lanceur embarqué
 * (`CommandTarget.launcher`). La CLI et le daemon en conseillent tous deux ;
 * la forme vit donc ici, dans le seul paquet que les deux connaissent, au
 * lieu d'être redite dans chacun.
 */

/** Où la commande doit agir. */
export interface CommandTarget {
  /**
   * Racine du clone, quand la commande sera lue **hors** de lui — consigne
   * d'approbation relayée par Claude, erreur affichée au dashboard. Elle passe
   * par `npm --prefix` et non par `cd … &&` : un client qui reformule une
   * consigne peut perdre le `cd`, et la commande échoue alors sans rien dire
   * d'utile (Slice 4, étape 8, leçon n° 31). Omise quand la commande est
   * affichée par la CLI, donc lue depuis le clone.
   */
  repoRoot?: string | undefined
  /**
   * Dossier runtime, quand il n'est pas celui par défaut
   * (`HarnessConfig.homeIsExplicit`). Sans lui, la commande viserait
   * `~/.midgaard` : une approbation y serait introuvable, une clé y serait
   * déposée pour une autre installation. Passé en option (`--home`) plutôt
   * qu'en variable d'environnement, parce que `MIDGAARD_HOME=… npm …` ne
   * s'écrit pas pareil sous zsh, PowerShell et cmd.
   */
  home?: string | null | undefined
  /**
   * Le lanceur de l'application autonome, déjà entre guillemets
   * (`HarnessConfig.launcher`) : un script embarqué qui lance la CLI avec le
   * Node embarqué. Quand il est là, il **remplace** npm — il n'y a pas de
   * clone, et `npm run harness` serait un conseil que personne ne peut lancer.
   * C'est un chemin absolu : la commande se lit de n'importe où, `repoRoot`
   * n'a plus de sens.
   */
  launcher?: string | null | undefined
}

/**
 * Commande `harness` prête à copier.
 *
 * Les chemins sont entre guillemets doubles, ce que zsh, bash, PowerShell et
 * cmd lisent tous de la même façon pour un chemin sans guillemet. Pas
 * `JSON.stringify`, que la commande employait : il double les barres
 * obliques inverses, et un chemin Windows devenait `C:\\Users\\…`.
 *
 * `--home` vient **avant** la commande : après un `--`, comme dans
 * `exec allow -- <commande…>`, la CLI ne lit plus d'option, et un `--home` placé
 * en fin de ligne serait devenu un argument de la commande mise en liste blanche.
 *
 * @param args   arguments de la CLI, par exemple `approve 3808490f-…`
 * @param target où la commande doit agir
 * @returns par exemple `npm --prefix "/x/Midgaard" run harness -- --home "/x/runtime" approve 38…`,
 *          ou, dans l'application autonome, `"/Applications/…/harness" approve 38…`
 */
export function harnessCommand(args: string, target: CommandTarget = {}): string {
  const home = target.home ? ` --home "${quotable(target.home)}"` : ''
  if (target.launcher) return `${target.launcher}${home} ${args}`
  const npm = target.repoRoot ? `npm --prefix "${quotable(target.repoRoot)}" run harness --` : 'npm run harness --'
  return `${npm}${home} ${args}`
}

/**
 * Un chemin qu'on peut mettre entre guillemets doubles : sans séparateur final.
 *
 * Sous Windows, `"C:\depot\"` ne se ferme pas : la barre oblique inverse
 * finale échappe le guillemet, et tout ce qui suit est avalé dans l'argument —
 * npm ne recevait plus de commande et affichait son aide. Constaté en CI
 * (`test:restart`, R8), avec une racine tirée d'une URL de dossier, qui finit
 * toujours par un séparateur. Une racine (`/`, `C:\`) garde le sien.
 */
function quotable(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? path : trimmed
}
