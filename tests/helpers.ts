/**
 * @file Outillage commun aux suites d'intégration.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, type HarnessConfig } from '@midgaard/contracts'

/** Verdict d'un scénario. `CONSTAT` mesure l'environnement et ne peut pas échouer. */
export type Verdict = 'PASS' | 'FAIL' | 'CONSTAT'
export interface Outcome {
  name: string
  verdict: Verdict
  detail: string
}

/**
 * Point d'entrée d'un paquet, et les arguments pour le lancer.
 *
 * `import.meta.resolve` suit les conditions d'export du processus : en
 * développement il rend le `.ts` des sources, une fois compilé le `.js` de
 * `dist/`. Les conditions personnalisées ne s'héritent pas, d'où leur rappel
 * explicite.
 */
export function nodeArgsFor(specifier: string): string[] {
  const entry = fileURLToPath(import.meta.resolve(specifier))
  return entry.endsWith('.ts') ? ['--conditions=midgaard-dev', entry] : [entry]
}

/** Crée un dossier runtime jetable, et la configuration qui va avec. */
export function tempHome(prefix: string): { home: string; config: HarnessConfig; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), `midgaard-${prefix}-`))
  // Port 0 : chaque suite prend un port libre, sans se marcher dessus ni
  // dépendre du daemon de développement.
  const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
  // Réessais : sous Windows, un dossier qu'un processus tout juste arrêté tient
  // encore ouvert refuse d'être supprimé (EPERM) pendant un instant. Constaté
  // en CI à la fin de `test:ui`, après huit scénarios réussis.
  return {
    home,
    config,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    },
  }
}

/**
 * Environnement transmis à un processus enfant pour qu'il vise le même dossier.
 *
 * `MIDGAARD_VAULT=file` n'est pas une commodité : **le coffre système est par
 * utilisateur, pas par `MIDGAARD_HOME`**. Le trousseau macOS ne connaît qu'un
 * service `midgaard` et un compte `provider.<id>` ; une suite de tests qui
 * déposerait une clé y écraserait celle de l'utilisateur, sous la même
 * référence, sans rien dire. Les tests écrivent donc dans leur dossier jetable.
 */
export function childEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, MIDGAARD_HOME: home, MIDGAARD_PORT: '0', MIDGAARD_VAULT: 'file', ...extra }
}

/** Vrai tant que le processus enfant n'est pas terminé. */
export function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

/**
 * Renvoie le pid d'un processus qui vient de se terminer : un pid réaliste et
 * garanti mort, pour simuler le verrou laissé par un daemon tué.
 */
export async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(p, 'exit')
  return p.pid!
}

/** Affiche le résumé d'une suite et rend le code de sortie attendu. */
export function summarize(outcomes: Outcome[], title: string): number {
  const width = Math.max(...outcomes.map((o) => o.name.length))
  console.log(`\n${title}`)
  for (const o of outcomes) console.log(`  ${o.verdict.padEnd(7)} ${o.name.padEnd(width)}  ${o.detail}`)
  const failed = outcomes.filter((o) => o.verdict === 'FAIL')
  console.log(`\n${outcomes.length} scénario(s), ${failed.length} échec(s)`)
  return failed.length ? 1 : 0
}

/**
 * Exécute un scénario et enregistre son verdict.
 * Une exception compte comme un `FAIL` : un scénario ne fait jamais tomber la suite.
 */
export async function scenario(
  outcomes: Outcome[],
  name: string,
  fn: () => Promise<Omit<Outcome, 'name'>>,
): Promise<void> {
  process.stdout.write(`▶ ${name}\n`)
  try {
    outcomes.push({ name, ...(await fn()) })
  } catch (e) {
    outcomes.push({ name, verdict: 'FAIL', detail: `exception : ${(e as Error).message}` })
  }
  const last = outcomes[outcomes.length - 1]!
  console.log(`  ${last.verdict} — ${last.detail}`)
}
