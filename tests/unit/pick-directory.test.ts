/**
 * @file Le sélecteur de dossier du système (`POST /api/dialogs/directory`,
 * `packages/daemon/src/pick-directory.ts`).
 *
 * Aucun de ces tests n'ouvre une fenêtre : la commande du dialogue est
 * éprouvée telle qu'elle est **composée** (les trois plateformes, depuis une
 * seule), le lancement l'est avec un faux programme de dialogue (Node
 * lui-même), et la route avec un sélecteur injecté. Le vrai dialogue de
 * chaque système ne peut être constaté que par un humain devant son écran —
 * le README du daemon dit lequel l'a été.
 *
 * Ce qui est couvert, et pourquoi :
 *  - **le dossier de départ ne se retrouve jamais dans un script** : il vient
 *    du client, et collé dans de l'AppleScript ou du PowerShell il
 *    s'exécuterait ;
 *  - **un dialogue abandonné est tué**, vérifié en interrogeant le pid au
 *    système, pas en lisant la réponse ;
 *  - **le chemin choisi est jugé comme un chemin tapé** : le dossier personnel
 *    choisi dans l'explorateur est refusé par la même règle ;
 *  - **un seul dialogue à la fois**, et un daemon qui ne peut pas en ouvrir ne
 *    l'annonce pas.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { daemonJson, loadConfig, readRuntime, type Health, type RuntimeInfo } from '@midgaard/contracts'
import {
  pickerCommand,
  startDaemon,
  systemDirectoryPicker,
  type Daemon,
  type DirectoryPicker,
  type PickOutcome,
  type PickerCommand,
} from '@midgaard/daemon'

/** Vrai si le pid existe encore, demandé au système. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Attend qu'une condition devienne vraie, cinq secondes au plus. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition jamais vraie')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('commande du dialogue', () => {
  const hostile = '/tmp/x") & (do shell script "touch /tmp/pwned'

  it('macOS : le dossier de départ est un argument, jamais du script', () => {
    const c = pickerCommand('darwin', {}, hostile) as PickerCommand
    assert.equal(c.command, '/usr/bin/osascript')
    const separator = c.args.indexOf('--')
    assert.ok(separator > 0, 'les arguments du script suivent « -- »')
    // Tout ce qui précède « -- » est du programme : le chemin n'y est pas.
    assert.ok(!c.args.slice(0, separator).some((a) => a.includes('pwned')))
    assert.equal(c.args.at(-1), hostile)
    // Sans dossier de départ, le script ne lit pas un second argument.
    const bare = pickerCommand('darwin', {}, null) as PickerCommand
    assert.ok(!bare.args.join(' ').includes('item 2 of argv'))
  })

  it('Windows : le dossier de départ est une variable d\'environnement', () => {
    const c = pickerCommand('win32', { SystemRoot: 'C:\\Windows' }, 'C:\\a\'; calc; \'') as PickerCommand
    assert.match(c.command, /powershell\.exe$/)
    assert.ok(!c.args.some((a) => a.includes('calc')))
    assert.deepEqual(c.env, { MIDGAARD_PICK_START: 'C:\\a\'; calc; \'' })
    assert.ok('unavailable' in pickerCommand('win32', {}, null), 'sans SystemRoot, pas de PowerShell désigné')
  })

  it('Linux : sans session graphique ou sans programme, dit pourquoi', () => {
    const none = pickerCommand('linux', { PATH: '/usr/bin' }, null)
    assert.ok('unavailable' in none && /session graphique/.test(none.unavailable))
    const empty = mkdtempSync(join(tmpdir(), 'midgaard-pick-'))
    try {
      const missing = pickerCommand('linux', { DISPLAY: ':0', PATH: empty }, null)
      assert.ok('unavailable' in missing && /zenity ou kdialog/.test(missing.unavailable))
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('Linux : zenity trouvé dans une entrée absolue du PATH, jamais dans une relative', () => {
    const bin = mkdtempSync(join(tmpdir(), 'midgaard-pick-'))
    try {
      writeFileSync(join(bin, 'zenity'), '#!/bin/sh\n')
      chmodSync(join(bin, 'zenity'), 0o755)
      const found = pickerCommand('linux', { WAYLAND_DISPLAY: 'wayland-0', PATH: `relatif:${bin}` }, '/srv/projet') as PickerCommand
      assert.equal(found.command, join(bin, 'zenity'))
      assert.ok(found.args.includes('--directory'))
      assert.ok(found.args.includes('--filename=/srv/projet/'))
      // La même entrée, donnée en relatif, ne désigne rien.
      const relative = pickerCommand('linux', { DISPLAY: ':0', PATH: 'bin' }, null)
      assert.ok('unavailable' in relative)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})

describe('lancement du dialogue (faux programme)', () => {
  /** Un sélecteur dont le « dialogue » est un script Node. */
  function fake(script: string) {
    return systemDirectoryPicker({
      platform: process.platform,
      env: process.env,
      command: () => ({ command: process.execPath, args: ['-e', script] }),
    })
  }

  it('rend le chemin écrit par le dialogue, sans son saut de ligne', async () => {
    const outcome = await fake('console.log("/srv/mon projet/é")').pick(null, new AbortController().signal)
    assert.deepEqual(outcome, { dir: '/srv/mon projet/é' })
  })

  it('une sortie en code 1 sans chemin est une annulation', async () => {
    assert.deepEqual(await fake('process.exit(1)').pick(null, new AbortController().signal), { cancelled: true })
    assert.deepEqual(
      await fake('console.error("execution error: User canceled. (-128)"); process.exit(1)').pick(null, new AbortController().signal),
      { cancelled: true },
    )
  })

  it('un autre échec est dit, avec ce que le programme a écrit', async () => {
    const outcome = await fake('console.error("cannot open display"); process.exit(3)').pick(null, new AbortController().signal)
    assert.ok('unavailable' in outcome && /code 3/.test(outcome.unavailable) && /cannot open display/.test(outcome.unavailable))
  })

  it('un programme absent n\'est pas annoncé disponible', () => {
    const picker = systemDirectoryPicker({
      platform: process.platform,
      env: {},
      command: () => ({ command: join(tmpdir(), 'midgaard-aucun-dialogue'), args: [] }),
    })
    assert.match(picker.available() ?? '', /introuvable/)
  })

  it('l\'abandon tue le dialogue : le pid n\'existe plus', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'midgaard-pick-'))
    const pidFile = join(dir, 'pid')
    try {
      const aborter = new AbortController()
      // Le faux dialogue écrit son pid puis attend un humain qui ne viendra pas.
      const pending = fake(
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ).pick(null, aborter.signal)
      let pid = 0
      await until(() => {
        try {
          pid = Number(readFileSync(pidFile, 'utf8'))
        } catch {
          pid = 0
        }
        return pid > 0
      })
      assert.ok(alive(pid), 'le dialogue tourne')
      aborter.abort()
      assert.deepEqual(await pending, { cancelled: true })
      await until(() => !alive(pid))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('POST /api/dialogs/directory', () => {
  let home: string
  let userHome: string
  let project: string
  let daemon: Daemon
  let rt: RuntimeInfo
  /** Ce que le prochain dialogue rendra ; une fonction pour ceux qui attendent. */
  let next: (startDir: string | null, signal: AbortSignal) => Promise<PickOutcome>
  let unavailable: string | null = null

  const picker: DirectoryPicker = {
    available: () => unavailable,
    pick: (startDir, signal) => next(startDir, signal),
  }

  /** Appelle la route. */
  function pick(body: unknown = {}, signal?: AbortSignal) {
    return daemonJson<{ dir?: string; cancelled?: boolean; error?: string; reason?: string }>(rt, '/api/dialogs/directory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
  }

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'midgaard-pick-home-'))
    userHome = mkdtempSync(join(tmpdir(), 'midgaard-pick-user-'))
    project = join(userHome, 'projet')
    mkdirSync(project)
    const config = loadConfig({ MIDGAARD_HOME: home, MIDGAARD_PORT: '0' }, { userHome })
    daemon = (await startDaemon(config, { log: () => {}, env: { MIDGAARD_VAULT: 'file' }, pickDirectory: picker }))!
    rt = readRuntime(config.runtimeFile)!
  })

  after(async () => {
    daemon.close('fin des tests')
    await daemon.stopped
    rmSync(home, { recursive: true, force: true })
    rmSync(userHome, { recursive: true, force: true })
  })

  it('le daemon annonce son sélecteur', async () => {
    const health = (await daemonJson<Health>(rt, '/api/health')).body
    assert.equal(health.directory_picker, true)
  })

  it('rend le dossier choisi, canonique, et passe le dossier de départ', async () => {
    let seen: string | null = 'jamais appelé'
    next = async (startDir) => {
      seen = startDir
      return { dir: project }
    }
    const res = await pick({ start_dir: userHome })
    assert.equal(res.status, 200)
    // `.native` : sous Windows et macOS, le dossier temporaire a deux noms.
    assert.equal(res.body.dir, realpathSync.native(project))
    assert.equal(seen, userHome)
  })

  it('une annulation n\'est pas une erreur', async () => {
    next = async () => ({ cancelled: true })
    const res = await pick()
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { cancelled: true })
  })

  it('le dossier personnel choisi dans l\'explorateur est refusé comme s\'il était tapé', async () => {
    next = async () => ({ dir: userHome })
    const res = await pick()
    assert.equal(res.status, 400)
    assert.equal(res.body.error, 'invalid_project_dir')
    assert.match(res.body.reason ?? '', /dossier personnel/)
  })

  it('un seul dialogue à la fois, et le suivant passe une fois le premier fermé', async () => {
    let close: (o: PickOutcome) => void = () => {}
    let opened = 0
    next = () => {
      opened++
      return new Promise<PickOutcome>((r) => {
        close = r
      })
    }
    const first = pick()
    await until(() => opened === 1)
    const second = await pick()
    assert.equal(second.status, 409)
    assert.equal(second.body.error, 'dialog_open')
    assert.equal(opened, 1, 'le second dialogue ne s\'est pas ouvert')
    close({ dir: project })
    assert.equal((await first).status, 200)
    next = async () => ({ cancelled: true })
    assert.equal((await pick()).status, 200)
  })

  it('le client qui part ferme le dialogue', async () => {
    let aborted = false
    let opened = false
    next = (_start, signal) =>
      new Promise<PickOutcome>((resolve) => {
        opened = true
        signal.addEventListener('abort', () => {
          aborted = true
          resolve({ cancelled: true })
        })
      })
    const client = new AbortController()
    const pending = pick({}, client.signal).catch(() => null)
    await until(() => opened)
    client.abort()
    await pending
    await until(() => aborted)
    // Et la place est libérée pour le dialogue suivant.
    next = async () => ({ cancelled: true })
    assert.equal((await pick()).status, 200)
  })

  it('un dialogue qui ne peut pas s\'ouvrir répond 501 avec son motif', async () => {
    unavailable = 'aucune session graphique'
    try {
      const res = await pick()
      assert.equal(res.status, 501)
      assert.equal(res.body.error, 'picker_unavailable')
      assert.equal(res.body.reason, 'aucune session graphique')
    } finally {
      unavailable = null
    }
  })
})
