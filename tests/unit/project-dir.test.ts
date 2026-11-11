/**
 * @file Le dossier de projet d'une tâche (Slice 5, décision 9) : ce qu'un agent
 * aura le droit de lire, désormais tapé à la main au dashboard.
 *
 * Chaque refus est éprouvé sur un vrai système de fichiers, liens symboliques
 * compris : c'est sous un lien (`/tmp` sur macOS) qu'une comparaison faite
 * avant canonicalisation laisserait passer le dossier personnel.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { checkProjectDir } from '@midgaard/daemon'

let scratch: string
let home: string

before(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-projectdir-')))
  home = join(scratch, 'utilisateur')
  mkdirSync(join(home, 'depot'), { recursive: true })
  writeFileSync(join(home, 'fichier.txt'), 'x')
})
after(() => rmSync(scratch, { recursive: true, force: true }))

describe('checkProjectDir', () => {
  it('accepte un sous-dossier du dossier personnel, et le rend canonique', () => {
    assert.deepEqual(checkProjectDir(join(home, 'depot'), home), { dir: join(home, 'depot') })
    assert.deepEqual(checkProjectDir(join(home, 'depot', '..', 'depot'), home), { dir: join(home, 'depot') })
  })

  it('refuse un chemin relatif, absent, ou qui n\'est pas un dossier', () => {
    assert.match((checkProjectDir('depot', home) as { error: string }).error, /absolu/)
    assert.match((checkProjectDir(join(home, 'absent'), home) as { error: string }).error, /n'existe pas/)
    assert.match((checkProjectDir(join(home, 'fichier.txt'), home) as { error: string }).error, /pas un dossier/)
    assert.match((checkProjectDir('  ', home) as { error: string }).error, /aucun dossier/)
  })

  it('refuse la racine du système', () => {
    assert.match((checkProjectDir(parse(scratch).root, home) as { error: string }).error, /racine du système/)
  })

  it('refuse le dossier personnel lui-même, même désigné par un lien', { skip: process.platform === 'win32' && 'liens symboliques réservés aux administrateurs' }, () => {
    assert.match((checkProjectDir(home, home) as { error: string }).error, /dossier personnel/)
    const link = join(scratch, 'raccourci')
    symlinkSync(home, link)
    assert.match((checkProjectDir(link, home) as { error: string }).error, /dossier personnel/)
    // Et l'inverse : le dossier personnel désigné par un lien, le projet par son vrai chemin.
    assert.match((checkProjectDir(home, link) as { error: string }).error, /dossier personnel/)
  })
})
