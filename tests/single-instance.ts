/**
 * @file Instance unique du daemon sous concurrence : `npm run test:lock` (~30 s).
 *
 * Invariant vérifié : **quel que soit le nombre de daemons lancés en même temps
 * sur un même dossier runtime, un seul survit**, et c'est lui que désigne le
 * fichier de découverte.
 *
 * Ce test existe parce qu'un test de bout en bout ne suffisait pas. Celui de la
 * Slice 0 vérifiait que deux clients voient le même daemon — ce qui reste vrai
 * même quand deux daemons tournent, puisque les clients lisent le même fichier de
 * découverte. Deux daemons orphelins ont ainsi survécu à une suite entièrement
 * verte. **Les invariants se testent directement** : ici, en comptant les
 * processus vivants.
 *
 * Deux familles de manches :
 *  - **départ à froid** : dossier vide ;
 *  - **verrou périmé** : un verrou et un fichier de découverte laissés par un
 *    daemon mort (cas d'un `SIGKILL`), que tous les candidats tentent de
 *    récupérer en même temps. C'est la course qui échouait 4 fois sur 4 avant
 *    l'introduction du bail.
 *
 * Le nombre de survivants se compte strictement, deux tours de bail après que
 * le **dernier** candidat a fini de démarrer — et jamais avant `SETTLE_MS`.
 * Compter à `SETTLE_MS` du lancement supposait un démarrage rapide : sous
 * macOS en CI, Node a mis 1,5 s à démarrer, le perdant s'est arrêté à son
 * premier tour de bail comme prévu, 2,6 s après son lancement — quelques
 * millisecondes après le comptage, qui a vu deux survivants (SLICE4,
 * étape 7). Le bail démarre juste avant « à l'écoute sur » : c'est de là que
 * se comptent ses tours. La
 * **publication** du fichier de découverte, elle, peut tarder au-delà : sous
 * Windows en CI, huit Node démarrant ensemble sur deux cœurs, une manche a
 * trouvé le bon survivant mais pas encore de fichier (SLICE4, étape 5). On
 * l'attend donc jusqu'à `PUBLISH_MS` de plus, en disant combien de temps il a
 * fallu ; et si la manche échoue, les journaux de **tous** les candidats sont
 * affichés, morts compris, avec leur code de sortie — sans eux, impossible de
 * distinguer une lenteur d'une panne, ni un vainqueur mort d'un perdant.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { PROTOCOL_VERSION, daemonFetch, readRuntime } from '@midgaard/contracts'
import { childEnv, deadPid, nodeArgsFor, running, summarize, type Outcome } from './helpers.ts'

/** Nombre de daemons lancés simultanément à chaque manche. */
const CONTENDERS = 8
/** Délai minimal avant de compter les survivants, depuis le lancement. */
const SETTLE_MS = 2_500
/**
 * Délai laissé aux candidats pour se départager, depuis la fin du démarrage du
 * dernier : deux tours de bail et une marge. Un perdant s'arrête au premier.
 */
const LEASE_ROUNDS_MS = 2 * 1_000 + 500
/** Délai maximal de démarrage d'un candidat : au-delà, c'est une panne. */
const BOOT_MS = 20_000
/** Ce qu'un daemon écrit quand son bail tourne et qu'il écoute. */
const LISTENING = "à l'écoute sur"
const COLD_ROUNDS = 6
const STALE_ROUNDS = 4
/** Délai supplémentaire laissé à la publication du fichier de découverte. */
const PUBLISH_MS = 15_000

// Le dossier temporaire du système, pas `/tmp` : sous Windows, `/tmp` serait
// `C:\tmp`, hors de ce que le poste de CI nettoie.
const home = join(tmpdir(), 'midgaard-lock-test')
/** Journaux des candidats, hors du dossier runtime que chaque manche efface. */
const logDir = join(tmpdir(), 'midgaard-lock-test-journaux')
const config = (await import('@midgaard/contracts')).loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' })
const daemonArgs = nodeArgsFor('@midgaard/daemon/main')
const outcomes: Outcome[] = []

/**
 * Joue une manche et rend son verdict.
 * @param label   nom affiché
 * @param prepare état à installer dans le dossier runtime avant le départ
 */
