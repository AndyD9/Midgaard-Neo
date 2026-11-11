/**
 * @file Adaptateur des endpoints **compatibles OpenAI** : OpenAI lui-même,
 * Venice.ai, et tout service qui expose `POST /chat/completions`.
 *
 * ## Un adaptateur, trois endpoints
 *
 * Le plan prévoyait « un adaptateur OpenAI ». La Slice 2 a constaté que Venice
 * expose la même API — mêmes `messages`, mêmes `tools`, mêmes `tool_calls`,
 * même `finish_reason`. Venice n'est donc pas un adaptateur de plus : c'est le
 * même, avec une autre `base_url` et un objet d'extension.
 *
 * Les différences qui restent sont traitées ici, et nulle part ailleurs :
 *
 * | | OpenAI | Venice |
 * |---|---|---|
 * | Jetons de sortie | `max_completion_tokens` | `max_tokens` |
 * | Recherche web | outil à part, non câblé | `venice_parameters.enable_web_search` |
 * | Coût | non annoncé → estimé | objet `cost.usd` → **la facture** |
 * | Citations | — | `venice_parameters.web_search_citations` |
 * | Images (Slice 7) | `image_url` en URL `data:` | idem |
 * | Capacité « vision » | non publiée → inconnue | `model_spec.capabilities.supportsVision` |
 */
import type { ConnectionTest, ModelPrice, ProviderPreset, Usage } from '@midgaard/contracts'
import { addUsage, costFromTable, emptyUsage, settleCost } from '@midgaard/contracts'
import type {
  CompletionRequest,
  CompletionResponse,
  FinishReason,
  Message,
  ModelCapabilities,
  ProviderAdapter,
  ToolCallRequest,
} from './adapter.ts'
import { getJson, postJson } from './http.ts'

/** Ce qu'il faut pour construire un adaptateur compatible OpenAI. */
export interface OpenAiAdapterOptions {
  id: string
  preset: ProviderPreset
  model: string
  /** Sans barre oblique finale, par exemple `https://api.venice.ai/api/v1`. */
  baseUrl: string
  apiKey: string
  /** Vrai si la recherche web native doit être proposée à la boucle. */
  webSearch: boolean
  /** Expurgation appliquée à tout message d'erreur sortant. */
  redact: (text: string) => string
  /** Tarif du modèle, ou `undefined` s'il est inconnu — auquel cas rien n'est inventé. */
  price: ModelPrice | undefined
  /**
   * Chemin d'un point d'entrée qui **exige réellement la clé**, pour que le
   * « Test connection » prouve quelque chose. `null` quand `/models` suffit.
   *
   * Voir {@link AUTH_PROBE} : ce n'est pas une précaution théorique.
   */
  authProbePath?: string | null
}

/**
 * Point d'entrée authentifié par préréglage.
 *
 * **Mesuré, et c'est tout l'intérêt.** `GET /models` de Venice répond `200`
 * **sans aucune clé** — vérifié à la main, deux fois, avec et sans en-tête. Un
 * test de connexion qui s'y fierait annoncerait « joignable » à quelqu'un dont
 * la clé est fausse, et l'erreur n'apparaîtrait qu'à la première tâche, loin de
 * sa cause. C'est exactement le défaut n° 1 de la Slice 0 sous une autre forme :
 * affirmer que quelque chose marche sans l'avoir constaté.
 *
 * `/api_keys/rate_limits` rend `401 Authentication failed` sur une clé invalide.
 * Chez OpenAI, `/models` exige la clé : aucune sonde supplémentaire n'est utile.
 */
export const AUTH_PROBE: Readonly<Record<string, string | null>> = Object.freeze({
  venice: '/api_keys/rate_limits',
  openai: null,
  custom: null,
})

// --- Formes du fil ---------------------------------------------------------

interface WireToolCall {
  id: string
  type?: string
  function: { name: string; arguments: string }
}

