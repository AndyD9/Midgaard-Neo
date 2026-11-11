/**
 * @file Accès à l'API du daemon depuis le navigateur.
 *
 * Le dashboard n'a aucun jeton au chargement : il est servi par le daemon, sur
 * la même origine, et récupère le jeton d'API en appelant `/ui/bootstrap`. Cette
 * route n'exige pas de jeton — le navigateur n'en a pas encore — mais reste
 * protégée par les contrôles d'enveloppe du daemon (`Host` exact, `Origin` en
 * liste blanche, `Sec-Fetch-Site`), qui sont précisément ce qui arrête une page
 * hostile. Le détail du modèle de menace est dans `packages/daemon/README.md`.
 *
 * Le jeton reste en mémoire : ni `localStorage`, ni cookie, ni URL. Il change à
 * chaque démarrage du daemon, et un rechargement de page le redemande.
 */
import type {
  Agent,
  Approval,
  CreateTaskRequest,
  Health,
  McpServerResponse,
  McpServersResponse,
  PickDirectoryResponse,
  ConnectionTest,
  ProviderConfig,
  ProviderPreset,
  Task,
  TaskEvent,
  TaskView,
  TaskWorkspaceResponse,
  ToolCall,
  UpdateAgentRequest,
} from '@midgaard/contracts'

/** Jeton d'API, en mémoire uniquement. */
let token: string | null = null

/**
 * Bootstrap en vol, s'il y en a un.
 *
 * Plusieurs composants demandent des données au même instant, et chacun aurait
 * sinon déclenché son propre `/ui/bootstrap`. Un seul suffit, et les autres
 * attendent celui-là.
 */
let pending: Promise<{ token: string; health: Health }> | null = null

/**
 * Erreur d'API portant le code HTTP, pour que l'appelant puisse le distinguer,
 * et le **motif** que le daemon joint à un refus (`reason`) : « agent_disabled »
 * seul ne dit pas quoi faire, « aucun fournisseur configuré » si.
 */
export class ApiError extends Error {
  readonly status: number
  readonly reason: string | null
  constructor(status: number, message: string, reason: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.reason = reason
  }
}

/**
 * Récupère le jeton d'API et l'état de santé initial.
 * @throws {ApiError} si le daemon refuse ou ne répond pas
 */
export function bootstrap(): Promise<{ token: string; health: Health }> {
  pending ??= (async () => {
    const res = await fetch('/ui/bootstrap', { headers: { accept: 'application/json' } })
    if (!res.ok) throw new ApiError(res.status, `bootstrap refusé (${res.status})`)
    const body = (await res.json()) as { token: string; health: Health }
    token = body.token
    return body
  })()
  // Un échec ne reste pas mémorisé : la reconnexion doit pouvoir redemander.
  return pending.catch((e: unknown) => {
    pending = null
    throw e
  })
}

/** Jeton courant, nécessaire pour ouvrir la WebSocket. */
export function currentToken(): string | null {
  return token
}

/**
 * Oublie le jeton courant.
 *
 * À appeler quand la WebSocket se ferme : le jeton est **régénéré à chaque
 * démarrage du daemon**, donc un daemon redémarré en invalide un sans que rien
 * ne le dise. Sans cet oubli, `connect()` voyait un jeton non nul, sautait le
 * bootstrap, et réessayait indéfiniment avec une valeur périmée — la page
 * restait « déconnecté » jusqu'à un rechargement manuel.
 */
export function forgetToken(): void {
  token = null
  pending = null
}

/**
 * Appelle l'API authentifiée.
 * @throws {ApiError} sur réponse non 2xx, avec le message d'erreur du daemon
 */
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Obtenir le jeton **avant** d'appeler, plutôt que d'espérer qu'un autre
  // l'ait déjà fait. React exécute les effets des enfants avant ceux du parent :
  // `AgentsCard` demandait donc ses données avant que `useHarness` n'ait
  // seulement lancé le bootstrap, recevait 401, et son `catch` vide la faisait
  // disparaître — la carte qui existe précisément pour dire à un nouveau venu
  // qu'aucun fournisseur n'est configuré était absente de son écran d'accueil.
  // Trouvé par le rendu, invisible pour un test de fonctions pures.
  if (!token) await bootstrap()
  const res = await fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: unknown }
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `erreur ${res.status}`, typeof body.reason === 'string' ? body.reason : null)
  }
  return body as T
}

/** Timeline complète d'une tâche. */
export function fetchTaskEvents(taskId: string): Promise<{ events: TaskEvent[] }> {
  return api(`/api/tasks/${taskId}/events`)
}

