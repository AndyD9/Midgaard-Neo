/**
 * @file Essai réel des images (Slice 7, étape 1) : `npm run test:live-vision`.
 * **Dépense de l'argent** — une fraction de centime.
 *
 * Les tests des adaptateurs prouvent la **forme** d'une image envoyée, sur
 * réponses enregistrées. Celui-ci prouve ce qu'ils ne peuvent pas : qu'un vrai
 * modèle Venice reçoit l'image et la lit, que la capacité lue au catalogue est
 * juste, et ce que l'image coûte — le montant facturé par Venice, comparé à
 * l'estimation tirée de la table de tarifs.
 *
 * L'image est l'icône de la coque desktop : un « M » blanc sur un carré violet.
 * Le modèle doit nommer la lettre et la couleur ; il ne peut pas les deviner du
 * texte de la question, qui ne les dit pas.
 *
 * Opt-in, hors de `npm test`, comme `test:live`. Sans clé Venice déposée par
 * `providers add`, il s'abstient au lieu d'échouer.
 *
 *  - V1 le catalogue dit que le modèle lit les images ;
 *  - V2 le modèle lit réellement l'image : il nomme la lettre ;
 *  - V3 le coût porte sa provenance « facturé par le fournisseur », et
 *       l'estimation est dite à côté.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@midgaard/contracts'
import { HarnessStore } from '@midgaard/persistence'
import { createOpenAiAdapter, loadPricing, priceFor } from '@midgaard/providers'
import { openVault, resolveApiKey } from '@midgaard/secrets'
import { scenario, summarize, type Outcome } from './helpers.ts'

/** Modèle employé : il lit les images et appelle des outils, et il est bon marché. */
const MODEL = process.env.MIDGAARD_LIVE_VISION_MODEL ?? 'mistral-small-3-2-24b-instruct'
const outcomes: Outcome[] = []

// La clé et le fournisseur sont ceux de l'utilisateur : on lit sa base en
// lecture seule et son coffre, sans rien y écrire.
const config = loadConfig({ MIDGAARD_HOME: process.env.MIDGAARD_HOME ?? join(homedir(), '.midgaard') })
const store = HarnessStore.openReadOnly(config)
const provider = store.getProvider('venice')
store.close()
const vault = await openVault(config, process.env)
const found = provider ? await resolveApiKey(vault, provider.secret_ref, 'VENICE_API_KEY', process.env) : null
if (!provider || !found) {
  console.log('Aucun fournisseur « venice » avec sa clé : cet essai réel est ignoré — ce n\'est pas un échec.')
  console.log('\n  npm run harness -- providers add venice --model deepseek-v4-flash-0731\n')
  process.exit(0)
}

const adapter = createOpenAiAdapter({
  id: 'venice',
  preset: 'venice',
  model: MODEL,
  baseUrl: provider.base_url ?? 'https://api.venice.ai/api/v1',
  apiKey: found.key,
  webSearch: false,
  redact: (t) => t.replaceAll(found.key, '[REDACTED]'),
  price: priceFor(loadPricing(config), 'venice', MODEL),
})

console.log(`Essai réel des images — Venice, ${MODEL}\n`)

await scenario(outcomes, 'V1 le catalogue dit que le modèle lit les images', async () => {
  const caps = await adapter.capabilities!()
  return caps.vision === true && caps.source === 'catalog'
    ? { verdict: 'PASS', detail: 'supportsVision lu au catalogue Venice' }
    : { verdict: 'FAIL', detail: JSON.stringify(caps) }
})

let cost = ''
await scenario(outcomes, 'V2 le modèle lit réellement l\'image', async () => {
  const png = readFileSync(new URL('../apps/desktop/src-tauri/icons/icon.png', import.meta.url))
  const res = await adapter.complete({
    messages: [
      { role: 'system', content: 'Answer in one short sentence, in English.' },
      {
        role: 'user',
        content: 'What single capital letter is drawn in this image, and what is the background colour?',
        images: [{ mediaType: 'image/png', data: png.toString('base64') }],
      },
    ],
    tools: [],
    maxOutputTokens: 60,
    webSearch: false,
  })
  const u = res.usage
  cost =
    `${u.cost_usd} $ (${u.cost_source}), estimation ${u.cost_usd_estimated ?? 'inconnue'} $, ` +
    `${u.input_tokens} jetons en entrée, ${u.output_tokens} en sortie`
  const saw = /\bM\b/.test(res.text)
  return saw
    ? { verdict: 'PASS', detail: `« ${res.text.trim()} » — ${png.length} octets envoyés` }
    : { verdict: 'FAIL', detail: `réponse sans la lettre M : « ${res.text.trim()} »` }
})

await scenario(outcomes, 'V3 le coût de l\'image porte sa provenance', async () => {
  return /\(provider\)/.test(cost)
    ? { verdict: 'PASS', detail: cost }
    : { verdict: 'FAIL', detail: cost || 'aucun appel' }
})

process.exit(summarize(outcomes, 'Images, contre l\'API réelle'))
