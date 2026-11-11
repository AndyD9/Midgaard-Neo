/**
 * @file La saisie d'une clé d'API par `harness providers add` n'affiche rien
 * de ce qui est tapé (docs/SLICE5.md, leçon n° 36).
 *
 * Le défaut d'origine ne se voyait que dans un vrai terminal : une interface
 * `readline` réaffichait chaque caractère. Le test reproduit un terminal par un
 * flux qui se déclare TTY et accepte le mode brut, puis relit **tout ce qui a
 * été écrit** sur la sortie pendant la saisie : seuls l'invite et le retour à
 * la ligne final y ont droit. Vu échouer contre l'ancienne saisie (une
 * `readline` en mode terminal remise sur ces flux).
 */
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { readSecret, type SecretInput } from '@midgaard/cli'

/** Un faux terminal : un flux qui se dit TTY et note les bascules de mode brut. */
function fakeTty(): { input: SecretInput & PassThrough; modes: boolean[] } {
  const modes: boolean[] = []
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(mode: boolean) {
      modes.push(mode)
      return this
    },
  })
  return { input, modes }
}

/**
 * Une sortie qui retient tout ce qu'on y écrit. Un vrai `Writable`, et non un
 * simple objet `write` : l'ancienne saisie y branchait une `readline`, qui
 * exige un flux — sans cela, le test contre l'ancien code échouerait pour une
 * autre raison que l'écho.
 */
function capture(): { output: Writable; written: () => string } {
  let text = ''
  const output = new Writable({
    write(chunk: Buffer | string, _enc, done) {
      text += chunk.toString()
      done()
    },
  })
  return { output, written: () => text }
}

/** Le secret d'essai, assez long et marqué pour être reconnu s'il fuit. */
const SECRET = 'SECRET_DE_TEST_0123456789abcdef'

describe('readSecret — terminal', () => {
  it("n'écrit que l'invite et le retour à la ligne, jamais un caractère tapé", async () => {
    const { input, modes } = fakeTty()
    const { output, written } = capture()
    const pending = readSecret("Clé d'API", { input, output })
    // Caractère par caractère, comme une frappe, puis d'un bloc, comme un collage.
    for (const c of SECRET.slice(0, 5)) input.write(c)
    input.write(`${SECRET.slice(5)}\r`)
    assert.equal(await pending, SECRET)
    assert.equal(written(), "Clé d'API : \n", 'la sortie ne contient rien de plus que l\'invite')
    assert.ok(!written().includes(SECRET.slice(0, 4)), 'aucun fragment du secret à l\'écran')
    assert.deepEqual(modes, [true, false], 'mode brut posé, puis rétabli')
  })

  it("retire le dernier caractère sur effacement, toujours sans rien afficher", async () => {
    const { input } = fakeTty()
    const { output, written } = capture()
    const pending = readSecret('Clé', { input, output })
    input.write('abcX\u007fd\n')
    assert.equal(await pending, 'abcd')
    assert.equal(written(), 'Clé : \n')
  })

  it('rend null sur Ctrl-C, et rétablit le mode du terminal', async () => {
    const { input, modes } = fakeTty()
    const { output } = capture()
    const pending = readSecret('Clé', { input, output })
    input.write('début\u0003')
    assert.equal(await pending, null, 'rien de ce qui précède Ctrl-C ne doit être déposé')
    assert.deepEqual(modes, [true, false])
  })

  it('rend null sur une saisie vide', async () => {
    const { input } = fakeTty()
    const { output } = capture()
    const pending = readSecret('Clé', { input, output })
    input.write('   \r')
    assert.equal(await pending, null)
  })
})

describe('readSecret — tube', () => {
  it('lit la première ligne sans rien écrire, pas même l\'invite', async () => {
    const input = new PassThrough()
    const { output, written } = capture()
    input.end(`${SECRET}\nligne suivante ignorée\n`)
    assert.equal(await readSecret('Clé', { input, output }), SECRET)
    assert.equal(written(), '')
  })
})
