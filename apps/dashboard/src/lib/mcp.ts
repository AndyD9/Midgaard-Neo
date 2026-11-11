/**
 * @file Les serveurs MCP vus du dashboard (Slice 8) : fonctions pures, sans
 * rendu, éprouvées par `tests/unit/dashboard-mcp.test.ts`.
 *
 * Le dashboard n'importe de `@midgaard/contracts` que des types (son point
 * d'entrée charge `node:os`) : ce qui sert aussi à la CLI est donc recopié ici,
 * et le test vérifie que les deux disent la même chose.
 */
import type { McpCatalogEntry } from '@midgaard/contracts'

/** Séparateur d'un nom d'outil MCP, comme `MCP_NAME_SEPARATOR` du paquet `tools`. */
const SEPARATOR = '__'

/**
 * Le serveur et l'outil d'un nom d'appel, si c'est un outil MCP.
 *
 * @returns `{ server, tool }` pour `rea__open_binary`, `null` pour un outil intégré
 */
export function splitMcpName(name: string): { server: string; tool: string } | null {
  const at = name.indexOf(SEPARATOR)
  if (at <= 0 || at + SEPARATOR.length >= name.length) return null
  return { server: name.slice(0, at), tool: name.slice(at + SEPARATOR.length) }
}

/**
 * Les outils que « Cocher les outils de lecture » propose : ceux que le
 * serveur dit en lecture seule et non destructifs, pas encore libres. La même
 * règle que `mcp allow --read-only` : une **proposition**, que l'humain
 * confirme — les annotations sont celles du serveur, pas une garantie.
 */
export function readOnlyCandidates(tools: readonly McpCatalogEntry[]): McpCatalogEntry[] {
  return tools.filter(
    (t) => t.status !== 'allowed' && t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true,
  )
}

/** Les annotations d'un outil, en clair, telles que le serveur les annonce. */
export function hintsOf(t: Pick<McpCatalogEntry, 'annotations'>): string[] {
  const a = t.annotations ?? {}
  const out: string[] = []
  if (a.readOnlyHint === true) out.push('lecture seule')
  if (a.destructiveHint === true) out.push('destructif')
  if (a.openWorldHint === true) out.push('monde ouvert')
  return out
}

/**
 * L'avertissement montré avant de cocher : le même que celui de la CLI, parce
 * que c'est la même autorisation durable.
 */
export function allowWarning(server: string, tools: readonly string[]): string {
  return (
    `Ces outils de ${server} seront appelés SANS APPROBATION par les agents qui ont ce serveur :\n\n` +
    `${tools.join(', ')}\n\n` +
    'Leur empreinte (nom, description, schéma, annotations) est enregistrée : si le serveur les annonce ' +
    'autrement plus tard, ils redemanderont une approbation à chaque appel.\n\n' +
    'Un outil MCP n’est pas borné au projet : il lit et écrit là où le serveur le permet. Les annotations ' +
    '« lecture seule » sont celles du serveur, pas une garantie.'
  )
}
