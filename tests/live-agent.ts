/**
 * @file Essai réel : `npm run test:live`. **Dépense de l'argent.**
 *
 * C'est le seul test qui prouve le livrable de la Slice 2 — « le coût affiché
 * correspond à la facture ». Tous les autres tournent contre un faux
 * fournisseur, ce qui est voulu : ils doivent être gratuits, hors ligne et
 * reproductibles. Celui-ci ne peut être aucun des trois, et c'est pourquoi il
 * est **opt-in** et séparé de `npm test`.
 *
 * Il ne tourne que si une clé est déjà déposée dans le coffre, sous la
 * référence d'un fournisseur configuré. Sans clé, il **s'abstient** au lieu
 * d'échouer : une absence de clé n'est pas un défaut du code.
 *
 *  - L1 le Researcher est annoncé disponible, et il l'est réellement ;
 *  - L2 une vraie tâche aboutit à un résultat structuré, outils à l'appui ;
 *  - L3 **le coût affiché correspond au solde réellement débité** ;
 *  - L5 ce qui revient du web est marqué non fiable, avec ses sources.
 *
 * Le solde est relevé chez Venice **avant et après**, et comparé à ce que le
 * harness a compté. C'est la seule façon de vérifier qu'on ne raconte pas
 * d'histoires : un tableau de tarifs peut mentir, un solde non.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { daemonJson, loadConfig, type Agent, type ProviderConfig, type TaskView } from '@midgaard/contracts'
import { ensureDaemon } from '@midgaard/cli'
import { openVault } from '@midgaard/secrets'
import { scenario, summarize, tempHome, type Outcome } from './helpers.ts'

/** Identifiant du fournisseur attendu dans le coffre de l'utilisateur. */
const PROVIDER_ID = process.env.MIDGAARD_LIVE_PROVIDER ?? 'venice'
/** Modèle employé. Bon marché, appelle des outils, sait chercher sur le web. */
const MODEL = process.env.MIDGAARD_LIVE_MODEL ?? 'deepseek-v4-flash-0731'

const outcomes: Outcome[] = []

// --- La clé existe-t-elle ? -------------------------------------------------
// On lit le coffre **de l'utilisateur**, pas celui du test : c'est là que
// `harness providers add` l'a déposée. Le dossier runtime de l'essai, lui,
// restera jetable.
const realConfig = loadConfig({ MIDGAARD_HOME: join(homedir(), '.midgaard') })
const userVault = await openVault(realConfig, process.env)
const apiKey = await userVault.get(`provider.${PROVIDER_ID}`)

if (!apiKey) {
  console.log(`Aucune clé pour « ${PROVIDER_ID} » dans le coffre (${userVault.label}).`)
  console.log('Cet essai réel est ignoré — ce n\'est pas un échec.')
  console.log()
  console.log('Pour le rendre exécutable :')
  console.log(`  npm run harness -- providers add ${PROVIDER_ID} --model ${MODEL}`)
  process.exit(0)
}

// --- Dossier runtime jetable, coffre fichier --------------------------------
// `MIDGAARD_VAULT=file` est essentiel : le coffre système est par **utilisateur**,
// pas par dossier runtime. Sans cela, l'essai réécrirait la clé de l'utilisateur
// sous la même référence.
const { config, cleanup } = tempHome('live')
// `ensureDaemon` transmet l'environnement courant au daemon qu'il lance.
process.env.MIDGAARD_PORT = '0'
process.env.MIDGAARD_VAULT = 'file'
/** Le dépôt lui-même : c'est lui que le Researcher lit (L2). */
const REPO = fileURLToPath(new URL('..', import.meta.url))

/**
 * Délègue une tâche au Researcher par l'API du daemon, comme le fait le
 * dashboard. Aucune limite ne borne plus une tâche : ce que dépense cet essai
 * n'est borné que par ses objectifs, courts, et par le solde du compte.
 *
 * @returns l'identifiant de la tâche, ou `null` avec le motif du refus
 */
async function delegate(
  objective: string,
  context: string,
): Promise<{ id: string | null; refusal: string }> {
  const res = await daemonJson<Partial<TaskView> & { error?: string; reason?: string }>(rt, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ objective, agent_id: 'researcher', context, project_dir: REPO }),
  })
  return { id: res.body.task?.id ?? null, refusal: `${res.status} ${res.body.error ?? ''} ${res.body.reason ?? ''}`.trim() }
}

