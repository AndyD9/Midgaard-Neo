/**
 * @file Service des fichiers du dashboard : traversée de chemins et repli.
 *
 * Le daemon sert des fichiers à partir d'un chemin d'URL. C'est l'endroit
 * classique où l'on sort du dossier prévu : `..`, encodage pourcent, chemin
 * absolu. Chacun est vérifié ici, avec un fichier témoin déposé hors du dossier
 * servi — si la défense tombe, le test le lit et échoue.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { StaticFiles } from '@midgaard/daemon'

let root: string
let served: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'midgaard-static-'))
  served = join(root, 'dist')
  mkdirSync(join(served, 'assets'), { recursive: true })
  writeFileSync(join(served, 'index.html'), '<!doctype html><title>dashboard</title>')
  writeFileSync(join(served, 'assets', 'app-abc123.js'), 'console.log(1)')
  // Témoin hors du dossier servi : il ne doit jamais ressortir.
  writeFileSync(join(root, 'secret.txt'), 'JETON-SECRET')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/**
 * Réponse HTTP minimale, qui capture ce qui lui est écrit.
 * `EventEmitter` parce que `createReadStream(...).pipe(res)` s'abonne à `res`.
 */
function fakeResponse() {
  const captured = { status: 0, headers: {} as Record<string, string>, body: '' }
  // Résolue à la fin de la réponse : attendre cela, et non un délai fixe. Trente
  // millisecondes suffisaient sur un poste, pas sur un runner de CI chargé —
  // le corps arrivait vide (passage 41647596699, Linux).
  let ended!: () => void
  const finished = new Promise<void>((r) => (ended = r))
  const res = new EventEmitter() as unknown as ServerResponse & { captured: typeof captured; finished: Promise<void> }
  Object.assign(res, {
    captured,
    finished,
    writableEnded: false,
    destroyed: false,
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status
      captured.headers = headers
      return res
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk
      captured.status ||= 200
      ended()
      return res
    },
    write(chunk: Buffer | string) {
      captured.body += chunk.toString()
      return true
    },
    on: EventEmitter.prototype.on.bind(res),
    emit: EventEmitter.prototype.emit.bind(res),
    once: EventEmitter.prototype.once.bind(res),
  })
  return res
}

/** Sert un chemin et rend la réponse, une fois qu'elle est **finie**. */
async function serve(files: StaticFiles, path: string) {
  const res = fakeResponse()
  files.serve(path, res)
  // Borne de sécurité seulement : un `end` jamais appelé ferait échouer le test
  // sur son assertion, pas le bloquer. Désarmée ensuite, sans quoi elle
  // retiendrait le processus cinq secondes de plus.
  let timer: NodeJS.Timeout | undefined
  await Promise.race([res.finished, new Promise((r) => (timer = setTimeout(r, 5000)))])
  clearTimeout(timer)
  return res.captured
}

describe('dashboard compilé', () => {
  it('sert index.html à la racine, sans cache', async () => {
    const out = await serve(new StaticFiles(served), '/')
    assert.equal(out.status, 200)
    assert.match(out.body, /dashboard/)
    // `index.html` ne doit jamais être mis en cache : sinon une mise à jour du
    // dashboard ne serait jamais vue.
    assert.equal(out.headers['cache-control'], 'no-store')
  })

  it('sert un actif empreinté comme immuable', async () => {
    const out = await serve(new StaticFiles(served), '/assets/app-abc123.js')
    assert.equal(out.status, 200)
    assert.match(out.headers['cache-control']!, /immutable/)
    assert.match(out.headers['content-type']!, /javascript/)
  })

  it('retombe sur index.html pour une route du routeur client', async () => {
    // `/tasks/<id>` doit fonctionner au rechargement de la page.
    const out = await serve(new StaticFiles(served), '/tasks/7006766d-d310-4813-b855-efa9a9406d26')
    assert.equal(out.status, 200)
    assert.match(out.body, /dashboard/)
  })

  it('rend 404 pour un fichier absent portant une extension', async () => {
    const out = await serve(new StaticFiles(served), '/assets/inexistant.js')
    assert.equal(out.status, 404)
  })
})

describe('traversée de chemins', () => {
  const attacks = [
    '/../secret.txt',
    '/../../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '//../secret.txt',
  ]
  for (const path of attacks) {
    it(`refuse ${path}`, async () => {
      const out = await serve(new StaticFiles(served), path)
      assert.doesNotMatch(out.body, /JETON-SECRET/, 'le fichier hors dossier servi a fuité')
      assert.notEqual(out.status, 200)
    })
  }
})

describe('dashboard non compilé', () => {
  it('explique comment le compiler au lieu de faire semblant', async () => {
    const files = new StaticFiles(join(root, 'nexiste-pas'))
    assert.equal(files.available, false, 'il ne doit pas se déclarer disponible')
    const out = await serve(files, '/')
    assert.equal(out.status, 200)
    assert.match(out.body, /npm run build/)
  })

  it('se considère absent si index.html manque', () => {
    const empty = mkdtempSync(join(tmpdir(), 'midgaard-vide-'))
    try {
      assert.equal(new StaticFiles(empty).available, false)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
