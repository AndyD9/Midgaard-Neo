/**
 * @file Références de clés en coffre : une par installation.
 *
 * Constaté à la Slice 4, étape 8 (leçon n° 30) : sous `provider.<id>` seul,
 * deux dossiers runtime d'une même session partageaient l'entrée du trousseau.
 * Déclarer `venice` dans l'un écrasait la clé de l'autre, et la retirer la
 * supprimait pour les deux. Ces tests portent sur la référence elle-même et
 * sur le choix qu'en fait `upsertProvider`, avec le coffre fichier dans un
 * dossier jetable : rien n'est écrit dans le coffre de la machine.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { loadConfig, type PricingTable } from '@midgaard/contracts'
import { secretRefFor, upsertProvider } from '@midgaard/daemon'
import { HarnessStore } from '@midgaard/persistence'
import { fileVault, normalizeRef } from '@midgaard/secrets'

const root = mkdtempSync(join(tmpdir(), 'midgaard-refs-'))
after(() => rmSync(root, { recursive: true, force: true }))

describe('secretRefFor', () => {
  it('donne deux références à deux dossiers runtime', () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    mkdirSync(a)
    mkdirSync(b)
    assert.notEqual(secretRefFor(a, 'venice'), secretRefFor(b, 'venice'))
    assert.match(secretRefFor(a, 'venice'), /^provider\.[0-9a-f]{8}\.venice$/)
  })

  it('donne la même à un dossier atteint par un lien', (t) => {
    // Le chemin vient de la configuration, telle que l'utilisateur l'a écrite :
    // un lien vers le même dossier ne doit pas faire perdre la clé.
    const real = join(root, 'real')
    const link = join(root, 'link')
    mkdirSync(real)
    try {
      symlinkSync(real, link, 'junction')
    } catch {
      return t.skip('impossible de créer un lien sur cette machine')
    }
    assert.equal(secretRefFor(link, 'venice'), secretRefFor(real, 'venice'))
  })

  it('reste dans l’alphabet des coffres', () => {
    const ref = secretRefFor(root, 'essai-venice')
    assert.equal(normalizeRef(ref), ref, 'normalizeRef ne doit rien y changer')
  })
})

describe('upsertProvider et la référence', () => {
  /** Dépendances minimales du service, sur un dossier runtime jetable. */
  function deps(name: string) {
    const home = join(root, name)
    mkdirSync(home)
    const config = loadConfig({ MIDGAARD_HOME: home })
    const store = HarnessStore.open(config)
    const vault = fileVault(join(home, 'secrets'))
    let pricing: PricingTable = { updated_at: new Date().toISOString(), source: 'test', entries: {} }
    return {
      store,
      vault,
      deps: {
        config,
        store,
        vault,
        env: {},
        pricing: () => pricing,
        setPricing: (t: PricingTable) => (pricing = t),
        log: () => {},
      },
    }
  }

  it('range une nouvelle clé sous la référence de son installation', async () => {
    const { store, vault, deps: d } = deps('new')
    await upsertProvider(d, { id: 'venice', preset: 'venice', default_model: 'm', api_key: 'k1' })
    const ref = store.getProvider('venice')?.secret_ref
    assert.equal(ref, secretRefFor(d.config.home, 'venice'))
    assert.equal(await vault.get(ref!), 'k1')
    store.close()
  })

  it('garde la référence connue quand la clé change', async () => {
    // Une base d'avant la leçon n° 30 porte `provider.venice` : la recalculer
    // laisserait l'ancienne entrée orpheline, hors de portée de `remove`.
    const { store, vault, deps: d } = deps('old')
    store.upsertProvider({
      id: 'venice',
      name: 'Venice',
      kind: 'openai-compatible',
      preset: 'venice',
      baseUrl: null,
      defaultModel: 'm',
      secretRef: 'provider.venice',
      webSearch: 'native',
    })
    await upsertProvider(d, { id: 'venice', preset: 'venice', default_model: 'm', api_key: 'k2' })
    assert.equal(store.getProvider('venice')?.secret_ref, 'provider.venice')
    assert.equal(await vault.get('provider.venice'), 'k2')
    store.close()
  })
})