/**
 * Solde du compte, relevé **chez le fournisseur**.
 *
 * C'est le juge de paix du livrable : notre comptage n'a de valeur que comparé
 * à ce que le fournisseur débite réellement.
 *
 * @returns le solde en dollars, ou `null` si l'endpoint ne le donne pas
 */
async function balance(): Promise<number | null> {
  const res = await fetch('https://api.venice.ai/api/v1/api_keys/rate_limits', {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) return null
  const body = (await res.json()) as { data?: { balances?: Record<string, number> } }
  const usd = body.data?.balances?.USD
  return typeof usd === 'number' ? usd : null
}

/**
 * Attend qu'une tâche se termine, en enchaînant les attentes longues du daemon
 * (`/api/tasks/:id/wait`, bornées à 60 s par appel côté daemon).
 */
async function runToEnd(taskId: string, maxWaits = 14): Promise<TaskView> {
  let last = (await daemonJson<TaskView>(rt, `/api/tasks/${taskId}`)).body
  for (let i = 0; i < maxWaits; i++) {
    last = (await daemonJson<TaskView>(rt, `/api/tasks/${taskId}/wait?timeout_ms=25000`)).body
    if (last.next_action !== 'call_wait_for_task_again') return last
  }
  return last
}

/**
 * Somme ce que le harness a compté sur **toutes** les tâches de cet essai.
 *
 * Cumuler scénario par scénario paraissait plus simple ; c'était faux. Une
 * tâche dont l'attente échoue continue de tourner côté daemon — et de dépenser.
 * Son coût manquait alors au total, et l'écart avec le solde débité accusait le
 * comptage pour une erreur du test. On interroge donc le registre du daemon,
 * qui est de toute façon la source de vérité.
 */
async function coutCompte(): Promise<{ total: number; taches: number }> {
  const { body } = await daemonJson<{ tasks: { usage: { cost_usd: number } }[] }>(rt, '/api/tasks?limit=500')
  return {
    total: body.tasks.reduce((sum, t) => sum + (t.usage?.cost_usd ?? 0), 0),
    taches: body.tasks.length,
  }
}

// --- Montage ----------------------------------------------------------------
// Démarre le daemon de l'essai, comme le ferait `harness start`.
const rt = await ensureDaemon(config, () => {})

// On déclare le fournisseur dans le dossier jetable, avec la clé lue du coffre
// de l'utilisateur. Elle sera déposée dans le coffre **fichier** de l'essai.
const declared = await daemonJson<{ provider?: ProviderConfig; error?: string }>(rt, '/api/providers', {
  method: 'POST',
  body: JSON.stringify({ id: PROVIDER_ID, preset: 'venice', default_model: MODEL, api_key: apiKey }),
})
if (declared.status !== 200) {
  console.error('déclaration du fournisseur refusée :', declared.body.error)
  process.exit(1)
}

const soldeAvant = await balance()
console.log(`Solde Venice avant l'essai : ${soldeAvant === null ? 'inconnu' : `${soldeAvant.toFixed(6)} $`}`)
console.log(`Modèle : ${MODEL} · aucune limite par tâche : le solde du compte est le seul plafond`)
console.log()


// --- L1 ---------------------------------------------------------------------
await scenario(outcomes, 'L1 le Researcher est annoncé disponible, et il l\'est', async () => {
  const { body } = await daemonJson<{ agents: Agent[] }>(rt, '/api/agents')
  const researcher = body.agents.find((a) => a.id === 'researcher')
  if (!researcher) return { verdict: 'FAIL', detail: 'profil researcher absent de la liste' }
  if (!researcher.enabled || researcher.disabled_reason) {
    return { verdict: 'FAIL', detail: `annoncé désactivé : ${researcher.disabled_reason ?? 'sans motif'}` }
  }
  const test = await daemonJson<{ test: { ok: boolean; detail: string } }>(
    rt,
    `/api/providers/${PROVIDER_ID}/test`,
    { method: 'POST' },
  )
  return {
    verdict: test.body.test.ok ? 'PASS' : 'FAIL',
    detail: `researcher actif, outils : ${researcher.tools.length} — ${test.body.test.detail}`,
  }
})

// --- L2 ---------------------------------------------------------------------
await scenario(outcomes, 'L2 une vraie tâche aboutit à un résultat structuré', async () => {
  const start = await delegate(
    'What is the minimum Node.js version this repository requires, and why exactly that version? ' +
      'Answer from the repository files only. Cite the files you read.',
    'This is the Midgaard repository. The answer is stated in README.md and justified in docs/SLICE1.md. ' +
      'Do not search the web for this one.',
  )
  if (!start.id) return { verdict: 'FAIL', detail: `délégation refusée : ${start.refusal}` }

  const fin = await runToEnd(start.id)
  if (fin.next_action !== 'result_ready') {
    return { verdict: 'FAIL', detail: `${fin.task.status} — ${fin.task.error ?? 'sans résultat'}` }
  }
  const u = fin.task.usage
  const resume = String(fin.task.result?.summary ?? '').slice(0, 110)
  return {
    verdict: 'PASS',
    detail: `${u.model_calls} appel(s), ${u.cost_usd} $ (${u.cost_source}) — « ${resume}… »`,
  }
})

// --- L5 ---------------------------------------------------------------------
await scenario(outcomes, 'L5 ce qui revient du web est marqué non fiable, avec ses sources', async () => {
  const start = await delegate(
    'Which Node.js release lines are currently in Active LTS? Answer in one sentence, with sources.',
    'You will need the web for this one; the repository does not contain the answer.',
  )
  if (!start.id) return { verdict: 'FAIL', detail: `délégation refusée : ${start.refusal}` }
  const fin = await runToEnd(start.id)
  if (fin.next_action !== 'result_ready') {
    return { verdict: 'CONSTAT', detail: `${fin.task.status} — ${fin.task.error ?? 'sans résultat'}` }
  }
  // L'encadrement `<untrusted_data>` était posé par l'ancienne façade MCP au
  // moment de rendre le résultat ; ce que le daemon garantit, et que lisent
  // l'orchestrateur et le dashboard, c'est le drapeau `untrusted` du résultat.
  const result = fin.task.result
  const citations = result?.citations ?? []
  if (citations.length === 0) {
    return { verdict: 'CONSTAT', detail: 'le modèle n\'a cité aucune source : rien à marquer' }
  }
  return {
    verdict: result?.untrusted ? 'PASS' : 'FAIL',
    detail: `${citations.length} source(s), résultat ${result?.untrusted ? 'marqué non fiable' : 'NON MARQUÉ'} — ${citations[0]?.url ?? ''}`,
  }
})

// --- L3 : le juge de paix ---------------------------------------------------
await scenario(outcomes, 'L3 le coût affiché correspond au solde débité', async () => {
  if (soldeAvant === null) return { verdict: 'CONSTAT', detail: 'solde indisponible avant l\'essai' }
  // Le solde peut mettre un instant à refléter les derniers appels.
  await sleep(4000)
  const soldeApres = await balance()
  if (soldeApres === null) return { verdict: 'CONSTAT', detail: 'solde indisponible après l\'essai' }

  const { total: compte, taches } = await coutCompte()
  const debite = soldeAvant - soldeApres
  const ecart = Math.abs(debite - compte)
  const relatif = debite === 0 ? (compte === 0 ? 0 : 1) : ecart / debite
  const detail =
    `${taches} tâche(s) : compté ${compte.toFixed(6)} $, débité ${debite.toFixed(6)} $ ` +
    `(${soldeAvant.toFixed(6)} → ${soldeApres.toFixed(6)}), écart ${(relatif * 100).toFixed(1)} %`
  // 2 % de tolérance : les arrondis du fournisseur et notre somme de nombres
  // flottants ne tomberont jamais au centième de centime près.
  return { verdict: relatif <= 0.02 ? 'PASS' : 'FAIL', detail }
})

await daemonJson(rt, '/api/shutdown', { method: 'POST' }).catch(() => {})
await sleep(300)
cleanup()
process.exitCode = summarize(outcomes, 'Essai réel — agents Venice')
