/**
 * @file Savoir si la page est plus vieille que le daemon qui lui parle.
 * Fonctions pures, sans DOM, testées dans `tests/unit/dashboard-workbench.test.ts`.
 *
 * **Le défaut corrigé.** Une page reste ouverte plus longtemps que le daemon qui
 * l'a servie : la fenêtre desktop surtout, ouverte des jours durant. Quand le
 * daemon est remplacé par une version plus récente, la page se reconnecte avec
 * son **ancien** code, qui reçoit des données qu'il ne connaît pas. Constaté le
 * 2026-11-05 : une fenêtre chargée face au protocole 11 a reçu les événements
 * `browser.*` du protocole 13, sa timeline a levé une erreur, et React a démonté
 * toute l'interface. Il restait un fond sombre, que l'auteur a pris pour un gel.
 *
 * **Le témoin.** Vite nomme le bundle d'après son contenu (`index-<hash>.js`), et
 * le daemon sert `index.html` sans cache. Si le script que désigne l'`index.html`
 * servi n'est plus celui de la page, la page est périmée : elle se recharge.
 * Aucun numéro de version à tenir, et le témoin vaut aussi pour un simple
 * `npm run build` pendant que le daemon tourne.
 */

/**
 * Rend la cible du premier script de module d'un document HTML, telle
 * qu'écrite dans l'attribut `src`.
 *
 * Expression régulière plutôt que `DOMParser` : la fonction tourne aussi sous
 * Node, dans les tests. Les attributs sont pris dans n'importe quel ordre, Vite
 * écrivant `type="module" crossorigin src="…"`.
 *
 * @param html le document, tel que servi
 * @returns l'attribut `src`, ou `null` sans script de module
 */
export function moduleScript(html: string): string | null {
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)
    if (src) return src[1]!
  }
  return null
}

/**
 * Dit si le daemon sert désormais un autre bundle que celui de la page.
 *
 * Dans le doute, **non** : une page qui ne sait pas lire son propre script, ou
 * un `index.html` sans script (le daemon d'un clone sans build sert une page
 * d'aide), ne justifie pas de quitter une page qui marche peut-être.
 *
 * @param own    l'attribut `src` du script de la page en cours
 * @param served le `index.html` que sert le daemon maintenant
 */
export function bundleChanged(own: string | null, served: string): boolean {
  const next = moduleScript(served)
  return own !== null && next !== null && next !== own
}
