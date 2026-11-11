/**
 * @file Forme des commandes que Midgaard conseille à l'utilisateur.
 *
 * Midgaard ne s'installe que depuis un clone : aucune commande `harness` n'est
 * dans le `PATH`, tout passe par `npm run harness -- …` à la racine du clone.
 * La CLI, le daemon et le serveur MCP en conseillent tous ; la forme vit donc
 * ici, dans le seul paquet que les trois connaissent, au lieu d'être redite
 * dans chacun.
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
 * @returns par exemple `npm --prefix "/x/Midgaard" run harness -- --home "/x/runtime" approve 38…`
 */
export function harnessCommand(args: string, target: CommandTarget = {}): string {
  const npm = target.repoRoot ? `npm --prefix "${target.repoRoot}" run harness --` : 'npm run harness --'
  const home = target.home ? ` --home "${target.home}"` : ''
  return `${npm}${home} ${args}`
}
