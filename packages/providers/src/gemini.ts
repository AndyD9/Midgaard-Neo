/**
 * @file Adaptateur Gemini, sur l'API REST `generateContent`.
 *
 * C'est le **second protocole** du harness, et sa raison d'être : il ne
 * ressemble pas au premier. Éprouver l'interface contre deux formes de fil
 * réellement différentes est ce qui garantit qu'elle est une interface et non
 * la forme d'OpenAI sous un autre nom.
 *
 * | | compatible OpenAI | Gemini |
 * |---|---|---|
 * | Rôles | `system`, `user`, `assistant`, `tool` | `user` et `model` seulement |
 * | Consigne système | un message | un champ à part, `systemInstruction` |
 * | Appel d'outil | `tool_calls[].function.arguments`, **chaîne JSON** | `functionCall.args`, **objet déjà désérialisé** |
 * | Retour d'outil | message de rôle `tool`, avec `tool_call_id` | `functionResponse` dans un `Content` de rôle `user`, **sans identifiant** |
 * | Image (Slice 7) | partie `image_url`, URL `data:` | partie `inlineData` du `Content` utilisateur |
 * | Jetons de raisonnement | inclus dans `completion_tokens` | `thoughtsTokenCount`, **en plus** de `candidatesTokenCount` |
 *
 * La dernière ligne est un piège à coût : additionner naïvement
 * `candidatesTokenCount` sous-estime la facture d'un modèle de raisonnement,
 * puisque les jetons de pensée sont facturés comme de la sortie sans y figurer.
 *
 * ⚠️ **Non exécuté contre l'API réelle.** Aucune clé Gemini n'était disponible
 * en Slice 2 : cet adaptateur est écrit d'après la documentation REST et vérifié
 * sur réponses enregistrées. Ce qu'il promet est à reconfirmer le jour où une
 * clé existe — voir `docs/SLICE2.md`.
 */
import type { ConnectionTest, ModelPrice, Usage } from '@midgaard/contracts'
import { costFromTable, emptyUsage, settleCost } from '@midgaard/contracts'
import type {
  CompletionRequest,
  CompletionResponse,
  FinishReason,
  Message,
  ProviderAdapter,
  ToolCallRequest,
} from './adapter.ts'
import { getJson, postJson } from './http.ts'

/** Racine de l'API Gemini. `v1beta` porte les appels d'outils. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/** Ce qu'il faut pour construire un adaptateur Gemini. */
export interface GeminiAdapterOptions {
  id: string
  model: string
  apiKey: string
  /** Racine de l'API ; surchargeable pour les tests sur réponses enregistrées. */
  baseUrl?: string
  webSearch: boolean
  redact: (text: string) => string
  price: ModelPrice | undefined
}

// --- Formes du fil ---------------------------------------------------------

interface WirePart {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
  /** Une image jointe (Slice 7), en base64. */
  inlineData?: { mimeType: string; data: string }
}

interface WireResponse {
  candidates?: { content?: { parts?: WirePart[] }; finishReason?: string }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    cachedContentTokenCount?: number
    totalTokenCount?: number
  }
}

interface WireModelList {
  models?: { name?: string }[]
}

