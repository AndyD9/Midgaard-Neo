/**
 * @file Commandes `harness providers`, `harness agents` et `harness pricing`.
 *
 * Toutes passent par l'API du daemon plutôt que par la base : c'est le daemon
 * qui tient le coffre, et deux processus qui écriraient la même configuration
 * en parallèle finiraient par diverger.
 *
 * **La clé d'API ne figure jamais sur la ligne de commande.** Elle est lue sur
 * l'entrée standard — saisie sans écho, ou passée par un tube. Un argument de
 * commande est visible dans `ps`, et surtout il reste dans l'historique du
 * shell, où personne ne pense à aller l'effacer.
 */
import {
  PRESETS,
  PROVIDER_PRESETS,
  daemonJson,
  type Agent,
  type ConnectionTest,
  type HarnessConfig,
  type PricingTable,
  type ProviderConfig,
  type ProviderPreset,
} from '@midgaard/contracts'
import { ensureDaemon } from './daemon-client.ts'
import { readSecret } from './secret-input.ts'
import { bold, cmd, dim, green, mark, red, yellow } from './ui.ts'
import { confirm } from './workspaces.ts'

/** Journalisation discrète du démarrage de daemon : la CLI a sa propre sortie. */
const quiet = () => {}

/** Analyse `--option valeur` dans une liste d'arguments. */
function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}

// --- providers --------------------------------------------------------------

/** Répartit les sous-commandes de `harness providers`. */
export async function providers(config: HarnessConfig, args: string[]): Promise<number> {
  const [sub = 'list', ...rest] = args
  switch (sub) {
    case 'list':
      return listProviders(config)
    case 'add':
    case 'set':
      return addProvider(config, rest)
    case 'test':
      return testProvider(config, rest[0])
    case 'remove':
    case 'rm':
      return removeProvider(config, rest[0])
    default:
      console.error(`Sous-commande inconnue : providers ${sub}`)
      console.error('Attendu : list, add, test, remove')
      return 1
  }
}

/** Affiche les fournisseurs déclarés, et l'état de leur dernier test. */
async function listProviders(config: HarnessConfig): Promise<number> {
  const rt = await ensureDaemon(config, quiet)
  const { body } = await daemonJson<{
    providers: ProviderConfig[]
    pricing: { updated_at: string; source: string; models: number }
  }>(rt, '/api/providers')

  if (body.providers.length === 0) {
    console.log('Aucun fournisseur configuré.')
    console.log()
    console.log('Pour en ajouter un :')
    console.log(dim(`  ${cmd('providers add venice --model deepseek-v4-flash-0731')}`))
    return 0
  }

  for (const p of body.providers) {
    const test = p.last_test
    const badge = !test ? dim('jamais testé') : test.ok ? green('joignable') : red('injoignable')
    console.log(`${bold(p.id.padEnd(14))} ${p.preset.padEnd(8)} ${p.default_model.padEnd(36)} ${badge}`)
    console.log(`  ${dim(`clé : ${p.secret_ref ?? 'environnement (dépannage)'} · recherche web : ${p.web_search}`)}`)
    if (test) console.log(`  ${dim(`${test.detail} (${test.at.slice(0, 19).replace('T', ' ')})`)}`)
  }
  console.log()
  console.log(
    dim(`Tarifs : ${body.pricing.models} modèle(s), relevés le ${body.pricing.updated_at.slice(0, 10)}`),
  )
  return 0
}

/**
 * Déclare un fournisseur et dépose sa clé.
 *
 * @param args `<id> [--preset p] [--model m] [--base-url u]`
 */
async function addProvider(config: HarnessConfig, args: string[]): Promise<number> {
  const id = args[0]
  if (!id || id.startsWith('--')) {
    console.error('Usage : providers add <id> --model <modèle> [--preset venice|openai|gemini|custom] [--base-url <url>]')
    return 1
  }
  const preset = (option(args, 'preset') ?? guessPreset(id)) as ProviderPreset
  if (!(PROVIDER_PRESETS as readonly string[]).includes(preset)) {
    console.error(`Préréglage inconnu : ${preset}. Attendu : ${PROVIDER_PRESETS.join(', ')}`)
    return 1
  }
  const model = option(args, 'model')
  if (!model) {
    console.error('Il faut un modèle par défaut : --model <identifiant>')
    console.error(dim(`Exemple pour Venice : --model deepseek-v4-flash-0731`))
    return 1
  }

  const key = await readSecret(`Clé d'API pour ${PRESETS[preset].label}`)
  if (!key) {
    console.error('Aucune clé saisie ; rien n\'a été modifié.')
    return 1
  }

  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<{ provider?: ProviderConfig; error?: string; reason?: string }>(
    rt,
    '/api/providers',
    {
      method: 'POST',
      body: JSON.stringify({
        id,
        preset,
        default_model: model,
        api_key: key,
        ...(option(args, 'base-url') ? { base_url: option(args, 'base-url') } : {}),
      }),
    },
  )
  if (status !== 200 || !body.provider) {
    console.error(`${red('✘')} refusé : ${body.error ?? status}${body.reason ? ` — ${body.reason}` : ''}`)
    return 1
  }

  console.log(`${green('✔')} fournisseur ${bold(id)} déclaré (${body.provider.kind}, modèle ${model})`)
  console.log(`  ${dim(`clé déposée sous la référence ${body.provider.secret_ref}`)}`)
  console.log()
  // On teste dans la foulée : un fournisseur déclaré mais injoignable ne se
  // découvrirait sinon qu'à la première tâche, loin de sa cause.
  return testProvider(config, id)
}

