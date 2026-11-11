/**
 * @file Un daemon complet, dans son propre processus, dont le navigateur des
 * agents peut joindre la boucle locale — pour `test:security` (Slice 7, étape 7).
 *
 * La vraie garde du navigateur refuse `127.0.0.1` ; une page servie par le
 * test y est donc injoignable par le daemon de production. Celui-ci prend la
 * garde des tests (`StartOptions.browserGuard`, que `main.ts` ne pose jamais)
 * et ne laisse passer que `127.0.0.1` en plus de l'internet public : la page
 * du test, rien de plus large.
 *
 * Il tourne dans un processus à part, et non dans celui du test, pour une
 * seule raison : le scénario qui le tue net (`SIGKILL`) et compte ensuite les
 * Chromium qui survivent. Tué dans le processus du test, il emporterait la
 * suite avec lui.
 *
 * C'est un `main` de test : comme `packages/daemon/src/main.ts`, il est le seul
 * de son processus à lire l'environnement.
 */
import { loadConfig } from '@midgaard/contracts'
import { startDaemon } from '@midgaard/daemon'
import { assertPublicHost } from '@midgaard/tools'

const config = loadConfig(process.env)
const daemon = await startDaemon(config, {
  env: process.env,
  browserGuard: async (host) => (host === '127.0.0.1' ? ['127.0.0.1'] : assertPublicHost(host)),
})
if (!daemon) process.exit(0)

process.on('SIGTERM', () => daemon.close('SIGTERM'))
await daemon.stopped
process.exit(0)