/** Approuve une demande. `by: 'dashboard'` est tracé dans l'historique. */
export function approve(approvalId: string): Promise<{ task: Task }> {
  return api(`/api/approvals/${approvalId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ by: 'dashboard' }),
  })
}

/** Refuse une demande, avec un motif facultatif transmis à la tâche. */
export function reject(approvalId: string, reason?: string): Promise<{ task: Task }> {
  return api(`/api/approvals/${approvalId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ by: 'dashboard', reason }),
  })
}

/** Demande l'annulation d'une tâche. */
export function cancelTask(taskId: string, reason?: string): Promise<{ task: Task }> {
  return api(`/api/tasks/${taskId}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) })
}

/** Appels d'outils d'une tâche, dans l'ordre où ils ont été demandés. */
export function fetchToolCalls(taskId: string): Promise<{ tool_calls: ToolCall[] }> {
  return api(`/api/tasks/${taskId}/tools`)
}

/** Worktree d'une tâche et son diff, recalculé par le daemon à chaque appel. */
export function fetchTaskWorkspace(taskId: string): Promise<TaskWorkspaceResponse> {
  return api(`/api/tasks/${taskId}/workspace`)
}

/** Profils d'agents déclarés, avec leur état d'activation. */
export function fetchAgents(): Promise<{ agents: Agent[] }> {
  return api('/api/agents')
}

/**
 * Fournisseurs déclarés et date des tarifs.
 *
 * Ne contient **aucune clé** : `ProviderConfig` ne porte qu'une référence vers
 * le coffre. Le dashboard n'en voit jamais une.
 */
export function fetchProviders(): Promise<{
  providers: ProviderConfig[]
  pricing: { updated_at: string; source: string; models: number }
}> {
  return api('/api/providers')
}

/**
 * Déclare ou met à jour un fournisseur, et dépose sa clé (carte « Fournisseurs »).
 *
 * C'est le **seul** appel du dashboard qui porte une clé. Elle part dans le
 * corps de la requête — jamais dans l'URL —, vers la même origine, sur la
 * boucle locale ; le daemon la dépose au coffre et ne la rend jamais. Sans
 * `api_key`, la clé déjà au coffre est conservée.
 */
export function saveProvider(request: {
  id: string
  preset: ProviderPreset
  default_model: string
  base_url?: string
  api_key?: string
}): Promise<{ provider: ProviderConfig }> {
  return api('/api/providers', { method: 'POST', body: JSON.stringify(request) })
}

/** « Tester la connexion » : le daemon joint l'endpoint avec la clé du coffre. Ne facture rien. */
export function testProvider(id: string): Promise<{ provider: ProviderConfig; test: ConnectionTest }> {
  return api(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST' })
}

/** Retire un fournisseur et efface sa clé du coffre. Ses profils sont désactivés, pas supprimés. */
export function removeProvider(id: string): Promise<{ ok: true }> {
  return api(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Relève les tarifs chez le fournisseur (Venice seulement : lui seul les publie par modèle). */
export function refreshProviderPricing(id: string): Promise<{ models: number }> {
  return api(`/api/providers/${encodeURIComponent(id)}/pricing`, { method: 'POST' })
}

/** Approbations en attente, pour un rafraîchissement ponctuel. */
export function fetchApprovals(): Promise<{ approvals: Approval[] }> {
  return api('/api/approvals')
}

/**
 * Crée une tâche depuis le formulaire « Nouvelle tâche » (Slice 5).
 *
 * Le daemon vérifie le dossier de projet avant toute création ; un refus
 * arrive en `ApiError` avec son motif.
 */
export function createTask(
  request: Omit<CreateTaskRequest, 'duration_s' | 'needs_approval' | 'conversation'> & {
    conversation?: boolean
  },
): Promise<TaskView> {
  return api('/api/tasks', { method: 'POST', body: JSON.stringify(request) })
}

/** Règle le fournisseur et le modèle d'un profil — jamais ses limites, que l'API refuse de toucher. */
export function updateAgent(agentId: string, request: UpdateAgentRequest): Promise<{ agent: Agent }> {
  return api(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body: JSON.stringify(request) })
}

/** Les serveurs MCP déclarés, avec leur catalogue annoté (Slice 8). Aucun secret : seulement des noms. */
export function fetchMcpServers(): Promise<McpServersResponse> {
  return api('/api/mcp')
}

/**
 * « Tester la connexion » : le daemon lance le serveur, lit son catalogue et
 * l'arrête. Peut durer jusqu'au délai de la poignée de main (30 s).
 */
export function testMcpServer(id: string): Promise<McpServerResponse> {
  return api(`/api/mcp/${encodeURIComponent(id)}/test`, { method: 'POST' })
}

/** Coche des outils du catalogue constaté : ils seront appelés sans approbation. */
export function allowMcpTools(id: string, tools: string[]): Promise<McpServerResponse> {
  return api(`/api/mcp/${encodeURIComponent(id)}/allow`, { method: 'POST', body: JSON.stringify({ tools, by: 'dashboard' }) })
}

/** Décoche des outils : chaque appel attendra de nouveau un humain. */
export function revokeMcpTools(id: string, tools: string[]): Promise<McpServerResponse> {
  return api(`/api/mcp/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: JSON.stringify({ tools, by: 'dashboard' }) })
}