interface WireResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: WireToolCall[] }
    finish_reason?: string
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
    prompt_tokens_details?: { cached_tokens?: number }
  }
  /** Propre à Venice : ce que l'appel a réellement coûté. */
  cost?: { usd?: number; diem?: number }
  venice_parameters?: {
    web_search_citations?: { title?: string; url?: string; content?: string; date?: string }[]
  }
}

interface WireModelList {
  data?: { id?: string }[]
}

/** Réponse de la sonde authentifiée. Les soldes sont facultatifs et varient selon le fournisseur. */
interface WireKeyInfo {
  data?: { balances?: Record<string, number> }
  balances?: Record<string, number>
}

/**
 * Résume les soldes rendus par la sonde, s'il y en a.
 *
 * Utile au-delà du test : une tâche qui échouera en `402 INSUFFICIENT_BALANCE`
 * vaut mieux d'être annoncée ici que découverte au milieu d'une délégation.
 */
function describeBalances(info: WireKeyInfo): string {
  const balances = info.data?.balances ?? info.balances
  if (!balances) return ' · clé acceptée'
  const parts = Object.entries(balances)
    .filter(([, value]) => typeof value === 'number')
    .map(([name, value]) => `${name} ${value}`)
  return parts.length ? ` · clé acceptée, solde ${parts.join(', ')}` : ' · clé acceptée'
}

/**
 * Construit un adaptateur compatible OpenAI.
 *
 * @example
 * const adapter = createOpenAiAdapter({
 *   id: 'venice', preset: 'venice', model: 'deepseek-v4-flash-0731',
 *   baseUrl: 'https://api.venice.ai/api/v1', apiKey, webSearch: true, redact, price,
 * })
 */
