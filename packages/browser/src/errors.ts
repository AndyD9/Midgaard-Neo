/**
 * @file L'erreur du paquet, dans un module qui ne charge pas Playwright : le
 * daemon lit la liste des moteurs de recherche (`search.ts`) dès qu'il juge
 * un appel, bien avant d'ouvrir un navigateur.
 */

/** Un refus de la session, à rendre à l'agent tel quel. En anglais : c'est le modèle qui le lit. */
export class BrowserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserError'
  }
}
