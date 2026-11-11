/**
 * @file L'installation d'où vient un daemon : son dossier et sa version.
 *
 * Un même dossier runtime (`~/.midgaard`) peut être servi par deux
 * installations — deux clones du dépôt, ou un clone avant et après une montée
 * de version. `PROTOCOL_VERSION` ne les
 * distingue que si le protocole a changé : à protocole égal, un serveur MCP
 * parlait au daemon de l'autre installation, avec son code, et une mise à jour
 * n'agissait qu'après l'arrêt sur inactivité (décision de la Slice 4, étape 6).
 *
 * Le daemon annonce donc son installation dans `/api/health`, et le serveur MCP
 * la compare à celle du daemon qu'il lancerait lui-même : même paquet
 * `@midgaard/daemon`, résolu de la même façon. Les deux calculent l'identité
 * depuis le même fichier, ce qui la rend comparable sans convention de plus.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Identité d'une installation du daemon. */
export interface Installation {
  /**
   * Dossier canonique du paquet `@midgaard/daemon` : `packages/daemon` dans le
   * dépôt, `…/node_modules/@midgaard/daemon` dans le paquet installé. Le
   * `realpath` natif développe les noms courts de Windows (`RUNNER~1`).
   */
  dir: string
  /** Version écrite dans son `package.json` — la version publiée, dans le paquet. */
  version: string
}

/**
 * L'installation de ce code-ci.
 *
 * `src/` et `dist/` sont au même niveau : le dossier du paquet est le parent
 * de celui de ce fichier, qu'on tourne depuis les sources ou depuis le build.
 */
export function installation(): Installation {
  const dir = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)))
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }
  return { dir, version }
}

/** Vrai si deux installations sont la même : même dossier, même version. */
export function sameInstallation(a: Installation, b: Installation): boolean {
  return a.dir === b.dir && a.version === b.version
}
