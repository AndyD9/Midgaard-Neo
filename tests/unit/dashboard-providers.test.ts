/**
 * @file Les fonctions pures de la carte « Fournisseurs » du dashboard
 * (`apps/dashboard/src/lib/providers.ts`) : préréglages, validation d'une
 * saisie, requête envoyée au daemon.
 *
 * Les préréglages existent deux fois — dans `contracts` et dans le dashboard,
 * qui n'en importe que des types — : le test les compare, pour qu'un
 * préréglage changé là-bas ne laisse pas la carte dire autre chose.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PRESETS, PROVIDER_PRESETS, upsertProviderRequestSchema, type ProviderConfig } from '@midgaard/contracts'
import { PRESET_OPTIONS, draftError, draftOf, emptyDraft, keyStatus, requestOf, type ProviderDraft } from '../../apps/dashboard/src/lib/providers.ts'

/** Un fournisseur déjà déclaré, clé au coffre. */
function declared(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'venice',
    name: 'Venice.ai',
    kind: 'openai-compatible',
    preset: 'venice',
    base_url: null,
    default_model: 'm',
    secret_ref: 'provider.00000000.venice',
    web_search: 'native',
    created_at: '2026-11-10T00:00:00.000Z',
    updated_at: '2026-11-10T00:00:00.000Z',
    last_test: null,
    ...over,
  }
}

/** Une saisie complète et valide pour un fournisseur nouveau. */
function draft(over: Partial<ProviderDraft> = {}): ProviderDraft {
  return { ...emptyDraft(), apiKey: 'sk-abc', ...over }
}

describe('préréglages du dashboard', () => {
  it('disent la même chose que ceux de contracts', () => {
    assert.deepEqual(Object.keys(PRESET_OPTIONS), [...PROVIDER_PRESETS])
    for (const preset of PROVIDER_PRESETS) {
      assert.equal(PRESET_OPTIONS[preset].label, PRESETS[preset].label)
      // Gemini n'a pas d'adresse non plus, mais son adaptateur connaît la
      // sienne : seul un endpoint compatible OpenAI sans adresse en exige une.
      const needs = PRESETS[preset].baseUrl === null && PRESETS[preset].kind === 'openai-compatible'
      assert.equal(PRESET_OPTIONS[preset].needsBaseUrl, needs, preset)
    }
  })
})

describe('validation d\'une saisie', () => {
  it('laisse partir le cas courant : Venice, un modèle, une clé', () => {
    assert.equal(draftError(draft(), undefined), null)
  })

  it('refuse un identifiant que le daemon refuserait', () => {
    for (const id of ['', 'Venice', '-x', 'a b', 'é']) assert.match(draftError(draft({ id }), undefined) ?? '', /Identifiant/, id)
  })

  it('exige un modèle, et une adresse pour un préréglage qui n\'en a pas', () => {
    assert.match(draftError(draft({ model: ' ' }), undefined) ?? '', /modèle/)
    assert.match(draftError(draft({ preset: 'custom' }), undefined) ?? '', /adresse/)
    assert.match(draftError(draft({ preset: 'custom', baseUrl: 'ftp://x' }), undefined) ?? '', /https/)
    assert.equal(draftError(draft({ preset: 'custom', baseUrl: 'http://127.0.0.1:8080/v1' }), undefined), null)
  })

  it('exige une clé pour un fournisseur nouveau, pas pour garder celle du coffre', () => {
    assert.match(draftError(draft({ apiKey: '  ' }), undefined) ?? '', /clé/)
    assert.equal(draftError(draft({ apiKey: '', model: 'autre' }), declared()), null)
    assert.match(draftError(draft({ apiKey: '' }), declared({ secret_ref: null })) ?? '', /coffre/)
  })

  it('exige de ressaisir la clé quand l\'adresse ou le préréglage change', () => {
    // Sans cela, la clé déjà au coffre partirait vers une autre adresse.
    assert.match(draftError(draft({ apiKey: '', baseUrl: 'https://ailleurs.example/v1' }), declared()) ?? '', /ressaisis/)
    assert.match(draftError(draft({ apiKey: '', preset: 'openai' }), declared()) ?? '', /ressaisis/)
    assert.equal(draftError(draft({ apiKey: 'sk-neuve', baseUrl: 'https://ailleurs.example/v1' }), declared()), null)
  })
})

describe('requête envoyée au daemon', () => {
  it('rogne la clé collée, et passe le schéma de la route', () => {
    const request = requestOf(draft({ id: ' venice ', apiKey: '  sk-abc\n' }))
    assert.deepEqual(request, { id: 'venice', preset: 'venice', default_model: 'deepseek-v4-flash-0731', api_key: 'sk-abc' })
    assert.equal(upsertProviderRequestSchema.safeParse(request).success, true)
  })

  it('n\'envoie ni clé vide ni adresse vide', () => {
    const request = requestOf(draft({ apiKey: '', baseUrl: ' ' }))
    assert.equal('api_key' in request, false)
    assert.equal('base_url' in request, false)
  })

  it('ne pré-remplit jamais une clé', () => {
    assert.equal(draftOf(declared({ base_url: 'https://x.example/v1' })).apiKey, '')
    assert.equal(draftOf(declared({ base_url: 'https://x.example/v1' })).baseUrl, 'https://x.example/v1')
  })

  it('dit d\'où vient la clé', () => {
    assert.equal(keyStatus(declared()).inVault, true)
    assert.equal(keyStatus(declared({ secret_ref: null })).inVault, false)
  })
})