/** Les serveurs MCP d'un profil, liste complète (`PUT /api/agents/:id/mcp`). */
export function setAgentMcp(agentId: string, servers: string[]): Promise<{ agent: Agent }> {
  return api(`/api/agents/${encodeURIComponent(agentId)}/mcp`, { method: 'PUT', body: JSON.stringify({ servers }) })
}

/**
 * Écrit à une conversation qui attend votre réponse (Slice 6). Le daemon refuse
 * (`task_not_awaiting_user`) un message à une tâche qui travaille.
 *
 * @param conclude demande à l'orchestrateur de conclure ; `text` peut être vide
 */
export function postMessage(taskId: string, text: string, conclude = false): Promise<TaskView> {
  return api(`/api/tasks/${taskId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text, conclude, by: 'dashboard' }),
  })
}

/**
 * Appelle une route qui rend des octets — une image —, authentifiée comme les
 * autres. Une balise `<img src>` ne sait pas porter le jeton : le dashboard
 * lit les octets ici et en fait une URL `blob:` locale.
 *
 * @throws {ApiError} sur réponse non 2xx, avec le motif du daemon
 */
async function apiBytes(path: string): Promise<{ blob: Blob; headers: Headers }> {
  if (!token) await bootstrap()
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: unknown }
    throw new ApiError(res.status, body.error ?? `erreur ${res.status}`, typeof body.reason === 'string' ? body.reason : null)
  }
  return { blob: await res.blob(), headers: res.headers }
}

/** La session de navigateur d'une tâche, et ce que montre sa dernière capture (Slice 7). */
export interface BrowserInfo {
  session: { objective: string; start_url: string; expires_at: number } | null
  frame: { url: string; title: string; at: string } | null
}

/** La session de navigateur d'une tâche, sans capture. */
export function fetchBrowser(taskId: string): Promise<BrowserInfo> {
  return api(`/api/tasks/${taskId}/browser`)
}

/** La dernière capture du navigateur d'une tâche, gardée en mémoire par le daemon. */
export async function fetchBrowserFrame(taskId: string): Promise<Blob> {
  return (await apiBytes(`/api/tasks/${taskId}/browser/frame`)).blob
}

/** Coupe la session de navigateur d'une tâche : un acte humain, que l'agent apprend à son action suivante. */
export function closeBrowser(taskId: string): Promise<{ closed: true }> {
  return api(`/api/tasks/${taskId}/browser/close`, { method: 'POST', body: '{}' })
}

/**
 * Une image de la tâche, lue sur le disque maintenant, et son SHA-256 : le fil
 * le compare à celui que `read_image` a journalisé.
 */
export async function fetchTaskImage(taskId: string, path: string): Promise<{ blob: Blob; sha256: string | null }> {
  const { blob, headers } = await apiBytes(`/api/tasks/${taskId}/files/image?path=${encodeURIComponent(path)}`)
  return { blob, sha256: headers.get('x-midgaard-sha256') }
}

/**
 * Ouvre le sélecteur de dossier du système, **sur le poste du daemon**, et
 * attend le choix de l'humain : la requête dure autant que le dialogue.
 *
 * Une page web ne reçoit jamais le chemin absolu d'un dossier ; c'est donc le
 * daemon, local, qui ouvre le dialogue et rend le chemin, canonique et déjà
 * vérifié. À n'appeler que si le daemon l'annonce (`health.directory_picker`).
 *
 * @param startDir dossier où ouvrir le dialogue, s'il existe
 * @throws {ApiError} si le dossier choisi est refusé (motif du daemon), si un
 *         dialogue est déjà ouvert, ou si aucun ne peut s'ouvrir
 */
export function pickDirectory(startDir: string): Promise<PickDirectoryResponse> {
  return api('/api/dialogs/directory', {
    method: 'POST',
    body: JSON.stringify(startDir ? { start_dir: startDir } : {}),
  })
}
