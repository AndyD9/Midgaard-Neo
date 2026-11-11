/**
 * @file Service des fichiers compilés du dashboard.
 *
 * Le dashboard est une application React compilée par Vite. Le daemon la sert
 * telle quelle, sur la même origine que l'API : c'est ce qui permet aux contrôles
 * `Host`/`Origin` de rester stricts, sans CORS à ouvrir.
 *
 * **Si le dashboard n'a pas été compilé**, le daemon ne fait pas semblant : il
 * sert une page qui donne la commande à lancer, et le reste du harness cesse de
 * renvoyer l'utilisateur vers une URL qui n'afficherait rien. C'est la leçon du
 * défaut n° 1 de la Slice 0 — ne jamais décrire ce qui n'existe pas.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

/** Types MIME des fichiers produits par Vite. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** Page de repli quand le dashboard n'a pas encore été compilé. */
function notBuiltPage(): string {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Midgaard — dashboard non compilé</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem;color:#1f2430}
code{background:#eef1f6;padding:.15rem .4rem;border-radius:.25rem}
pre{background:#1f2430;color:#eef1f6;padding:1rem;border-radius:.5rem;overflow:auto}</style></head>
<body><h1>Dashboard non compilé</h1>
<p>Le daemon tourne, mais les fichiers du dashboard sont absents. À la racine du
dépôt, compile-les :</p>
<pre>npm run build</pre>
<p>Puis recharge cette page. En développement, <code>npm run dashboard:dev</code> sert le
dashboard avec rechargement à chaud.</p></body></html>`
}

/** Sert les fichiers du dashboard, ou explique comment les produire. */
export class StaticFiles {
  private readonly root: string | null

  /**
   * @param dir dossier des fichiers compilés ; `null` ou inexistant active la
   *            page de repli
   */
  constructor(dir: string | null) {
    this.root = dir && existsSync(join(dir, 'index.html')) ? resolve(dir) : null
  }

  /** Vrai si le dashboard est réellement servable. Conditionne les URL annoncées. */
  get available(): boolean {
    return this.root !== null
  }

  /**
   * Sert `pathname`.
   *
   * Les chemins inconnus sans extension retombent sur `index.html` : c'est une
   * application à routage côté client, `/tasks/<id>` doit fonctionner au
   * rechargement.
   */
  serve(pathname: string, res: ServerResponse): void {
    if (!this.root) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(notBuiltPage())
      return
    }
    const file = this.resolveFile(pathname)
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    // Les fichiers d'actifs portent une empreinte dans leur nom : ils sont
    // immuables. `index.html`, lui, ne doit jamais être mis en cache, sinon une
    // mise à jour du dashboard ne serait jamais vue.
    const immutable = file.includes(`${sep}assets${sep}`)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    })
    createReadStream(file).pipe(res)
  }

  /**
   * Transforme un chemin d'URL en chemin de fichier sûr.
   *
   * `normalize` puis vérification que le résultat est bien **sous** la racine :
   * sans ça, `/../../etc/passwd` sortirait du dossier servi.
   */
  private resolveFile(pathname: string): string | null {
    if (!this.root) return null
    const decoded = decodeURIComponent(pathname)
    const candidate = resolve(this.root, '.' + normalize(decoded))
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) return null
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {}
    // Route du routeur client : on rend l'application, qui décidera quoi afficher.
    return extname(decoded) === '' ? join(this.root, 'index.html') : null
  }
}
