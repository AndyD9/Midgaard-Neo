#!/usr/bin/env node
/**
 * @file Point d'entrée de la CLI `harness`.
 *
 * Analyse d'arguments à la main : une douzaine de commandes, deux options. Une dépendance
 * de plus pour ça coûterait plus qu'elle ne rapporte.
 *
 * Seul endroit du paquet qui lit l'environnement ; tout le reste reçoit la
 * configuration en paramètre.
 */
import { readFileSync } from 'node:fs'
import { loadConfig } from '@midgaard/contracts'
import { decide, doctor, start, status, stop } from './commands.ts'
import { agents, pricing, providers } from './providers.ts'
import { exec, workspaces } from './workspaces.ts'
import { mcp } from './mcp.ts'
import { desktop } from './desktop.ts'
import { extractHome } from './args.ts'
import { bold, dim, setAdviceHome } from './ui.ts'

const USAGE = `${bold('harness')} — harness local d'agents

${bold('Commandes')}
  start                 Démarre le daemon s'il dort, et affiche où le joindre
  stop [--if-idle]      Arrête le daemon ; --if-idle : seulement s'il n'a aucune tâche active (code 3 sinon)
  status [--limit N]    État du daemon et tâches récentes (lit la base même daemon arrêté)
  doctor                Diagnostic de l'installation
  desktop               Ouvre la fenêtre desktop du dashboard (construite par npm run desktop:build)
  approve [id]          Approuve une demande (la seule en attente si l'id est omis)
  reject [id] [motif]   Refuse une demande

${bold('Agents et fournisseurs')}
  agents                Profils d'exécution, et pourquoi certains sont désactivés
  providers             Fournisseurs de modèles déclarés
  providers add <id> --model <m> [--preset venice|openai|gemini|custom] [--base-url <u>]
                        Déclare un fournisseur ; la clé est saisie sans écho, jamais en argument
  providers test <id>   Joint l'endpoint et dit ce qu'il a vu
  providers remove <id> Retire un fournisseur et sa clé
  pricing               Tarifs en vigueur, et leur date de relevé
  pricing refresh <id>  Relève les tarifs chez le fournisseur (Venice les publie)

${bold('Serveurs MCP des agents')}
  mcp                   Serveurs MCP déclarés, et ce que dit leur dernier test
  mcp add <id> [--env NOM=v]… [--secret-env NOM]… -- <programme> [arguments…]
                        Déclare un serveur stdio et le teste ; une valeur secrète est saisie sans écho
  mcp test <id>         Lance le serveur et relit son catalogue d'outils
  mcp tools <id>        Le catalogue : outils libres, changés, ou approuvés à chaque appel
  mcp allow <id> [--yes] (--read-only | <outil>…)
                        Coche des outils libres, après avertissement et confirmation
  mcp revoke <id> <outil>…
                        Les décoche : chaque appel attendra de nouveau un humain
  mcp remove <id>       Retire un serveur, ses outils cochés et ses secrets
  mcp attach <id> <profil>
                        Donne les outils du serveur aux agents d'un profil (researcher, developer, navigator)
  mcp detach <id> <profil>
                        Les leur retire

${bold('Worktrees et commandes des agents écrivants')}
  workspaces            Worktrees des tâches Developer, leur état sur le disque, les orphelins
  workspaces remove <branche|id> [--force]
                        Retire un worktree ; la branche reste. --force perd le travail non commité
  workspaces clean [--force]
                        Retire ceux des tâches finies ; les worktrees sales sont laissés sans --force
  exec                  Commandes lancées sans approbation dans les worktrees de ce dépôt
  exec allow [--yes] [--prefix] [--] <commande…>
                        Ajoute un argv exact à cette liste, après avertissement et confirmation ;
                        --prefix couvre tout ce qui le suit (jamais un interpréteur nu : python -m pytest)
  exec revoke [--] <commande…>
                        Le retire : la commande attendra de nouveau un humain

${bold('Options')}
  --home <dossier>      Dossier runtime visé, au lieu de ~/.midgaard (vaut MIDGAARD_HOME) ; avant la commande
  -h, --help            Cette aide
  -v, --version         Version du harness

${dim('Environnement : MIDGAARD_HOME, MIDGAARD_PORT, MIDGAARD_IDLE_SHUTDOWN_S, MIDGAARD_DASHBOARD_DIR,')}
${dim('               MIDGAARD_VAULT, MIDGAARD_HTTP_POLICY, MIDGAARD_HTTP_ALLOW,')}
${dim('               MIDGAARD_EXEC_ALLOW, MIDGAARD_APPROVAL_TTL_S, MIDGAARD_INPUT_TTL_S, MIDGAARD_MAX_ACTIVE_SUBTASKS')}`

/**
 * Version du paquet, pour `--version`, lue dans `packages/cli/package.json` —
 * une seule source. Une constante recopiée à la main aurait menti dès la
 * première montée de version.
 * `src/` et `dist/` sont au même niveau, d'où le même chemin relatif.
 */
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/**
 * Exécute la commande demandée.
 * @param argv arguments, sans `node` ni le chemin du script
 * @returns le code de sortie du processus
 */
export async function run(argv: string[]): Promise<number> {
  const { home, rest: args } = extractHome(argv, process.env.INIT_CWD ?? process.cwd())
  const [command, ...rest] = args
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE)
    return 0
  }
  if (command === '-v' || command === '--version') {
    console.log(VERSION)
    return 0
  }

  const config = loadConfig(home ? { ...process.env, MIDGAARD_HOME: home } : process.env)
  setAdviceHome(config.homeIsExplicit ? config.home : null, config.launcher)

  switch (command) {
    case 'start':
      return start(config)
    case 'stop':
      return stop(config, { ifIdle: rest.includes('--if-idle') })
    case 'status': {
      const at = rest.indexOf('--limit')
      const limit = at >= 0 ? Number(rest[at + 1]) : 20
      return status(config, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 20)
    }
    case 'doctor':
      return doctor(config, rest[0] ?? process.cwd())
    case 'desktop':
      return desktop(config)
    case 'approve':
      return decide(config, 'approve', rest[0], undefined)
    case 'reject':
      return decide(config, 'reject', rest[0], rest.slice(1).join(' ') || undefined)
    case 'agents':
      return agents(config)
    case 'providers':
      return providers(config, rest)
    case 'mcp':
      return mcp(config, rest)
    case 'pricing':
      return pricing(config, rest)
    case 'workspaces':
      return workspaces(config, rest)
    case 'exec':
      return exec(config, rest)
    default:
      console.error(`Commande inconnue : ${command}\n`)
      console.error(USAGE)
      return 1
  }
}

process.exitCode = await run(process.argv.slice(2))