export function createOpenAiAdapter(options: OpenAiAdapterOptions): ProviderAdapter {
  const base = options.baseUrl.replace(/\/+$/, '')
  const headers = { authorization: `Bearer ${options.apiKey}` }
  // Seule Venice sait chercher sur le web sans outil tiers. OpenAI a bien un
  // outil `web_search`, mais sur l'API Responses : il reste à câbler, et
  // l'annoncer disponible d'ici serait annoncer ce qui n'existe pas.
  const nativeSearch = options.preset === 'venice'

  return {
    id: options.id,
    preset: options.preset,
    model: options.model,
    supportsWebSearch: nativeSearch && options.webSearch,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const body: Record<string, unknown> = {
        model: options.model,
        messages: request.messages.map(toWireMessage),
      }
      // Deux noms pour la même chose : les modèles récents d'OpenAI ont
      // remplacé `max_tokens`, que Venice continue d'attendre. Et Venice refuse
      // en 400 tout champ de premier niveau inconnu : on n'envoie pas les deux.
      if (options.preset === 'openai') body.max_completion_tokens = request.maxOutputTokens
      else body.max_tokens = request.maxOutputTokens

      if (request.tools.length > 0) {
        body.tools = request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
        body.tool_choice = 'auto'
      }

      if (nativeSearch) {
        body.venice_parameters = {
          // `auto` et non `on` : forcer une recherche à chaque appel facturerait
          // 0,01 $ même pour une itération qui ne fait que relire un résultat
          // d'outil. Le modèle décide, et le compteur suit.
          enable_web_search: request.webSearch && options.webSearch ? 'auto' : 'off',
          // Les citations arrivent structurées (titre, URL) : c'est ce qui permet
          // de les encadrer proprement plutôt que d'extraire des URL d'un texte.
          enable_web_citations: true,
          // Les blocs de raisonnement n'ont pas à polluer le texte rendu : ils
          // sont déjà comptés à part dans l'usage.
          strip_thinking_response: true,
        }
      }

      const wire = await postJson<WireResponse>({
        url: `${base}/chat/completions`,
        headers,
        body,
        signal: request.signal,
        provider: options.id,
        redact: options.redact,
      })

      const choice = wire.choices?.[0]
      const citations = (wire.venice_parameters?.web_search_citations ?? [])
        .filter((c): c is { title?: string; url: string } => typeof c.url === 'string')
        .map((c) => ({ title: c.title ?? c.url, url: c.url }))

      const usage = measure(wire, citations.length, options.price)

      return {
        text: choice?.message?.content ?? '',
        toolCalls: (choice?.message?.tool_calls ?? []).map(toToolCall),
        usage,
        citations,
        finishReason: normalizeFinish(choice?.finish_reason),
      }
    },

    /**
     * « Test connection » en deux temps, et aucun jeton facturé.
     *
     *  1. `GET /models` : l'endpoint répond, et le modèle configuré y existe ;
     *  2. une sonde **authentifiée** ({@link AUTH_PROBE}), là où `/models` est
     *     public. Sans elle, le test réussirait avec une clé fausse.
     *
     * Un appel de complétion prouverait tout d'un coup — en facturant des jetons
     * à chaque test, et en demandant un modèle qui marche pour tester une clé.
     */
    async testConnection(signal): Promise<ConnectionTest> {
      const started = Date.now()
      const fail = (detail: string): ConnectionTest => ({
        ok: false,
        detail,
        at: new Date().toISOString(),
        latency_ms: Date.now() - started,
        models: [],
      })

      let models: string[]
      try {
        const list = await getJson<WireModelList>({
          url: `${base}/models`,
          headers,
          signal,
          provider: options.id,
          redact: options.redact,
        })
        models = (list.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
      } catch (e) {
        return fail(options.redact((e as Error).message))
      }

      const probePath = options.authProbePath ?? AUTH_PROBE[options.preset] ?? null
      let credit = ''
      if (probePath) {
        try {
          const probe = await getJson<WireKeyInfo>({
            url: `${base}${probePath}`,
            headers,
            signal,
            provider: options.id,
            redact: options.redact,
          })
          credit = describeBalances(probe)
        } catch (e) {
          const status = (e as { status?: number | null }).status
          if (status === 401 || status === 403) return fail('clé refusée par le fournisseur (401)')
          // Une sonde indisponible pour une autre raison n'invalide pas le test :
          // on le dit, plutôt que de prétendre que la clé est bonne ou mauvaise.
          credit = ' · clé non vérifiée (sonde indisponible)'
        }
      }

      const known = models.includes(options.model)
      return {
        ok: true,
        detail:
          (known
            ? `${models.length} modèle(s) disponibles, dont « ${options.model} »`
            : `${models.length} modèle(s) disponibles, mais « ${options.model} » n'en fait pas partie`) + credit,
        at: new Date().toISOString(),
        latency_ms: Date.now() - started,
        models: models.slice(0, 200),
      }
    },

    // Seul Venice publie la capacité de ses modèles. OpenAI et un endpoint
    // `custom` ne la publient pas : on ne la devine pas d'après le nom.
    async capabilities(signal): Promise<ModelCapabilities> {
      if (options.preset !== 'venice') return { vision: null, source: 'unknown' }
      return veniceCapabilities(base, options.model, options.apiKey, options.redact, signal)
    },
  }
}

/**
 * Traduit un message neutre vers la forme du fil.
 *
 * Un message d'assistant portant des appels d'outils doit être **renvoyé tel
 * quel** au tour suivant, avec ses `tool_calls` : sans eux, l'API refuse les
 * messages de rôle `tool` qui suivent, faute de savoir à quoi ils répondent.
 */
function toWireMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content || null,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.argumentsJson },
              })),
            }
          : {}),
      }
    case 'tool':
      return { role: 'tool', tool_call_id: message.callId, content: message.content }
    case 'user':
      // Une image se joint par une URL `data:` : l'API n'a pas d'autre forme
      // pour des octets, et une URL externe ferait télécharger l'image par le
      // fournisseur — hors de notre vue, et la page d'origine le saurait.
      if (message.images?.length) {
        return {
          role: 'user',
          content: [
            ...(message.content ? [{ type: 'text', text: message.content }] : []),
            ...message.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } })),
          ],
        }
      }
      return { role: 'user', content: message.content }
    default:
      return { role: message.role, content: message.content }
  }
}

