/**
 * @file Configuration Vite du dashboard.
 *
 * En production, le dashboard est servi **par le daemon lui-même**, sur la même
 * origine que l'API : c'est ce qui permet aux contrôles `Host` et `Origin` de
 * rester stricts, sans CORS à ouvrir.
 *
 * En développement, Vite sert la page sur son propre port. Pour garder la même
 * propriété, tout `/api`, `/ui` et `/events` est **relayé** vers le daemon, et le
 * relais réécrit `Origin` : sans ça, le daemon verrait l'origine de Vite
 * (`http://localhost:5173`) et refuserait la requête, à juste titre.
 *
 * Le port du daemon est lu dans son fichier de découverte, puisqu'il peut varier
 * d'un démarrage à l'autre. Si aucun daemon ne tourne au lancement de Vite, le
 * relais vise le port par défaut : lance `harness start` puis relance Vite.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Port par défaut du daemon, repris de `@midgaard/contracts` (`DEFAULT_PORT`). */
const DEFAULT_PORT = 7777

/**
 * Lit le port du daemon dans son fichier de découverte.
 *
 * Lecture directe plutôt qu'import de `@midgaard/contracts` : ce fichier de
 * configuration tourne avant toute compilation, et ne doit dépendre de rien
 * d'autre que de Node.
 */
function daemonPort(): number {
  const home = process.env.MIDGAARD_HOME ?? join(homedir(), '.midgaard')
  try {
    const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { port?: number }
    return info.port ?? DEFAULT_PORT
  } catch {
    return DEFAULT_PORT
  }
}

const target = `http://127.0.0.1:${daemonPort()}`

/** Réécrit `Origin` pour que le daemon voie sa propre origine, et non celle de Vite. */
const sameOrigin: ProxyOptions = {
  target,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('origin', target))
    proxy.on('proxyReqWs', (proxyReq) => proxyReq.setHeader('origin', target))
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Chemins relatifs : les fichiers sont servis depuis la racine du daemon,
  // mais aussi depuis une route cliente comme `/tasks/<id>`.
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: {
    proxy: {
      '/api': sameOrigin,
      '/ui': sameOrigin,
      '/events': { ...sameOrigin, ws: true },
    },
  },
})
