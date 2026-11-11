/**
 * @file Chercher sur le web **par le navigateur** : charger la page de
 * résultats d'un moteur public dans la session isolée, et en relever les
 * liens.
 *
 * Pourquoi par le navigateur, et pas par une requête HTTP : les moteurs
 * servent leurs résultats à un navigateur qui exécute leur page, et refusent
 * ou vident la réponse faite à un client nu. Pourquoi pas une API de
 * recherche : elle demanderait une clé de plus ; un serveur MCP de recherche
 * reste possible à côté (Slice 8).
 *
 * Ce que ce module ne fait pas, exprès : **contourner une vérification
 * anti-robot**. Un moteur qui répond par un défi (captcha, « vérification de
 * sécurité ») n'a pas de résultats à relever ; on essaie le moteur suivant, et
 * si aucun ne répond, l'erreur dit ce que chacun a répondu. Le navigateur
 * s'annonce piloté et le reste.
 *
 * Les sélecteurs sont ceux de pages que leurs éditeurs changent sans prévenir.
 * D'où deux moteurs essayés dans l'ordre, et une erreur qui nomme la page
 * reçue plutôt qu'une liste vide : zéro résultat relevé n'est jamais présenté
 * comme « rien trouvé ».
 */
import { BrowserError } from './errors.ts'
import type { BrowserSession } from './session.ts'

/** Un moteur de recherche public, tel que ce module le lit. */
export interface SearchEngine {
  /** Nom court, cité à l'agent et au journal. */
  id: string
  /** Adresse de la page de résultats pour une requête. */
  url(query: string): string
  /** Sélecteur CSS des liens de titre des résultats. */
  link: string
  /** Sélecteur du titre **dans** le lien, quand le lien porte aussi autre chose. */
  title?: string
  /** Sélecteur du conteneur d'un résultat, remonté depuis son lien. */
  container: string
  /** Sélecteur de l'extrait, dans ce conteneur. */
  snippet: string
  /**
   * Rend l'adresse réelle d'un résultat quand le moteur l'enveloppe dans une
   * redirection chez lui ; l'adresse telle quelle par défaut.
   */
  unwrap?(href: string): string
}

/** Un résultat de recherche. Écrit par le moteur et les sites : **non fiable**. */
export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** Ce qu'une recherche a rendu. */
export interface SearchOutcome {
  /** Le moteur qui a répondu. */
  engine: string
  results: SearchResult[]
}

/**
 * Les moteurs essayés, dans l'ordre.
 *
 * Constaté le 2026-11-11 avec le Chromium de Playwright, sur deux requêtes :
 *
 * | Moteur | Sans fenêtre | Avec fenêtre |
 * |---|---|---|
 * | DuckDuckGo | refus (page d'erreur 418) | 10 résultats justes |
 * | Brave Search | captcha | 10 résultats justes |
 * | Bing | 10 résultats **sans rapport avec la requête** | 2 résultats, puis aucun |
 *
 * Bing n'est donc pas dans la liste : une page de résultats faux est pire
 * qu'un refus, l'agent la citerait. Et la recherche n'est utilisable qu'avec
 * une fenêtre — c'est le défaut du daemon (`webBrowser: 'window'`).
 */
export const SEARCH_ENGINES: readonly SearchEngine[] = [
  {
    id: 'duckduckgo.com',
    url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=web`,
    link: 'a[data-testid="result-title-a"]',
    container: 'article',
    snippet: '[data-result="snippet"]',
  },
  {
    id: 'search.brave.com',
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    // Le lien d'un résultat porte aussi le nom et l'adresse du site : le titre
    // est l'un de ses éléments.
    link: 'div.snippet[data-type="web"] a:has(.search-snippet-title)',
    title: '.search-snippet-title',
    container: 'div.snippet',
    snippet: '.generic-snippet',
  },
]

/** L'hôte qu'un moteur fait charger : ce que la politique HTTP juge avant une recherche. */
export function searchEngineHost(engine: SearchEngine): string {
  return new URL(engine.url('x')).hostname
}

/** Nombre maximal de résultats rendus par recherche. */
export const MAX_SEARCH_RESULTS = 10
/** Attente des résultats dans la page, en millisecondes : ils arrivent après le document. */
const RESULTS_WAIT_MS = 8_000

/**
 * Cherche sur le web dans une session ouverte : essaie chaque moteur dans
 * l'ordre, et rend les résultats du premier qui en donne.
 *
 * @param session session de navigateur ouverte ; sa page est remplacée
 * @param query   la requête, telle que l'agent l'a écrite
 * @param engines moteurs à essayer ; {@link SEARCH_ENGINES} par défaut, les
 *                tests passent le leur
 * @param waitMs  attente des résultats dans chaque page ; les tests la raccourcissent
 * @throws {BrowserError} si aucun moteur ne donne de résultat, avec ce que
 *         chacun a répondu — jamais une liste vide qui se lirait « rien trouvé »
 */
export async function searchWeb(
  session: BrowserSession,
  query: string,
  engines: readonly SearchEngine[] = SEARCH_ENGINES,
  waitMs: number = RESULTS_WAIT_MS,
): Promise<SearchOutcome> {
  const failures: string[] = []
  for (const engine of engines) {
    try {
      await session.goto(engine.url(query))
      await session.waitFor(engine.link, waitMs)
      // Le double : une partie des liens relevés est écartée ensuite.
      // Les trois sélecteurs seulement : un moteur porte des fonctions, qui ne
      // se sérialisent pas vers la page — l'évaluation échouait, en silence.
      const links = await session.collect(
        { link: engine.link, title: engine.title, container: engine.container, snippet: engine.snippet },
        MAX_SEARCH_RESULTS * 2,
      )
      const seen = new Set<string>()
      const results: SearchResult[] = []
      for (const link of links) {
        const url = engine.unwrap ? engine.unwrap(link.href) : link.href
        if (!/^https?:\/\//.test(url) || seen.has(url)) continue
        seen.add(url)
        results.push({ title: link.title, url, snippet: link.snippet })
        if (results.length >= MAX_SEARCH_RESULTS) break
      }
      if (results.length > 0) return { engine: engine.id, results }
      const { title } = await session.state()
      failures.push(`${engine.id} returned a page without results (page title: ${JSON.stringify(title.slice(0, 80))})`)
    } catch (e) {
      failures.push(`${engine.id}: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  throw new BrowserError(
    `no search engine returned results. ${failures.join('; ')}. ` +
      'A page without results is usually a bot check, which this browser does not bypass.',
  )
}
