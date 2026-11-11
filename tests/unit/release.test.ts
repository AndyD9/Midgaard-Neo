/**
 * @file Les scripts de release de l'application autonome
 * (`apps/desktop/scripts/release.mjs`, `version.mjs`), sans réseau ni build.
 *
 * Une application installée se met à jour en lisant `latest.json` : ce
 * fichier dit quelle version existe et, par cible, où télécharger le paquet et
 * quelle est sa signature. Une erreur ici ne casse rien au build — elle casse
 * la mise à jour chez l'utilisateur, plus tard. D'où ces preuves :
 *  - les cibles portent les noms que le plugin de Tauri cherche, et celle de
 *    l'exécutable unique est à part de celle du bundle ;
 *  - le manifeste refuse un poste d'une autre version que le tag, une cible
 *    fournie deux fois, une signature vide et une release sans cible ;
 *  - la version s'écrit partout d'un geste, **sans reformater** un fichier, et
 *    une divergence est dite fichier par fichier ;
 *  - les fichiers du dépôt disent tous la même version, aujourd'hui.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
// Des scripts `.mjs`, sans types : ce sont eux que le workflow lance.
// @ts-expect-error module JavaScript sans déclaration
import { buildManifest, targetsFor } from '../../apps/desktop/scripts/release.mjs'
// @ts-expect-error module JavaScript sans déclaration
import { agreedVersion, readVersions, writeVersion } from '../../apps/desktop/scripts/version.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scratch: string[] = []
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

describe('cibles de mise à jour', () => {
  it('nomme les cibles comme le plugin les cherche, l\'exécutable unique à part', () => {
    assert.deepEqual(targetsFor('win32', 'x64'), {
      bundle: ['windows-x86_64-nsis', 'windows-x86_64'],
      portable: 'windows-x86_64-portable',
    })
    assert.deepEqual(targetsFor('darwin', 'arm64'), {
      bundle: ['darwin-aarch64-app', 'darwin-aarch64'],
      portable: 'darwin-aarch64-portable',
    })
    assert.deepEqual(targetsFor('linux', 'x64'), {
      bundle: ['linux-x86_64-deb', 'linux-x86_64'],
      portable: 'linux-x86_64-portable',
    })
    assert.throws(() => targetsFor('freebsd', 'x64'), /pas de cible/)
    assert.throws(() => targetsFor('linux', 'ia32'), /pas de cible/)
  })
})

describe('manifeste latest.json', () => {
  const windows = {
    version: '0.2.0',
    targets: {
      'windows-x86_64-nsis': { file: 'Midgaard_0.2.0_x64-setup.exe', signature: 'c2lnLW5zaXM=\n' },
      'windows-x86_64': { file: 'Midgaard_0.2.0_x64-setup.exe', signature: 'c2lnLW5zaXM=\n' },
      'windows-x86_64-portable': { file: 'Midgaard-portable-win32-x64.exe', signature: 'c2lnLXBvcnRhYmxl' },
    },
  }
  const mac = {
    version: '0.2.0',
    targets: { 'darwin-aarch64-portable': { file: 'Midgaard-portable-darwin-arm64', signature: 'c2lnLW1hYw==' } },
  }
  const base = { tag: 'v0.2.0', repo: 'AndyD9/Midgaard-Neo', notes: 'Corrige l\'invite.', pubDate: '2026-11-11T20:00:00.000Z' }

  it('fusionne les postes, avec l\'adresse de chaque fichier dans la release', () => {
    const manifest = buildManifest({ ...base, fragments: [windows, mac] })
    assert.equal(manifest.version, '0.2.0', 'sans le « v » : c\'est une version, que le plugin compare')
    assert.equal(manifest.notes, 'Corrige l\'invite.')
    assert.equal(manifest.pub_date, '2026-11-11T20:00:00.000Z')
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      'darwin-aarch64-portable', 'windows-x86_64', 'windows-x86_64-nsis', 'windows-x86_64-portable',
    ])
    assert.deepEqual(manifest.platforms['windows-x86_64-portable'], {
      url: 'https://github.com/AndyD9/Midgaard-Neo/releases/download/v0.2.0/Midgaard-portable-win32-x64.exe',
      signature: 'c2lnLXBvcnRhYmxl',
    })
    assert.equal(manifest.platforms['windows-x86_64-nsis'].signature, 'c2lnLW5zaXM=', 'la fin de ligne du fichier .sig est retirée')
  })

  it('refuse ce qui casserait la mise à jour chez l\'utilisateur', () => {
    assert.throws(() => buildManifest({ ...base, fragments: [windows, { ...mac, version: '0.1.9' }] }), /0\.1\.9.*0\.2\.0/)
    assert.throws(() => buildManifest({ ...base, fragments: [windows, windows] }), /fournie par deux postes/)
    const unsigned = { version: '0.2.0', targets: { 'linux-x86_64-portable': { file: 'x', signature: '  ' } } }
    assert.throws(() => buildManifest({ ...base, fragments: [unsigned] }), /sans signature/)
    assert.throws(() => buildManifest({ ...base, fragments: [] }), /aucune cible/)
    assert.throws(() => buildManifest({ ...base, tag: 'nightly', fragments: [windows] }), /pas une version/)
  })
})

describe('version', () => {
  it('les fichiers du dépôt disent tous la même version', () => {
    const version = agreedVersion(readVersions(ROOT))
    assert.match(version, /^\d+\.\d+\.\d+/)
  })

  /** Une copie des seuls fichiers qui portent la version, dans un dossier jetable. */
  function copy(): string {
    const dir = mkdtempSync(join(tmpdir(), 'midgaard-version-'))
    scratch.push(dir)
    for (const file of Object.keys(readVersions(ROOT)).filter((f) => !f.includes(' '))) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      cpSync(join(ROOT, file), join(dir, file))
    }
    return dir
  }

  it('s\'écrit partout d\'un geste, sans reformater un fichier', () => {
    const dir = copy()
    const before = readFileSync(join(dir, 'packages/secrets/package.json'), 'utf8')
    writeVersion('3.4.5', dir)
    const versions = readVersions(dir)
    assert.equal(agreedVersion(versions), '3.4.5')
    assert.ok(Object.keys(versions).length > 20, 'paquets, verrou npm, Tauri et Cargo sont tous lus')
    const after = readFileSync(join(dir, 'packages/secrets/package.json'), 'utf8')
    const changed = after.split('\n').filter((line, i) => line !== before.split('\n')[i])
    assert.deepEqual(changed, ['  "version": "3.4.5",'], 'une seule ligne a changé')
    // La version d'une dépendance, dans Cargo.lock, n'est pas celle du paquet : elle ne bouge pas.
    const lock = readFileSync(join(dir, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8')
    assert.equal(lock.split('version = "3.4.5"').length - 1, 1)
    assert.throws(() => writeVersion('v3.4.5', dir), /n'est pas une version/)
  })

  it('dit quel fichier diverge', () => {
    const dir = copy()
    const conf = join(dir, 'apps/desktop/src-tauri/tauri.conf.json')
    writeFileSync(conf, readFileSync(conf, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.9"'))
    assert.throws(() => agreedVersion(readVersions(dir)), /tauri\.conf\.json : 9\.9\.9/)
  })
})