/**
 * Durée de validité du catalogue lu chez Venice. Une heure : la capacité d'un
 * modèle ne change pas d'une tâche à l'autre, et relire le catalogue à chaque
 * tâche ajouterait un aller-retour réseau à chacune.
 */
export const CATALOG_TTL_MS = 60 * 60 * 1000

/** Catalogues lus, par URL de base : la date de lecture et la capacité de chaque modèle. */
const catalogs = new Map<string, { at: number; vision: Map<string, boolean> }>()

/** Ce que rend `GET /models` de Venice, réduit à ce qu'on en lit. */
interface VeniceCatalog {
  data?: { id?: string; model_spec?: { capabilities?: { supportsVision?: boolean } } }[]
}

/**
 * La capacité « vision » d'un modèle Venice, lue dans son catalogue public.
 *
 * Un modèle absent du catalogue, ou un catalogue illisible, rend « inconnu »
 * plutôt que « non » : on ne sait pas, et le dire est la seule réponse juste.
 */
async function veniceCapabilities(
  base: string,
  model: string,
  apiKey: string,
  redact: (t: string) => string,
  signal?: AbortSignal,
): Promise<ModelCapabilities> {
  let catalog = catalogs.get(base)
  if (!catalog || Date.now() - catalog.at > CATALOG_TTL_MS) {
    try {
      const list = await getJson<VeniceCatalog>({
        url: `${base}/models?type=text`,
        headers: { authorization: `Bearer ${apiKey}` },
        signal,
        provider: 'venice',
        redact,
      })
      const vision = new Map<string, boolean>()
      for (const m of list.data ?? []) {
        const flag = m.model_spec?.capabilities?.supportsVision
        if (m.id && typeof flag === 'boolean') vision.set(m.id, flag)
      }
      catalog = { at: Date.now(), vision }
      catalogs.set(base, catalog)
    } catch {
      return { vision: null, source: 'unknown' }
    }
  }
  const flag = catalog.vision.get(model)
  return flag === undefined ? { vision: null, source: 'unknown' } : { vision: flag, source: 'catalog' }
}

/** Vide le cache des catalogues : pour les tests, qui changent de catalogue d'un cas à l'autre. */
export function clearCatalogCache(): void {
  catalogs.clear()
}

function toToolCall(call: WireToolCall): ToolCallRequest {
  return { id: call.id, name: call.function.name, argumentsJson: call.function.arguments || '{}' }
}

/** Traduit `finish_reason` vers le vocabulaire neutre de la boucle. */
function normalizeFinish(reason: string | undefined): FinishReason {
  if (reason === 'stop') return 'stop'
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_calls'
  if (reason === 'length') return 'length'
  return 'other'
}

/**
 * Mesure la consommation d'un appel, et arbitre son coût.
 *
 * C'est ici que se joue le livrable « le coût affiché correspond à la facture » :
 * Venice renvoie `cost.usd`, donc on garde **son** chiffre et on note le nôtre à
 * côté. L'écart entre les deux est ce qui révèle une table de tarifs périmée ;
 * sans les deux, personne ne s'apercevrait jamais de la dérive.
 */
function measure(wire: WireResponse, searches: number, price: ModelPrice | undefined): Usage {
  const u = wire.usage ?? {}
  const base: Usage = {
    ...emptyUsage(),
    model_calls: 1,
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    web_searches: searches > 0 ? 1 : 0,
  }
  const estimated = costFromTable(base, price)
  const reported = typeof wire.cost?.usd === 'number' ? wire.cost.usd : null
  return { ...base, ...settleCost(estimated, reported), cost_usd_estimated: estimated, cost_usd_reported: reported }
}

/** Cumul de consommations, réexporté pour la boucle. */
export { addUsage }
