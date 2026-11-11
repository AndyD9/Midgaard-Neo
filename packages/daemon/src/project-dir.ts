/**
 * @file Le dossier de projet d'une tâche : ce qu'un agent aura le droit de lire.
 *
 * Jusqu'à la Slice 5, il venait toujours des `roots` du client MCP, donc d'un
 * dépôt que l'utilisateur avait ouvert dans sa session. Le formulaire « Nouvelle
 * tâche » du dashboard en fait une **source nouvelle** : un chemin tapé à la
 * main, où une faute de frappe ou un `/` de trop ouvrirait toute la machine à
 * la lecture d'un agent (décision 9).
 *
 * Le daemon ne distingue pas ses clients — MCP et dashboard parlent la même
 * API —, la règle s'applique donc à toute tâche qui lit un dossier. Elle ne
 * gêne pas un client MCP : un dépôt ouvert existe, est un dossier, et n'est ni
 * `/` ni le dossier personnel.
 */
import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, parse } from 'node:path'

/**
 * Vérifie et canonicalise un dossier de projet.
 *
 * Quatre règles, chacune pour une raison :
 *
 *  - **absolu** : un chemin relatif serait résolu contre le dossier du daemon,
 *    que personne ne voit ;
 *  - **existant, et un dossier** : sinon la tâche échouerait plus tard, au
 *    premier appel d'outil, après avoir payé un appel de modèle ;
 *  - **ni la racine du système** : la frontière d'intention ne bornerait plus rien ;
 *  - **ni le dossier personnel lui-même** : il contient les clés SSH, les
 *    trousseaux exportés, les `.env` de tous les projets. Un sous-dossier, oui.
 *
 * La comparaison se fait **après** canonicalisation, des deux côtés : sous
 * macOS, `/tmp` est un lien vers `/private/tmp`, et un dossier personnel peut
 * en être un aussi. `realpathSync.native` développe en outre les noms courts
 * 8.3 de Windows, que `realpathSync` laisse tels quels.
 *
 * @param dir  chemin reçu
 * @param home dossier personnel de l'utilisateur, injecté
 *             (`HarnessConfig.userHome`) : un module ne lit pas son environnement
 * @returns le chemin canonique, ou la phrase qui dit pourquoi il est refusé
 */
export function checkProjectDir(dir: string, home: string): { dir: string } | { error: string } {
  if (!dir.trim()) return { error: 'aucun dossier de projet indiqué' }
  if (!isAbsolute(dir)) {
    return { error: `le dossier de projet doit être un chemin absolu : « ${dir} »` }
  }
  let canonical: string
  try {
    canonical = realpathSync.native(dir)
  } catch {
    return { error: `le dossier de projet n'existe pas : « ${dir} »` }
  }
  if (!statSync(canonical).isDirectory()) {
    return { error: `le dossier de projet n'est pas un dossier : « ${dir} »` }
  }
  if (parse(canonical).root === canonical || dirname(canonical) === canonical) {
    return { error: 'la racine du système ne peut pas être un dossier de projet : choisis le dossier du dépôt' }
  }
  let canonicalHome: string | null = null
  try {
    canonicalHome = realpathSync.native(home)
  } catch {
    // Un dossier personnel introuvable ne peut pas être celui qu'on désigne.
  }
  if (canonicalHome !== null && canonical === canonicalHome) {
    return {
      error:
        'le dossier personnel ne peut pas être un dossier de projet : un agent y lirait tout. ' +
        'Choisis le dossier du dépôt',
    }
  }
  return { dir: canonical }
}