async function round(label: string, prepare?: () => Promise<void>): Promise<void> {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  mkdirSync(home, { recursive: true, mode: 0o700 })
  rmSync(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  mkdirSync(logDir, { recursive: true })
  await prepare?.()

  const logs = Array.from({ length: CONTENDERS }, (_, i) => join(logDir, `${i}.log`))
  const fds = logs.map((path) => openSync(path, 'a'))
  const kids = fds.map((fd) => spawn(process.execPath, daemonArgs, { env: childEnv(home), stdio: ['ignore', fd, fd] }))
  const started = Date.now()
  // Chaque candidat finit par sortir (verrou perdu) ou par écouter, bail lancé.
  const booted = (i: number) => !running(kids[i]!) || readFileSync(logs[i]!, 'utf8').includes(LISTENING)
  while (!kids.every((_, i) => booted(i)) && Date.now() - started < BOOT_MS) await sleep(50)
  const bootMs = Date.now() - started
  await sleep(Math.max(SETTLE_MS - bootMs, LEASE_ROUNDS_MS))
  const counted = Date.now()

  // Les survivants se comptent maintenant, sans délai de grâce.
  const alive = kids.filter(running)
  let rt = readRuntime(config.runtimeFile)
  let healthy = false
  while (alive.length === 1) {
    healthy = rt ? await daemonFetch(rt, '/api/health').then((r) => r.ok).catch(() => false) : false
    if ((healthy && rt?.pid === alive[0]!.pid) || Date.now() - counted > PUBLISH_MS) break
    await sleep(200)
    rt = readRuntime(config.runtimeFile)
  }
  const published = Date.now() - counted
  const stillOne = kids.filter(running).length === 1
  const ok = alive.length === 1 && stillOne && rt?.pid === alive[0]!.pid && healthy
  if (!ok) {
    // **Tous** les candidats, morts compris, avec leur code de sortie. Une
    // manche Windows a fini à zéro survivant (passage 42402763315) : n'afficher
    // que les vivants n'avait alors rien montré, et la cause est restée
    // illisible. Un perdant normal dit pourquoi il s'est arrêté ; un vainqueur
    // mort aussi, et c'est lui qu'on cherche.
    for (const [i, kid] of kids.entries()) {
      const state = running(kid) ? 'vivant' : `sorti (code ${kid.exitCode ?? '?'}${kid.signalCode ? `, ${kid.signalCode}` : ''})`
      const tail = readFileSync(logs[i]!, 'utf8').trim().split('\n').slice(-15).join('\n    ')
      console.log(`  journal du candidat ${kid.pid}, ${state} :\n    ${tail || '(vide)'}`)
    }
  }

  // Nettoyage : arrêt propre du daemon désigné, puis des survivants en trop
  // (ils n'existent qu'en cas de bug). Ce sont les propres enfants de ce test.
  if (rt && healthy) await daemonFetch(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
  await sleep(200)
  for (const k of kids.filter(running)) k.kill('SIGTERM')
  await Promise.all(kids.filter(running).map((k) => once(k, 'exit')))
  for (const fd of fds) closeSync(fd)

  outcomes.push({
    name: label,
    verdict: ok ? 'PASS' : 'FAIL',
    detail:
      `${alive.length} survivant(s) sur ${CONTENDERS}, ` +
      `découverte → ${rt?.pid ?? 'aucun'}${healthy ? '' : ' (injoignable)'}` +
      (bootMs > 1_000 ? `, démarrage en ${(bootMs / 1000).toFixed(1)} s` : '') +
      (published > 300 ? `, publiée ${(published / 1000).toFixed(1)} s après le comptage` : ''),
  })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(20)} ${outcomes[outcomes.length - 1]!.detail}`)
}

console.log(`Instance unique : ${CONTENDERS} daemons par manche, ${COLD_ROUNDS + STALE_ROUNDS} manches\n`)
for (let i = 1; i <= COLD_ROUNDS; i++) await round(`à froid #${i}`)
for (let i = 1; i <= STALE_ROUNDS; i++) {
  await round(`verrou périmé #${i}`, async () => {
    const pid = await deadPid()
    writeFileSync(config.lockFile, String(pid), { mode: 0o600 })
    writeFileSync(
      config.runtimeFile,
      JSON.stringify({
        pid,
        port: 1,
        token: 'x'.repeat(64),
        started_at: new Date().toISOString(),
        protocol: PROTOCOL_VERSION,
        dashboard_url: 'http://127.0.0.1:1/',
      }),
      { mode: 0o600 },
    )
  })
}

rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
rmSync(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
process.exit(summarize(outcomes, 'Résumé — instance unique'))