/** Devine le préréglage depuis l'identifiant, pour que le cas courant n'ait rien à saisir. */
function guessPreset(id: string): string {
  const known = (PROVIDER_PRESETS as readonly string[]).find((p) => id.toLowerCase().includes(p))
  return known ?? 'venice'
}

/** Lance un « Test connection » et affiche ce que l'endpoint a répondu. */
async function testProvider(config: HarnessConfig, id: string | undefined): Promise<number> {
  if (!id) {
    console.error('Usage : providers test <id>')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  process.stdout.write(`Test de ${bold(id)}… `)
  const { status, body } = await daemonJson<{ test?: ConnectionTest; error?: string; reason?: string }>(
    rt,
    `/api/providers/${encodeURIComponent(id)}/test`,
    { method: 'POST' },
  )
  if (status !== 200 || !body.test) {
    console.log(red('échec'))
    console.error(`  ${body.error ?? status}${body.reason ? ` — ${body.reason}` : ''}`)
    return 1
  }
  const test = body.test
  console.log(test.ok ? green('joignable') : red('injoignable'))
  console.log(`  ${test.detail}${test.latency_ms !== null ? dim(` · ${test.latency_ms} ms`) : ''}`)
  return test.ok ? 0 : 1
}

/** Retire un fournisseur et sa clé. Les profils qui s'y référaient sont désactivés, pas supprimés. */
async function removeProvider(config: HarnessConfig, id: string | undefined): Promise<number> {
  if (!id) {
    console.error('Usage : providers remove <id>')
    return 1
  }
  const rt = await ensureDaemon(config, quiet)
  const { status, body } = await daemonJson<{ error?: string }>(rt, `/api/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (status !== 200) {
    console.error(`${red('✘')} ${body.error ?? status}`)
    return 1
  }
  console.log(`${green('✔')} fournisseur ${bold(id)} retiré, sa clé supprimée du coffre`)
  console.log(`  ${dim('les profils qui l\'employaient sont désactivés, pas supprimés : leurs réglages sont conservés')}`)
  return 0
}

// --- agents ------------------------------------------------------------------

/** Affiche les profils d'agents, et pourquoi ceux qui sont désactivés le sont. */
export async function agents(config: HarnessConfig): Promise<number> {
  const rt = await ensureDaemon(config, quiet)
  const { body } = await daemonJson<{ agents: Agent[] }>(rt, '/api/agents')
  for (const a of body.agents) {
    const badge = a.enabled ? mark.ok() : mark.warn()
    console.log(`${badge} ${bold(a.id.padEnd(14))} ${a.name}`)
    console.log(`  ${dim(a.description || '(sans description)')}`)
    if (!a.enabled) {
      console.log(`  ${yellow('désactivé')} ${dim('— aucun fournisseur de modèle configuré pour ce profil')}`)
      console.log(`  ${dim(cmd('providers add venice --model deepseek-v4-flash-0731'))}`)
    } else if (a.provider_id) {
      console.log(`  ${dim(`fournisseur ${a.provider_id} · ${a.model ?? 'modèle par défaut'} · outils : ${a.tools.join(', ') || 'aucun'}`)}`)
      // Seule la déclaration se montre ici : le catalogue du fournisseur, qui
      // l'emporte, se lit au démarrage de chaque tâche (Slice 7).
      if (a.vision !== null) console.log(`  ${dim(`lit les images : ${a.vision ? 'oui' : 'non'} (déclaré)`)}`)
      if (a.mcp_servers.length) console.log(`  ${dim(`serveurs MCP : ${a.mcp_servers.join(', ')}`)}`)
    }
  }
  return 0
}

/** Relève les tarifs chez le fournisseur, plutôt que de les maintenir à la main. */
export async function pricing(config: HarnessConfig, args: string[]): Promise<number> {
  const rt = await ensureDaemon(config, quiet)
  if (args[0] !== 'refresh') {
    const { body } = await daemonJson<{ pricing: PricingTable }>(rt, '/api/pricing')
    const table = body.pricing
    console.log(`${Object.keys(table.entries).length} modèle(s) tarifés`)
    console.log(`  ${dim(`relevés le ${table.updated_at.slice(0, 10)} — ${table.source}`)}`)
    console.log()
    console.log(dim(`Pour relever les tarifs chez Venice : ${cmd('pricing refresh venice')}`))
    return 0
  }

  const id = args[1]
  if (!id) {
    console.error('Usage : pricing refresh <id-du-fournisseur>')
    return 1
  }
  const { status, body } = await daemonJson<{ models?: number; path?: string; error?: string; reason?: string }>(
    rt,
    `/api/providers/${encodeURIComponent(id)}/pricing`,
    { method: 'POST' },
  )
  if (status !== 200) {
    console.error(`${red('✘')} ${body.error ?? status}${body.reason ? ` — ${body.reason}` : ''}`)
    return 1
  }
  console.log(`${green('✔')} ${body.models} modèle(s) tarifés depuis ${bold(id)}`)
  console.log(`  ${dim(body.path ?? '')}`)
  return 0
}