/** Construit un adaptateur Gemini. */
export function createGeminiAdapter(options: GeminiAdapterOptions): ProviderAdapter {
  const base = (options.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '')
  // La clé passe par un en-tête, jamais par la chaîne de requête : une URL
  // atterrit dans les journaux de tout ce qu'elle traverse (§5 du plan), et la
  // documentation de Gemini propose les deux.
  const headers = { 'x-goog-api-key': options.apiKey }

  return {
    id: options.id,
    preset: 'gemini',
    model: options.model,
    // Faux, et c'est délibéré : voir `searchTool` ci-dessous.
    supportsWebSearch: false,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const system = request.messages.find((m) => m.role === 'system')
      const body: Record<string, unknown> = {
        contents: toContents(request.messages),
        generationConfig: { maxOutputTokens: request.maxOutputTokens },
      }
      if (system) body.systemInstruction = { parts: [{ text: system.content }] }

      const tools = buildTools(request)
      if (tools.length > 0) {
        body.tools = tools
        body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
      }

      const wire = await postJson<WireResponse>({
        url: `${base}/models/${encodeURIComponent(options.model)}:generateContent`,
        headers,
        body,
        signal: request.signal,
        provider: options.id,
        redact: options.redact,
      })

      const parts = wire.candidates?.[0]?.content?.parts ?? []
      const toolCalls = parts
        .filter((p): p is { functionCall: { name: string; args?: Record<string, unknown> } } =>
          typeof p.functionCall?.name === 'string',
        )
        .map(toToolCall)

      return {
        text: parts.map((p) => p.text ?? '').join(''),
        toolCalls,
        usage: measure(wire, options.price),
        citations: [],
        // Gemini ne dit pas `tool_calls` dans `finishReason` : il rend `STOP`
        // même quand la réponse porte un appel d'outil. On le déduit du contenu,
        // sinon la boucle croirait la tâche finie à chaque appel d'outil.
        finishReason: toolCalls.length > 0 ? 'tool_calls' : normalizeFinish(wire.candidates?.[0]?.finishReason),
      }
    },

    async testConnection(signal): Promise<ConnectionTest> {
      const started = Date.now()
      try {
        const list = await getJson<WireModelList>({
          url: `${base}/models`,
          headers,
          signal,
          provider: options.id,
          redact: options.redact,
        })
        // Gemini préfixe ses identifiants de `models/` ; on compare sur la
        // forme courte, celle que l'utilisateur saisit.
        const models = (list.models ?? [])
          .map((m) => m.name?.replace(/^models\//, ''))
          .filter((id): id is string => typeof id === 'string')
        const known = models.includes(options.model)
        return {
          ok: true,
          detail: known
            ? `${models.length} modèle(s) disponibles, dont « ${options.model} »`
            : `${models.length} modèle(s) disponibles, mais « ${options.model} » n'en fait pas partie`,
          at: new Date().toISOString(),
          latency_ms: Date.now() - started,
          models: models.slice(0, 200),
        }
      } catch (e) {
        return {
          ok: false,
          detail: options.redact((e as Error).message),
          at: new Date().toISOString(),
          latency_ms: Date.now() - started,
          models: [],
        }
      }
    },
  }

  /**
   * Assemble le tableau `tools`.
   *
   * **La recherche web de Gemini n'est pas activée, et c'est un refus motivé.**
   * Le grounding s'active par une entrée `google_search` dans le même tableau
   * `tools` que les `functionDeclarations`. Or la documentation ne dit nulle
   * part que les deux cohabitent, et le Researcher a besoin de ses fonctions —
   * à commencer par `submit_result`, sans lequel aucune tâche ne peut se
   * terminer. Envoyer les deux au jugé, c'est risquer un 400 à chaque itération,
   * ou pire : un grounding silencieusement ignoré dont on facturerait quand même
   * l'illusion à l'utilisateur.
   *
   * Le crochet est écrit — le code ci-dessous sait produire l'entrée — mais il
   * n'est franchi que sans aucune fonction déclarée, cas qui ne se présente pas
   * dans la boucle actuelle. À rouvrir avec une clé Gemini en main.
   */
  function buildTools(request: CompletionRequest): Record<string, unknown>[] {
    const tools: Record<string, unknown>[] = []
    if (request.tools.length > 0) {
      tools.push({
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      })
    } else if (request.webSearch && options.webSearch) {
      tools.push({ google_search: {} })
    }
    return tools
  }
}

/**
 * Traduit la conversation vers `contents`.
 *
 * Trois adaptations imposées par la forme du fil :
 *  - la consigne système **sort** de la conversation (elle part dans
 *    `systemInstruction`) ;
 *  - `assistant` devient `model` ;
 *  - un retour d'outil devient une `functionResponse` portée par un `Content` de
 *    rôle `user`. Gemini n'a pas d'identifiant d'appel : l'appariement se fait
 *    sur le **nom** de la fonction et sur l'ordre. C'est plus fragile que
 *    l'identifiant d'OpenAI, et c'est pourquoi la boucle conserve l'ordre des
 *    résultats tel que le modèle a demandé les appels.
 */
function toContents(messages: Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') {
      // Une image est une partie de plus du même `Content`, à côté du texte.
      const parts: WirePart[] = message.content ? [{ text: message.content }] : []
      for (const image of message.images ?? []) parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } })
      out.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] })
      continue
    }
    if (message.role === 'assistant') {
      const parts: WirePart[] = []
      if (message.content) parts.push({ text: message.content })
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: safeParse(call.argumentsJson) } })
      }
      // Un `Content` sans partie est refusé : un assistant muet qui n'a rien
      // demandé ne doit simplement pas figurer dans l'historique.
      if (parts.length > 0) out.push({ role: 'model', parts })
      continue
    }
    out.push({
      role: 'user',
      parts: [{ functionResponse: { name: message.name, response: { result: message.content } } }],
    })
  }
  return out
}

function toToolCall(part: { functionCall: { name: string; args?: Record<string, unknown> } }): ToolCallRequest {
  return {
    // Gemini ne rend pas d'identifiant d'appel : on en fabrique un, stable le
    // temps de l'itération, pour que le journal et la boucle puissent désigner
    // cet appel-là sans ambiguïté.
    id: `gemini-${part.functionCall.name}-${Math.random().toString(36).slice(2, 10)}`,
    name: part.functionCall.name,
    argumentsJson: JSON.stringify(part.functionCall.args ?? {}),
  }
}

function normalizeFinish(reason: string | undefined): FinishReason {
  if (reason === 'STOP') return 'stop'
  if (reason === 'MAX_TOKENS') return 'length'
  return reason ? 'other' : 'stop'
}

/** Désérialise des arguments sans jamais lever : un JSON invalide vaut un objet vide. */
function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Mesure la consommation d'un appel Gemini.
 *
 * **Le point qui coûte cher si on le rate** : `thoughtsTokenCount` n'est **pas**
 * compris dans `candidatesTokenCount`, alors que Google le facture au tarif de
 * sortie. `output_tokens` additionne donc les deux, et `reasoning_tokens` garde
 * la part de pensée pour que l'interface puisse l'afficher — sans la facturer
 * deux fois, puisque le calcul ne lit que `output_tokens`.
 *
 * Gemini n'annonce aucun coût : `cost_usd_reported` reste `null` et le montant
 * affiché est une estimation, ce que `cost_source` dit explicitement.
 */
function measure(wire: WireResponse, price: ModelPrice | undefined): Usage {
  const m = wire.usageMetadata ?? {}
  const thoughts = m.thoughtsTokenCount ?? 0
  const base: Usage = {
    ...emptyUsage(),
    model_calls: 1,
    input_tokens: m.promptTokenCount ?? 0,
    output_tokens: (m.candidatesTokenCount ?? 0) + thoughts,
    reasoning_tokens: thoughts,
    cached_tokens: m.cachedContentTokenCount ?? 0,
    web_searches: 0,
  }
  const estimated = costFromTable(base, price)
  return { ...base, ...settleCost(estimated, null), cost_usd_estimated: estimated, cost_usd_reported: null }
}
