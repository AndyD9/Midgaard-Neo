/**
 * @file Suite d'interface du dashboard : `npm run test:ui` (environ 1 min).
 *
 * C'est le report qui durait depuis la Slice 1, et la dette n° 4 de la Slice 2.
 * Jusqu'ici le dashboard n'avait qu'un test de ses **fonctions pures**
 * (`tests/unit/dashboard-format.test.ts`) : aucun rendu, aucun chargement,
 * aucune régression visible. Or l'interface porte désormais des coûts, des
 * appels d'outils, des sources, et le seul bouton du harness qui **débloque**
 * une tâche.
 *
 * Ce qui est éprouvé ici ne l'est nulle part ailleurs, et chaque scénario vise
 * un invariant écrit, pas un pixel :
 *
 *  - D1 l'URL annoncée sert une **application qui démarre**, pas un fichier —
 *    c'est le défaut n° 1 de la Slice 0, poussé jusqu'au bout : S8 vérifie que
 *    l'URL répond, D1 vérifie qu'elle vit ;
 *  - D2 une tâche créée apparaît **sans rechargement** : la promesse du direct ;
 *  - D3 la progression avance seule, et sur le **vrai dénominateur** (défaut
 *    n° 3 de l'essai en vraie session) ;
 *  - D4 une approbation se donne **depuis le dashboard** et débloque la tâche —
 *    chemin que la Slice 2 reconnaissait n'avoir pas rejoué ;
 *  - D5 une tâche sans appel de modèle n'affiche **pas** « 0 $ » : zéro est un
 *    coût, pas une ignorance ;
 *  - D6 un lien profond rouvre la bonne tâche après rechargement ;
 *  - D7 la perte de la WebSocket **se voit** : un dashboard muet qui affiche
 *    des données d'apparence normale est pire qu'un dashboard en panne ; et,
 *    le daemon revenu avec le même bundle, la page ne se recharge pas ;
 *  - D8 le diff d'une tâche Developer **se lit** : branche, fichiers, et le
 *    patch d'un fichier déplié — le livrable « diff consultable » de la
 *    Slice 3, avec un faux fournisseur qui joue les appels d'outils ;
 *  - D9 le formulaire « Nouvelle tâche » ne propose **que des profils actifs**
 *    et dit pourquoi les autres ne le sont pas, puis lance une tâche (Slice 5) ;
 *  - D10 le modèle d'un profil se choisit dans la vue « Profils » ;
 *  - D11 un orchestrateur lancé du formulaire : dossier refusé avec son motif
 *    puis accepté, sous-tâche rangée sous son parent, carte « Sous-tâches »
 *    avec le plafond théorique et le total de l'arbre **avec sa provenance**,
 *    lien de l'enfant vers son parent ;
 *  - D12 une conversation dans le flux : la réplique de
 *    l'orchestrateur s'affiche, la saisie ne s'ouvre que lorsqu'il attend, le
 *    message part, et la conversation se ferme sur son résultat ;
 *  - D13 le flux suit un Developer : il montre la sortie d'une
 *    commande **pendant** qu'elle tourne, puis la commande entière ;
 *  - D14 le dashboard montre ce que voit un Navigator : la vision se
 *    déclare dans « Profils », l'image lue s'affiche dans le flux, la lecture
 *    « Navigateur » s'ouvre seul sur la capture, la saisie à approuver s'y
 *    lit, et « Couper la session » coupe — la saisie approuvée ensuite ne part
 *    pas. Il tourne sur un second daemon, **dans ce processus**, pour lui
 *    passer une garde qui admet la page locale du test : `main.ts` n'en pose
 *    jamais, et la vraie refuse la boucle locale ;
 *  - D15 une page plus vieille que son daemon **se recharge** : remplacé par
 *    un daemon qui sert un autre bundle, l'ancien code ne tourne pas contre
 *    lui. C'est ce qui laissait vide la fenêtre desktop (Slice 7) ;
 *  - D16 les serveurs MCP aux Profils (Slice 8) : « Tester la connexion »
 *    relit le vrai catalogue, cocher demande confirmation et rend l'outil
 *    libre **en base**, décocher le rend approuvé, et un serveur se donne au
 *    Researcher — jamais proposé à l'orchestrateur ;
 *  - D17 un orchestrateur crée un exécutant (Slice 8) : la carte
 *    « Sous-tâches » montre l'agent créé **avec son rôle**, sans budget de
 *    l'arbre ;
 *  - D18 **aucune limite** ne se règle ni ne s'applique : aucun champ aux
 *    Profils, la route `PUT /api/agents/:id/limits` est retirée, un profil
 *    n'en porte plus.
 *  - D20 une clé se dépose depuis les Profils, sans terminal : champ masqué,
 *    vidé après l'envoi, clé absente de la page et de l'API ; le fournisseur
 *    la reçoit pourtant (relue au coffre) ; une clé remplacée l'est vraiment ;
 *    retirer se confirme.
 *  - D22 **le flux est l'interface** : le lien d'une tâche l'ouvre, il
 *    commence par l'objectif et rejoue le journal en lignes, porte l'invite
 *    vers l'orchestrateur ; « détails » se lit à la demande, `#/terminal/<id>`
 *    ramène au flux, et rien de l'atelier d'origine ne reste.
 *
 * Playwright est employé en **bibliothèque**, pas en lanceur : les suites de ce
 * dépôt ont leur forme (`scenario`, `summarize`, verdicts), et ajouter un second
 * lanceur avec sa configuration et son rapporteur coûterait plus qu'il ne rend.
 *
 * Prérequis, tous deux vérifiés avant le premier scénario et dits avec la
 * commande exacte : le dashboard compilé, et le navigateur de Playwright
 * téléchargé — `npm ci` ne le fait pas.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright'
import {
  daemonJson, pidAlive, readRuntime, type Agent, type Approval, type ProviderConfig, type RuntimeInfo, type Task, type TaskView,
} from '@midgaard/contracts'
import { NAVIGATOR_AGENT_ID, StaticFiles, defaultDashboardDir, reconcileAgents, startDaemon as startInProcess } from '@midgaard/daemon'
import { assertPublicHost } from '@midgaard/tools'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { loadConfig } from '@midgaard/contracts'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeProvider } from './fake-provider.ts'
import { fileURLToPath } from 'node:url'
import { childEnv, nodeArgsFor, running, scenario, summarize, tempHome, type Outcome } from './helpers.ts'

/** Durée d'une tâche simulée : 5 étapes, donc 2 s par étape. Assez lent pour se voir. */
const TASK_S = 10
/** Plafond d'attente d'un élément à l'écran. Large : une CI lente ne doit pas rougir à tort. */
const UI_TIMEOUT = 20_000

const outcomes: Outcome[] = []
const { home, config, cleanup } = tempHome('ui')
let daemon: ChildProcess | undefined
let browser: Browser | undefined

/** Erreurs de la console du navigateur, collectées pour D1. */
const consoleErrors: string[] = []

// --- prérequis, dits avant de lancer quoi que ce soit ------------------------

const dashboard = new StaticFiles(defaultDashboardDir())
if (!dashboard.available) {
  console.error('Le dashboard n’est pas compilé : il n’y a rien à ouvrir.\n\n  npm run build\n')
  process.exit(1)
}

try {
  browser = await chromium.launch()
} catch (e) {
  console.error(
    `Le navigateur de Playwright est absent : ${(e as Error).message.split('\n')[0]}\n\n` +
      '  npx playwright install chromium\n\n' +
      '`npm ci` ne télécharge pas les navigateurs ; c’est une étape à part, et volontaire.\n',
  )
  process.exit(1)
}

// --- daemon réel, dossier jetable -------------------------------------------

/**
 * Démarre le daemon et attend qu'il réponde, comme le fait `tests/restart.ts`.
 *
 * @param port        port à imposer ; `0` laisse le système choisir. D7 relance
 *                    sur **le même port**, sans quoi la page ouverte viserait
 *                    une autre origine et ne pourrait pas se reconnecter.
 * @param previousPid pid du daemon précédent, pour ne pas confondre son fichier
 *                    de découverte encore présent avec celui du nouveau
 * @param extra       variables de plus : D15 y désigne un autre dashboard
 */
async function startDaemon(port = 0, previousPid?: number, extra: Record<string, string> = {}): Promise<RuntimeInfo> {
  daemon = spawn(process.execPath, nodeArgsFor('@midgaard/daemon/main'), {
    env: childEnv(home, { MIDGAARD_PORT: String(port), ...extra }),
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    const info = readRuntime(config.runtimeFile)
    if (
      info &&
      info.pid !== previousPid &&
      (await daemonJson(info, '/api/health').then((r) => r.status === 200).catch(() => false))
    ) {
      return info
    }
    await sleep(100)
  }
  throw new Error('le daemon n’a pas répondu en 10 s')
}

const rt = await startDaemon()

/** Crée une tâche simulée par l'API du daemon, comme le ferait le serveur MCP. */
async function createTask(objective: string, needsApproval = false): Promise<TaskView> {
  const { body } = await daemonJson<TaskView>(rt, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ objective, duration_s: TASK_S, needs_approval: needsApproval }),
  })
  return body
}

/** État courant d'une tâche, lu côté daemon : la vérité, indépendante de l'écran. */
async function taskNow(id: string): Promise<TaskView['task']> {
  return (await daemonJson<TaskView>(rt, `/api/tasks/${id}`)).body.task
}

/** Attend qu'une condition soit vraie côté daemon, ou rend faux au bout du délai. */
async function until(predicate: () => Promise<boolean>, timeoutMs = UI_TIMEOUT): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(200)
  }
  return false
}

// --- navigateur --------------------------------------------------------------

const page: Page = await browser.newPage()
page.on('console', (m: ConsoleMessage) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e: Error) => consoleErrors.push(`exception : ${e.message}`))

/** Raccourci : attend qu'un texte soit visible, et dit vrai/faux plutôt que de lever. */
async function sees(text: string | RegExp, timeout = UI_TIMEOUT): Promise<boolean> {
  try {
    await page.getByText(text).first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

/**
 * Ouvre la lecture « détails » de la tâche affichée. La colonne de travail
 * montre le flux par défaut : ce qui ne tient pas en lignes (diff, sous-tâches,
 * agents créés) se lit dans les détails, et un humain y va par ce même clic.
 */
async function openDetails(): Promise<void> {
  await page.getByTestId('tab-details').click({ timeout: UI_TIMEOUT })
}

/**
 * Attend un état de connexion **dans le bandeau**, et nulle part ailleurs.
 *
 * `getByText('en direct')` ne suffit pas : l'écran vide contient « Elle
 * apparaîtra ici en direct. », et le premier jet de ce fichier a donc cru la
 * WebSocket ouverte alors qu'elle ne l'était pas — un faux positif dans un test
 * écrit précisément pour attraper les faux positifs de l'interface. Le bandeau
 * est un `<header>` ; on y restreint la recherche.
 *
 * @param label `en direct`, `déconnecté` ou `connexion…`
 */
async function connection(label: string, timeout = UI_TIMEOUT): Promise<boolean> {
  try {
    await page.locator('header').getByText(label).first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

// --- D1 ----------------------------------------------------------------------

await scenario(outcomes, 'D1 l’URL annoncée sert une application qui démarre', async () => {
  // `rt.dashboard_url` est l'URL que le daemon donne à Claude et à l'utilisateur.
  // On ouvre **celle-là**, pas une URL reconstruite : c'est elle qui est promise.
  await page.goto(rt.dashboard_url, { waitUntil: 'domcontentloaded' })

  // « en direct » n'apparaît que si trois choses ont marché d'affilée : les
  // fichiers servis, `/ui/bootstrap` qui rend le jeton, et la WebSocket ouverte
  // avec. Un seul texte, mais il couvre toute la chaîne de démarrage.
  const live = await connection('en direct')
  // Expression régulière plutôt que texte exact : l'apostrophe du JSX est
  // typographique ou droite selon l'humeur de l'éditeur, et ce test n'a pas à
  // en dépendre.
  const empty = await sees(/Rien à observer/)
  // Les exécutants sont montrés dès l'écran vide, avec leur motif de désactivation.
  const agents = await sees('simulated')

  if (!live) return { verdict: 'FAIL', detail: 'la WebSocket ne s’est jamais ouverte (badge « en direct » absent)' }
  if (!empty) return { verdict: 'FAIL', detail: 'l’écran vide n’explique pas quoi faire' }
  if (!agents) return { verdict: 'FAIL', detail: 'l’écran vide ne montre pas les exécutants' }
  if (consoleErrors.length) {
    return { verdict: 'FAIL', detail: `erreur(s) de console au démarrage : ${consoleErrors.join(' | ')}` }
  }
  return { verdict: 'PASS', detail: 'application montée, bootstrap obtenu, WebSocket ouverte, console muette' }
})

// --- D2 ----------------------------------------------------------------------

const vue = await (async () => {
  let created: TaskView | undefined
  await scenario(outcomes, 'D2 une tâche apparaît sans rechargement', async () => {
    const objective = 'Tâche observée en direct depuis le dashboard'
    // Aucune navigation après ce point : si le texte arrive, il est arrivé par
    // la WebSocket. C'est toute la promesse du direct.
    created = await createTask(objective)
    const appeared = await sees(objective)
    if (!appeared) return { verdict: 'FAIL', detail: 'la tâche n’est jamais apparue sans rechargement' }
    return { verdict: 'PASS', detail: `« ${created.task.id.slice(0, 8)}… » apparue par la WebSocket` }
  })
  return created
})()

// --- D3 ----------------------------------------------------------------------

await scenario(outcomes, 'D3 la progression avance seule, sur le vrai dénominateur', async () => {
  if (!vue) return { verdict: 'FAIL', detail: 'D2 n’a pas créé de tâche' }
  const attendu = vue.task.steps_total

  // Le dénominateur est l'invariant : le défaut n° 3 de l'essai en vraie session
  // affichait « 6/5 » parce que toutes les tâches héritaient de la constante du
  // simulé. Ici la tâche **est** simulée, donc 5 est juste — ce qu'on vérifie,
  // c'est que l'écran montre le `steps_total` de la tâche, et pas autre chose.
  const etape = page.getByText(/étape \d+\/\d+/).first()
  await etape.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
  const premier = (await etape.textContent()) ?? ''
  const m = /étape (\d+)\/(\d+)/.exec(premier)
  if (!m) return { verdict: 'FAIL', detail: `progression illisible : ${JSON.stringify(premier)}` }
  if (Number(m[2]) !== attendu) {
    return { verdict: 'FAIL', detail: `dénominateur ${m[2]} affiché, ${attendu} attendu (steps_total de la tâche)` }
  }

  // Puis on regarde l'écran bouger, sans y toucher.
  const depart = Number(m[1])
  const bougé = await until(async () => {
    const t = (await etape.textContent()) ?? ''
    const n = /étape (\d+)\//.exec(t)
    return n ? Number(n[1]) > depart : false
  })
  if (!bougé) return { verdict: 'FAIL', detail: `la progression est restée à ${depart}/${attendu}` }
  return { verdict: 'PASS', detail: `étape ${depart}/${attendu} → avancée sans rechargement` }
})

// --- D5 (avant D4 : la tâche de D2 est encore sans appel de modèle) ----------

await scenario(outcomes, 'D5 une tâche sans appel de modèle n’affiche pas « 0 $ »', async () => {
  if (!vue) return { verdict: 'FAIL', detail: 'D2 n’a pas créé de tâche' }
  const t = await taskNow(vue.task.id)
  if (t.usage.model_calls !== 0) {
    return { verdict: 'FAIL', detail: `la tâche simulée a compté ${t.usage.model_calls} appel(s) : scénario invalide` }
  }
  // La ligne de la tâche dans la liste, et l'inspecteur : ni l'un ni l'autre ne
  // doit inventer un montant. Zéro est un coût ; ici il n'y a pas de mesure.
  const ligne = page.getByRole('button', { name: new RegExp(vue.task.objective.slice(0, 30)) }).first()
  await ligne.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
  const texte = (await ligne.textContent()) ?? ''
  if (/\d\s*\$/.test(texte)) {
    return { verdict: 'FAIL', detail: `un montant est affiché sans appel de modèle : ${JSON.stringify(texte.trim())}` }
  }
  return { verdict: 'PASS', detail: 'aucun montant affiché, et aucun « 0 $ » inventé' }
})

// --- D4 ----------------------------------------------------------------------

await scenario(outcomes, 'D4 une approbation donnée dans le dashboard débloque la tâche', async () => {
  const objective = 'Tâche qui demande une décision humaine'
  const t = await createTask(objective, true)

  // On clique la tâche dans la liste avant d'attendre le panneau. Le dashboard
  // n'ouvre pas tout seul la nouvelle venue, et c'est **voulu** : `App.tsx`
  // explique que la tâche qu'on regarde s'échapperait au moment même où on
  // l'approuve, puisqu'elle cesserait alors d'être celle qui attend. Le
  // premier jet de ce scénario a pris ce comportement pour une panne.
  const ligne = page.getByRole('button', { name: new RegExp(objective) }).first()
  await ligne.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
  await ligne.click()

  // Le panneau doit nommer **l'opération exacte** : une approbation vaut pour
  // elle et pour elle seule.
  const panneau = await sees('Décision humaine requise')
  if (!panneau) return { verdict: 'FAIL', detail: 'le panneau d’approbation ne s’est pas ouvert' }

  const attente = await until(async () => (await taskNow(t.task.id)).status === 'waiting_approval')
  if (!attente) return { verdict: 'FAIL', detail: 'la tâche n’est jamais passée en waiting_approval' }

  const { body } = await daemonJson<{ approvals: Approval[] }>(rt, '/api/approvals')
  const demande = body.approvals.find((a) => a.task_id === t.task.id)
  if (!demande) return { verdict: 'FAIL', detail: 'aucune demande d’approbation côté daemon' }
  if (!(await sees(demande.operation))) {
    return { verdict: 'FAIL', detail: `le panneau ne montre pas l’opération : ${JSON.stringify(demande.operation)}` }
  }

  // Le clic est l'acte humain. C'est le seul chemin d'approbation du dashboard,
  // et la Slice 2 ne l'avait pas rejoué faute d'outil qui en demande une.
  await page.getByRole('button', { name: 'Approuver' }).click()

  const reprise = await until(async () => (await taskNow(t.task.id)).status === 'completed', TASK_S * 1000 + UI_TIMEOUT)
  if (!reprise) {
    return { verdict: 'FAIL', detail: `la tâche est restée en ${(await taskNow(t.task.id)).status} après le clic` }
  }
  // Et l'écran doit le dire, sans rechargement.
  if (!(await sees('completed'))) return { verdict: 'FAIL', detail: 'la tâche est finie, l’écran l’ignore' }
  return { verdict: 'PASS', detail: `approuvée au clic, tâche reprise et terminée (${demande.id.slice(0, 8)}…)` }
})

// --- D6 ----------------------------------------------------------------------

await scenario(outcomes, 'D6 un lien profond rouvre la bonne tâche après rechargement', async () => {
  if (!vue) return { verdict: 'FAIL', detail: 'D2 n’a pas créé de tâche' }
  const id = vue.task.id
  // Le fragment est la source de vérité de la sélection : un lien d'approbation
  // transmis à quelqu'un doit ouvrir **sa** tâche, y compris après un F5.
  await page.goto(`${rt.dashboard_url}#/tasks/${id}`, { waitUntil: 'domcontentloaded' })
  if (!(await sees(id))) return { verdict: 'FAIL', detail: 'le lien profond n’a pas ouvert la tâche' }
  await page.reload({ waitUntil: 'domcontentloaded' })
  if (!(await sees(id))) return { verdict: 'FAIL', detail: 'le rechargement a perdu la sélection' }
  return { verdict: 'PASS', detail: `#/tasks/${id.slice(0, 8)}… ouvre et survit au rechargement` }
})

// --- D9 (avant D8 : aucun fournisseur n'est encore déclaré) -----------------

await scenario(outcomes, 'D9 le formulaire ne propose que les profils actifs, et lance une tâche', async () => {
  await page.goto(`${rt.dashboard_url}#/new`, { waitUntil: 'domcontentloaded' })
  try {
    await page.getByTestId('new-task-form').waitFor({ state: 'visible', timeout: UI_TIMEOUT })
  } catch {
    return { verdict: 'FAIL', detail: 'le formulaire « Nouvelle tâche » ne s’affiche pas sur #/new' }
  }
  // Sans fournisseur, seul le profil simulé peut recevoir une tâche : c'est le
  // seul proposé, et les autres sont nommés avec leur motif, pas cachés.
  const options = await page
    .getByTestId('new-task-agent')
    .locator('option')
    .evaluateAll((os) => os.map((o) => o.getAttribute('value') ?? ''))
  if (options.join(',') !== 'simulated') return { verdict: 'FAIL', detail: `profils proposés : ${options.join(', ')}` }
  const inactive = (await page.getByTestId('new-task-inactive').textContent()) ?? ''
  if (!/orchestrator indisponible — aucun fournisseur/.test(inactive)) {
    return { verdict: 'FAIL', detail: `motif absent pour l’orchestrateur : « ${inactive} »` }
  }

  const objective = '[D9] tâche lancée du dashboard'
  await page.getByTestId('new-task-objective').fill(objective)
  await page.getByTestId('new-task-submit').click()
  try {
    await page.waitForURL(/#\/tasks\/[0-9a-f-]{36}$/, { timeout: UI_TIMEOUT })
  } catch {
    return { verdict: 'FAIL', detail: 'le formulaire n’ouvre pas la tâche créée' }
  }
  const id = /#\/tasks\/([0-9a-f-]{36})$/.exec(page.url())![1]!
  const created = await taskNow(id)
  await daemonJson(rt, `/api/tasks/${id}/cancel`, { method: 'POST' })
  if (created.objective !== objective) return { verdict: 'FAIL', detail: `tâche créée : « ${created.objective} »` }
  if (!(await sees(objective))) return { verdict: 'FAIL', detail: 'la tâche créée ne s’affiche pas' }
  return { verdict: 'PASS', detail: `seul « simulated » proposé, motifs des autres affichés ; tâche ${id.slice(0, 8)} créée et ouverte` }
})

// --- D8 ----------------------------------------------------------------------

await scenario(outcomes, 'D8 le diff d’une tâche Developer se lit dans le dashboard', async () => {
  const provider = await startFakeProvider()
  const repos = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-ui-repo-')))
  try {
    await daemonJson(rt, '/api/providers', {
      method: 'POST',
      body: JSON.stringify({ id: 'faux', preset: 'custom', base_url: provider.url, default_model: 'faux-1', api_key: 'sk-faux-0000' }),
    })
    const repo = join(repos, 'projet')
    mkdirSync(join(repo, 'src'), { recursive: true })
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@example.org', '-c', 'commit.gpgsign=false', ...a], {
        cwd: repo,
        stdio: 'ignore',
      })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const routes = ["/"]\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')

    provider.scripts.set('[D8]', [
      [{ tool: 'write_file', args: { path: 'src/health.ts', content: 'export const health = () => "ok"\n' } }],
      [{ tool: 'submit_result', args: { summary: 'route /health ajoutée', details: 'src/health.ts' } }],
    ])
    const { body: created } = await daemonJson<TaskView>(rt, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ objective: '[D8] ajouter /health', agent_id: 'developer', project_dir: repo }),
    })
    const id = created.task.id
    if (!(await until(async () => (await taskNow(id)).status === 'completed'))) {
      const t = await taskNow(id)
      return { verdict: 'FAIL', detail: `tâche non terminée : ${t.status} — ${t.error}` }
    }
    const branch = (await taskNow(id)).result?.workspace?.branch ?? '(absente)'

    await page.goto(`${rt.dashboard_url}#/tasks/${id}`, { waitUntil: 'domcontentloaded' })
    await openDetails()
    const card = page.getByTestId('workspace-card')
    try {
      await card.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
    } catch {
      return { verdict: 'FAIL', detail: 'aucune carte « Fichiers et diff » pour une tâche Developer' }
    }
    if ((await card.getByTestId('workspace-branch').textContent()) !== branch) {
      return { verdict: 'FAIL', detail: `branche affichée différente de ${branch}` }
    }
    const file = card.getByTestId('workspace-files').getByText('src/health.ts')
    if (!(await file.isVisible())) return { verdict: 'FAIL', detail: 'le fichier créé n’est pas listé' }
    await file.click()
    // La ligne ajoutée, telle quelle, dans le patch déplié : rien n'en est interprété.
    if (!(await sees('+export const health = () => "ok"'))) {
      return { verdict: 'FAIL', detail: 'le patch du fichier ne s’affiche pas au clic' }
    }
    if (!(await sees(`git merge ${branch}`))) return { verdict: 'FAIL', detail: 'la commande de merge n’est pas montrée' }
    return { verdict: 'PASS', detail: `${branch} : fichier listé, patch déplié au clic, commande de merge montrée` }
  } finally {
    provider.server.close()
    rmSync(repos, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// --- D10 (après D8 : le fournisseur « faux » existe) -------------------------

await scenario(outcomes, 'D10 le modèle d’un profil se choisit dans le dashboard', async () => {
  const before = (await daemonJson<{ agent: Agent }>(rt, '/api/agents/orchestrator')).body.agent
  await page.goto(`${rt.dashboard_url}#/agents`, { waitUntil: 'domcontentloaded' })
  const input = page.getByTestId('agent-model-orchestrator')
  try {
    await input.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
  } catch {
    return { verdict: 'FAIL', detail: 'aucun champ de modèle pour l’orchestrateur dans la vue « Profils »' }
  }
  await input.fill('faux-2')
  await page.getByTestId('agent-save-orchestrator').click()
  if (!(await sees(/enregistré : faux · faux-2/))) return { verdict: 'FAIL', detail: 'aucune confirmation à l’écran' }
  const after = (await daemonJson<{ agent: Agent }>(rt, '/api/agents/orchestrator')).body.agent
  if (after.model !== 'faux-2') return { verdict: 'FAIL', detail: `modèle en base : ${after.model}` }
  return { verdict: 'PASS', detail: `orchestrator : ${before.model ?? 'modèle par défaut'} → ${after.model}` }
})

// --- D11 ---------------------------------------------------------------------

/** Libellé de provenance de la carte « Sous-tâches », par provenance. */
const SOURCE_LABEL = { provider: 'facturé', pricing_table: 'estimé', unknown: 'inconnu' } as const

await scenario(outcomes, 'D11 un orchestrateur lancé du formulaire, et son arbre', async () => {
  const provider = await startFakeProvider()
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-ui-orch-')))
  try {
    // Le faux fournisseur de D8 est arrêté : on redéclare « faux » sur celui-ci.
    await daemonJson(rt, '/api/providers', {
      method: 'POST',
      body: JSON.stringify({ id: 'faux', preset: 'custom', base_url: provider.url, default_model: 'faux-1', api_key: 'sk-faux-0000' }),
    })
    writeFileSync(join(repo, 'README.md'), '# Projet\n')
    provider.scripts.set('[D11]', [
      [{ tool: 'list_agents', args: {} }],
      [{ tool: 'delegate_task', args: { agent_id: 'researcher', objective: '[D11-enfant] lis le README' } }],
      [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
      [{ tool: 'submit_result', args: { summary: 'le README dit Projet' } }],
    ])
    provider.scripts.set('[D11-enfant]', [[{ tool: 'submit_result', args: { summary: 'Projet' } }]])

    await page.goto(`${rt.dashboard_url}#/new`, { waitUntil: 'domcontentloaded' })
    await page.getByTestId('new-task-agent').waitFor({ state: 'visible', timeout: UI_TIMEOUT })
    await page.getByTestId('new-task-agent').selectOption('orchestrator')
    // Aucun plafond n'est annoncé, parce qu'il n'y en a plus : le formulaire
    // dit ce qui arrête une tâche, avant qu'on la lance.
    if (!/Aucune limite/.test((await page.getByTestId('new-task-unbounded').textContent()) ?? '')) {
      return { verdict: 'FAIL', detail: 'le formulaire ne dit pas qu’aucune limite ne borne la tâche' }
    }
    await page.getByTestId('new-task-objective').fill('[D11] orchestre la lecture du README')

    // Un dossier refusé l'est par le daemon, et son motif s'affiche tel quel.
    await page.getByTestId('new-task-dir').fill('/')
    await page.getByTestId('new-task-submit').click()
    if (!(await sees(/racine du système/))) return { verdict: 'FAIL', detail: '« / » accepté, ou refus sans motif' }

    await page.getByTestId('new-task-dir').fill(repo)
    await page.getByTestId('new-task-submit').click()
    try {
      await page.waitForURL(/#\/tasks\/[0-9a-f-]{36}$/, { timeout: UI_TIMEOUT })
    } catch {
      return { verdict: 'FAIL', detail: 'l’orchestrateur n’a pas été créé avec un dossier valide' }
    }
    const parentId = /#\/tasks\/([0-9a-f-]{36})$/.exec(page.url())![1]!
    if (!(await until(async () => (await taskNow(parentId)).status === 'completed'))) {
      const t = await taskNow(parentId)
      return { verdict: 'FAIL', detail: `orchestrateur non terminé : ${t.status} — ${t.error}` }
    }
    const all = (await daemonJson<{ tasks: Task[] }>(rt, '/api/tasks?limit=50')).body.tasks
    const child = all.find((t) => t.parent_task_id === parentId)
    if (!child) return { verdict: 'FAIL', detail: 'aucune sous-tâche rattachée à l’orchestrateur' }
    if (child.status !== 'completed') return { verdict: 'FAIL', detail: `sous-tâche ${child.status} — ${child.error}` }

    // La carte : plafond, total, et la provenance la plus faible de l'arbre.
    await openDetails()
    const card = page.getByTestId('subtasks-card')
    await card.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
    const ceiling = (await card.getByTestId('subtasks-ceiling').textContent()) ?? ''
    if (!/^\s*1 lancée\(s\)\s*$/.test(ceiling)) return { verdict: 'FAIL', detail: `compte affiché : « ${ceiling} »` }
    const parent = await taskNow(parentId)
    const measured = [parent, child].filter((t) => t.usage.model_calls > 0).map((t) => t.usage.cost_source)
    const weakest = measured.includes('unknown') ? 'unknown' : measured.includes('pricing_table') ? 'pricing_table' : 'provider'
    const total = (await card.getByTestId('subtasks-total').textContent()) ?? ''
    if (!total.includes(SOURCE_LABEL[weakest])) {
      return { verdict: 'FAIL', detail: `total sans la provenance attendue (${SOURCE_LABEL[weakest]}) : « ${total} »` }
    }

    // L'arbre dans la liste : l'enfant suit immédiatement son parent, en retrait.
    const rows = await page.locator('[data-testid^="task-row-"]').evaluateAll((els) =>
      els.map((e) => ({ id: e.getAttribute('data-testid'), depth: e.getAttribute('data-depth') })),
    )
    const at = rows.findIndex((r) => r.id === `task-row-${parentId}`)
    if (rows[at + 1]?.id !== `task-row-${child.id}` || rows[at + 1]?.depth !== '1') {
      return { verdict: 'FAIL', detail: 'la sous-tâche n’est pas rangée sous son orchestrateur' }
    }

    // De l'enfant au parent, par les liens de l'inspecteur.
    await card.getByTestId('subtasks-list').getByText('[D11-enfant]').click()
    await page.waitForURL(new RegExp(`#/tasks/${child.id}$`), { timeout: UI_TIMEOUT })
    await page.getByTestId('parent-link').getByRole('button').click()
    await page.waitForURL(new RegExp(`#/tasks/${parentId}$`), { timeout: UI_TIMEOUT })
    return {
      verdict: 'PASS',
      detail: `« / » refusé avec son motif ; arbre ${parentId.slice(0, 8)} → ${child.id.slice(0, 8)} rangé, 1/64, total ${SOURCE_LABEL[weakest]}, liens parent ↔ enfant`,
    }
  } finally {
    provider.server.close()
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// --- D12 ---------------------------------------------------------------------

/** Déclare (ou redéclare) le faux fournisseur auprès du daemon, sur sa nouvelle adresse. */
async function useProvider(url: string): Promise<void> {
  await daemonJson(rt, '/api/providers', {
    method: 'POST',
    body: JSON.stringify({ id: 'faux', preset: 'custom', base_url: url, default_model: 'faux-1', api_key: 'sk-faux-0000' }),
  })
}

/** Un dépôt Git jetable, avec ses fichiers de départ commités. */
function makeRepo(files: Record<string, string>): { repo: string; dispose: () => void } {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-ui-atelier-')))
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@example.org', '-c', 'commit.gpgsign=false', ...a], {
      cwd: repo,
      stdio: 'ignore',
    })
  git('init', '-q', '-b', 'main')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  return { repo, dispose: () => rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
}

await scenario(outcomes, 'D12 une conversation avec l’orchestrateur, dans le flux', async () => {
  const provider = await startFakeProvider()
  const { repo, dispose } = makeRepo({ 'README.md': '# Projet\n' })
  try {
    await useProvider(provider.url)
    provider.scripts.set('[D12]', [
      { text: 'Quel fichier dois-je lire ?' },
      [{ tool: 'submit_result', args: { summary: 'le README dit Projet' } }],
    ])
    const { body: created } = await daemonJson<TaskView>(rt, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ objective: '[D12] aide-moi', agent_id: 'orchestrator', project_dir: repo, conversation: true }),
    })
    const id = created.task.id
    await page.goto(`${rt.dashboard_url}#/tasks/${id}`, { waitUntil: 'domcontentloaded' })

    const chat = page.getByTestId('terminal-stream')
    try {
      await chat.locator('[data-type="message"]').getByText('Quel fichier dois-je lire ?').waitFor({ timeout: UI_TIMEOUT })
      await page.getByTestId('chat-input').waitFor({ state: 'visible', timeout: UI_TIMEOUT })
    } catch {
      return { verdict: 'FAIL', detail: `réplique ou saisie absente (tâche ${(await taskNow(id)).status})` }
    }
    await page.getByTestId('chat-input').fill('le README')
    await page.getByTestId('chat-send').click()

    if (!(await until(async () => (await taskNow(id)).status === 'completed'))) {
      const t = await taskNow(id)
      return { verdict: 'FAIL', detail: `conversation non conclue : ${t.status} — ${t.error}` }
    }
    try {
      await chat.locator('[data-type="vous"]').getByText('le README', { exact: true }).waitFor({ timeout: UI_TIMEOUT })
      await chat.locator('[data-type="terminée"]').getByText('le README dit Projet').waitFor({ timeout: UI_TIMEOUT })
    } catch {
      return { verdict: 'FAIL', detail: 'le message envoyé ou le résultat manque au fil' }
    }
    const closed = (await page.getByTestId('chat-closed').textContent({ timeout: UI_TIMEOUT })) ?? ''
    if (!/terminée/.test(closed)) return { verdict: 'FAIL', detail: `saisie encore ouverte après la fin : « ${closed} »` }
    return { verdict: 'PASS', detail: 'réplique vue, message envoyé de la saisie, résultat au fil, saisie refermée' }
  } finally {
    provider.server.close()
    dispose()
  }
})

// --- D13 ---------------------------------------------------------------------

await scenario(outcomes, 'D13 le flux suit un Developer : sortie en direct', async () => {
  const provider = await startFakeProvider()
  // Une ligne, deux secondes de silence, une autre : la première doit être à
  // l'écran pendant que la commande tourne encore.
  const { repo, dispose } = makeRepo({
    'src/app.ts': 'export const routes = ["/"]\n',
    'parle.js': "console.log('première ligne'); setTimeout(() => console.log('seconde ligne'), 2500)\n",
  })
  try {
    await useProvider(provider.url)
    provider.scripts.set('[D13]', [
      [{ tool: 'write_file', args: { path: 'src/health.ts', content: 'export const health = () => "v1"\n' } }],
      [{ tool: 'exec', args: { command: 'node', args: ['parle.js'] } }],
      [{ tool: 'submit_result', args: { summary: 'route /health ajoutée' } }],
    ])
    const { body: created } = await daemonJson<TaskView>(rt, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ objective: '[D13] ajouter /health', agent_id: 'developer', project_dir: repo }),
    })
    const id = created.task.id
    // La commande attend son approbation : le fichier v1 est écrit, rien d'autre.
    if (!(await until(async () => (await taskNow(id)).status === 'waiting_approval'))) {
      return { verdict: 'FAIL', detail: `pas de pause d'approbation : ${(await taskNow(id)).status}` }
    }

    await page.goto(`${rt.dashboard_url}#/tasks/${id}`, { waitUntil: 'domcontentloaded' })

    const approval = (await daemonJson<{ approvals: Approval[] }>(rt, '/api/approvals')).body.approvals.find((a) => a.task_id === id)
    if (!approval) return { verdict: 'FAIL', detail: 'aucune approbation pour la commande' }
    await daemonJson(rt, `/api/approvals/${approval.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })

    // Pendant la commande : la première ligne est à l'écran, la seconde pas encore.
    const rows = page.getByTestId('terminal-stream')
    const live = await until(async () => /première ligne/.test((await rows.textContent()) ?? ''), 10_000)
    const runningStill = (await taskNow(id)).status === 'running' && !/seconde ligne/.test((await rows.textContent()) ?? '')
    if (!live) return { verdict: 'FAIL', detail: 'la sortie de la commande n’apparaît pas au flux' }
    if (!runningStill) return { verdict: 'FAIL', detail: 'la sortie n’est apparue qu’à la fin : pas en direct' }

    if (!(await until(async () => (await taskNow(id)).status === 'completed'))) {
      const t = await taskNow(id)
      return { verdict: 'FAIL', detail: `tâche non terminée : ${t.status} — ${t.error}` }
    }
    const terminal = (await rows.textContent()) ?? ''
    if (!/node parle\.js/.test(terminal) || !/seconde ligne/.test(terminal)) {
      return { verdict: 'FAIL', detail: 'le flux ne montre pas la commande entière' }
    }
    return { verdict: 'PASS', detail: 'sortie au flux pendant la commande, puis la commande entière' }
  } finally {
    provider.server.close()
    dispose()
  }
})

// --- D14 ---------------------------------------------------------------------

/**
 * Vrai quand l'image désignée est chargée **et** décodée : un `<img>` présent
 * dont l'URL `blob:` ne mène à rien a une largeur naturelle nulle.
 */
async function imageLoaded(testId: string): Promise<boolean> {
  return until(async () =>
    page
      .getByTestId(testId)
      .first()
      .evaluate((el) => {
        const img = el as unknown as { complete: boolean; naturalWidth: number }
        return img.complete && img.naturalWidth > 0
      })
      .catch(() => false),
  )
}

await scenario(outcomes, 'D14 le dashboard montre ce que voit un Navigator, et l’humain coupe', async () => {
  const provider = await startFakeProvider()
  const { repo, dispose } = makeRepo({ 'README.md': '# Projet\n' })
  writeFileSync(join(repo, 'maquette.png'), readFileSync(new URL('../apps/desktop/src-tauri/icons/icon.png', import.meta.url)))
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Formulaire</title><h1>Inscription</h1><input id="q" name="q" autofocus>')
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  const address = site.address()
  const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`
  const second = tempHome('ui-navigateur')
  const nav = await startInProcess(loadConfig({ MIDGAARD_HOME: second.home, MIDGAARD_PORT: '0' }), {
    log: () => {},
    env: { MIDGAARD_VAULT: 'file', MIDGAARD_PROVIDER_API_KEY: 'sk-faux-navigateur' },
    browserGuard: async (host) => (host === '127.0.0.1' ? ['127.0.0.1'] : assertPublicHost(host)),
  })
  try {
    if (!nav) return { verdict: 'FAIL', detail: 'second daemon non démarré' }
    const rt2 = readRuntime(second.config.runtimeFile)!
    nav.store.upsertProvider({
      id: 'faux', name: 'faux', kind: 'openai-compatible', preset: 'custom', baseUrl: provider.url,
      defaultModel: 'faux-1', secretRef: null, webSearch: 'off',
    })
    reconcileAgents(nav.store)
    await nav.tasks.probeVision()
    const tag = '[D14]'
    provider.scripts.set(tag, [
      [{ tool: 'read_image', args: { path: 'maquette.png' } }],
      [{ tool: 'browser_open', args: { objective: 'remplir l’inscription', url: origin } }],
      [{ tool: 'browser_type', args: { text: 'bonjour' } }],
      [{ tool: 'submit_result', args: { summary: 'session coupée par l’humain' } }],
    ])

    // 1. La vision se déclare dans « Profils » : le Navigator, refusé, devient disponible.
    await page.goto(`${rt2.dashboard_url}#/agents`, { waitUntil: 'domcontentloaded' })
    const card = page.getByTestId(`agent-${NAVIGATOR_AGENT_ID}`)
    try {
      await card.getByText(/rien ne dit que le modèle « faux-1 » lit les images/).waitFor({ timeout: UI_TIMEOUT })
    } catch {
      return { verdict: 'FAIL', detail: 'le Navigator aveugle n’est pas montré refusé avec son motif' }
    }
    await page.getByTestId(`vision-${NAVIGATOR_AGENT_ID}`).selectOption('yes')
    try {
      await card.getByText('disponible', { exact: true }).waitFor({ timeout: UI_TIMEOUT })
    } catch {
      return { verdict: 'FAIL', detail: 'la déclaration n’a pas rendu le Navigator disponible' }
    }

    const { status, body } = await daemonJson<TaskView>(rt2, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ objective: `${tag} inscris-toi`, agent_id: NAVIGATOR_AGENT_ID, project_dir: repo }),
    })
    if (status !== 201) return { verdict: 'FAIL', detail: `création refusée : ${JSON.stringify(body)}` }
    const id = body.task.id
    const pending = async () => (await daemonJson<{ approvals: Approval[] }>(rt2, '/api/approvals')).body.approvals.find((a) => a.task_id === id)
    const taskOf = async () => (await daemonJson<TaskView>(rt2, `/api/tasks/${id}`)).body.task
    await page.goto(`${rt2.dashboard_url}#/tasks/${id}`, { waitUntil: 'domcontentloaded' })

    // 2. L'image lue s'affiche dans le fil, relue sur le disque.
    const shown = page.getByTestId('terminal-stream').getByTestId('chat-image')
    try {
      await shown.waitFor({ timeout: UI_TIMEOUT })
      if (!(await imageLoaded('chat-image'))) throw new Error('image vide')
    } catch {
      // Ce que le fil montre à la place : l'élément, une note, ou rien. Vu
      // échouer une fois en CI sous macOS, sans qu'on sache lequel.
      const items = await page.locator('[data-testid="terminal-line"][data-type="image"]').count()
      const note = await page.getByTestId('chat-image-note').first().textContent({ timeout: 500 }).catch(() => null)
      const width = await shown.first().evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth).catch(() => null)
      return {
        verdict: 'FAIL',
        detail:
          `l’image lue par l’agent ne s’affiche pas dans le fil (élément image : ${items}, note : ${note ?? 'aucune'}, ` +
          `largeur décodée : ${width ?? 'pas d’img'}, tâche ${(await taskOf()).status})`,
      }
    }

    // 3. La session approuvée, l'onglet s'ouvre seul sur la capture.
    if (!(await until(async () => (await pending()) !== undefined))) return { verdict: 'FAIL', detail: 'pas de demande de session' }
    const session = (await pending())!
    await daemonJson(rt2, `/api/approvals/${session.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })
    const panel = page.getByTestId('browser-panel')
    try {
      await panel.waitFor({ timeout: UI_TIMEOUT })
      if (!(await imageLoaded('browser-frame'))) throw new Error('image vide')
    } catch {
      return { verdict: 'FAIL', detail: 'l’onglet Navigateur ne s’est pas ouvert seul sur une capture' }
    }
    const url = (await page.getByTestId('browser-url').textContent()) ?? ''
    if (!url.startsWith(origin)) return { verdict: 'FAIL', detail: `adresse affichée : « ${url} »` }

    // 4. La saisie à approuver se lit au-dessus de la capture ; l'humain coupe.
    try {
      await panel.getByText(/saisir "bonjour" dans input#q\[name="q"\]/).waitFor({ timeout: UI_TIMEOUT })
    } catch {
      return { verdict: 'FAIL', detail: 'la saisie à approuver n’apparaît pas dans l’onglet Navigateur' }
    }
    await page.getByTestId('browser-cut').click()
    try {
      await page.getByTestId('browser-state').getByText('fermée — coupée par vous').waitFor({ timeout: UI_TIMEOUT })
    } catch {
      return { verdict: 'FAIL', detail: 'la coupure ne se voit pas dans l’onglet' }
    }
    const typing = await pending()
    if (!typing) return { verdict: 'FAIL', detail: 'la saisie n’attend plus de décision' }
    await daemonJson(rt2, `/api/approvals/${typing.id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'test' }) })
    if (!(await until(async () => (await taskOf()).status === 'completed'))) {
      const t = await taskOf()
      return { verdict: 'FAIL', detail: `tâche non terminée : ${t.status} — ${t.error}` }
    }
    const typed = (await daemonJson<{ tool_calls: { name: string; status: string; error: string | null }[] }>(rt2, `/api/tasks/${id}/tools`))
      .body.tool_calls.find((c) => c.name === 'browser_type')
    if (typed?.status !== 'failed' || !/cut by the human operator/.test(typed.error ?? '')) {
      return { verdict: 'FAIL', detail: `la saisie approuvée après la coupure est partie : ${JSON.stringify(typed)}` }
    }
    return {
      verdict: 'PASS',
      detail: 'vision déclarée aux Profils, image lue au fil, onglet ouvert seul sur la capture, saisie lue puis coupée, rien tapé',
    }
  } finally {
    if (nav) {
      nav.close('fin de D14')
      await nav.stopped
    }
    // D7 attend la page sur le daemon principal.
    await page.goto(rt.dashboard_url ?? '', { waitUntil: 'domcontentloaded' }).catch(() => {})
    site.close()
    provider.server.close()
    second.cleanup()
    dispose()
  }
})

// --- D7 (en dernier : il tue le daemon) --------------------------------------

// --- D16 ---------------------------------------------------------------------

/** Le faux serveur MCP des tests, lancé par le daemon. */
const FAKE_MCP = fileURLToPath(new URL('./fake-mcp-server.ts', import.meta.url))

await scenario(outcomes, 'D16 les serveurs MCP aux Profils : test, outils cochés, serveur d’un profil', async () => {
  const declared = await daemonJson(rt, '/api/mcp', {
    method: 'POST',
    body: JSON.stringify({ id: 'fake', command: process.execPath, args: [FAKE_MCP] }),
  })
  if (declared.status !== 200) return { verdict: 'FAIL', detail: `déclaration refusée : ${JSON.stringify(declared.body)}` }
  await page.goto(`${rt.dashboard_url}#/agents`, { waitUntil: 'domcontentloaded' })
  const server = page.getByTestId('mcp-server-fake')
  await server.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
  if (!/jamais testé/.test((await page.getByTestId('mcp-test-badge-fake').textContent()) ?? '')) {
    return { verdict: 'FAIL', detail: 'un serveur jamais testé n’est pas dit tel' }
  }

  await page.getByTestId('mcp-test-fake').click()
  if (!(await until(async () => /répond/.test((await page.getByTestId('mcp-test-badge-fake').textContent()) ?? '')))) {
    return { verdict: 'FAIL', detail: `test sans succès : ${await page.getByTestId('mcp-server-fake').textContent()}` }
  }
  await page.getByTestId('mcp-tool-echo').waitFor({ state: 'visible', timeout: UI_TIMEOUT })

  // Cocher demande confirmation, avec l'avertissement : on l'accepte, et on le lit.
  let warning = ''
  page.once('dialog', (d) => {
    warning = d.message()
    void d.accept()
  })
  await page.getByTestId('mcp-allow-readonly-fake').click()
  const allowed = async () =>
    (await daemonJson<{ server: { tools: { name: string; status: string }[] } }>(rt, '/api/mcp/fake')).body.server.tools.find(
      (t) => t.name === 'echo',
    )?.status
  if (!(await until(async () => (await allowed()) === 'allowed'))) return { verdict: 'FAIL', detail: 'echo non coché en base' }
  if (!/SANS APPROBATION/.test(warning)) return { verdict: 'FAIL', detail: `confirmation sans l’avertissement : « ${warning} »` }
  // La case suit la réponse de l'API, qui arrive après l'écriture en base : on l'attend.
  if (!(await until(() => page.getByTestId('mcp-tool-check-echo').isChecked()))) {
    return { verdict: 'FAIL', detail: 'la case ne montre pas echo libre' }
  }

  // Décocher : sans confirmation, et l'outil redevient approuvé.
  await page.getByTestId('mcp-tool-check-echo').click()
  if (!(await until(async () => (await allowed()) === 'approval'))) return { verdict: 'FAIL', detail: 'echo toujours libre en base' }

  // Le serveur se donne au Researcher ; l'orchestrateur n'a pas de case.
  await page.getByTestId('agent-mcp-researcher-fake').click()
  const attached = async () => (await daemonJson<{ agent: Agent }>(rt, '/api/agents/researcher')).body.agent.mcp_servers
  if (!(await until(async () => (await attached()).includes('fake')))) return { verdict: 'FAIL', detail: 'serveur non donné au Researcher' }
  if ((await page.getByTestId('agent-mcp-orchestrator').count()) !== 0) {
    return { verdict: 'FAIL', detail: 'l’orchestrateur se voit proposer des serveurs MCP' }
  }
  // Rendu au profil sans serveur, pour les scénarios suivants.
  await daemonJson(rt, '/api/agents/researcher/mcp', { method: 'PUT', body: JSON.stringify({ servers: [] }) })
  return { verdict: 'PASS', detail: 'test relu, echo coché après avertissement puis décoché, serveur donné au Researcher, pas à l’orchestrateur' }
})

// --- D17 ---------------------------------------------------------------------

await scenario(outcomes, 'D17 un orchestrateur crée un exécutant : son rôle, sans budget d’arbre', async () => {
  const provider = await startFakeProvider()
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-ui-cree-')))
  try {
    await daemonJson(rt, '/api/providers', {
      method: 'POST',
      body: JSON.stringify({ id: 'faux', preset: 'custom', base_url: provider.url, default_model: 'faux-1', api_key: 'sk-faux-0000' }),
    })
    const role = 'Lis le README et résume-le en une phrase.'
    provider.scripts.set('[D17]', [
      [{ tool: 'create_agent', args: { name: 'Lecteur', base: 'researcher', role } }],
      [{ tool: 'delegate_task', args: { agent_id: '{{agent_id}}', objective: '[D17-enfant] lis le README' } }],
      [{ tool: 'wait_for_task', args: { task_id: '{{task_id}}' } }],
      [{ tool: 'submit_result', args: { summary: 'délégué à un exécutant créé' } }],
    ])
    provider.scripts.set('[D17-enfant]', [[{ tool: 'submit_result', args: { summary: 'Projet' } }]])
    const created = await daemonJson<{ task: Task }>(rt, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ agent_id: 'orchestrator', objective: '[D17] crée un lecteur', project_dir: repo }),
    })
    if (created.status !== 201) return { verdict: 'FAIL', detail: `orchestrateur refusé : ${JSON.stringify(created.body)}` }
    const parentId = created.body.task.id
    if (!(await until(async () => (await taskNow(parentId)).status === 'completed'))) {
      const t = await taskNow(parentId)
      return { verdict: 'FAIL', detail: `orchestrateur non terminé : ${t.status} — ${t.error}` }
    }
    await page.goto(`${rt.dashboard_url}#/tasks/${parentId}`, { waitUntil: 'domcontentloaded' })
    await openDetails()
    const list = page.getByTestId('created-agents')
    await list.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
    const shown = (await list.textContent()) ?? ''
    if (!shown.includes('Lecteur') || !shown.includes(role)) return { verdict: 'FAIL', detail: `agent créé sans son nom ou son rôle : « ${shown} »` }
    if ((await page.getByTestId('subtasks-budget').count()) > 0) return { verdict: 'FAIL', detail: 'un budget d’arbre est encore affiché' }
    return { verdict: 'PASS', detail: 'exécutant « Lecteur » créé et montré avec son rôle ; aucun budget d’arbre affiché' }
  } finally {
    provider.server.close()
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// --- D18 ---------------------------------------------------------------------

await scenario(outcomes, 'D18 aucune limite ne se règle ni ne s’applique : ni aux Profils, ni par l’API', async () => {
  await page.goto(`${rt.dashboard_url}#/agents`, { waitUntil: 'domcontentloaded' })
  // La carte du Researcher est là, avec son modèle à régler…
  await page.getByTestId('agent-researcher').waitFor({ state: 'visible', timeout: UI_TIMEOUT })
  // …mais aucun champ de limite, pour aucun profil.
  const fields = await page.locator('[data-testid^="agent-limit"]').count()
  if (fields > 0) return { verdict: 'FAIL', detail: `${fields} champ(s) de limite encore aux Profils` }
  if (await sees(/Limites\s*:/, 500)) return { verdict: 'FAIL', detail: 'le mot « Limites » est encore affiché aux Profils' }

  // L'API non plus : la route est retirée, et un profil n'en porte plus.
  const put = await daemonJson(rt, '/api/agents/researcher/limits', { method: 'PUT', body: JSON.stringify({ max_steps: 3 }) })
  if (put.status !== 404) return { verdict: 'FAIL', detail: `PUT /api/agents/researcher/limits répond ${put.status}` }
  const agent = (await daemonJson<{ agent: Agent }>(rt, '/api/agents/researcher')).body.agent
  if ('limits' in agent) return { verdict: 'FAIL', detail: 'le profil rendu par l’API porte encore des limites' }
  return { verdict: 'PASS', detail: 'aucun champ de limite aux Profils, route retirée (404), profil sans limites' }
})

// --- D20 ---------------------------------------------------------------------

await scenario(outcomes, 'D20 une clé se dépose aux Profils : masquée, jamais réaffichée, relue au coffre', async () => {
  const provider = await startFakeProvider()
  const KEY = 'sk-ui-depot-4242-premiere'
  const NEXT = 'sk-ui-depot-5252-seconde'
  const inBase = async () =>
    (await daemonJson<{ providers: ProviderConfig[] }>(rt, '/api/providers')).body.providers.find((p) => p.id === 'cle-ui')
  try {
    await page.goto(`${rt.dashboard_url}#/agents`, { waitUntil: 'domcontentloaded' })
    await page.getByTestId('providers-card').waitFor({ state: 'visible', timeout: UI_TIMEOUT })
    const keyField = page.getByTestId('provider-key-input')
    if ((await keyField.getAttribute('type')) !== 'password') return { verdict: 'FAIL', detail: 'le champ de la clé n’est pas masqué' }

    // Sans clé, rien ne part : le refus se lit, et rien n'est déclaré.
    await page.getByTestId('provider-preset').selectOption('custom')
    await page.getByTestId('provider-id').fill('cle-ui')
    await page.getByTestId('provider-model').fill('faux-1')
    await page.getByTestId('provider-base-url').fill(provider.url)
    await page.getByTestId('provider-save').click()
    if (!/clé/.test((await page.getByTestId('provider-message').textContent()) ?? '')) {
      return { verdict: 'FAIL', detail: 'un fournisseur sans clé n’est pas refusé avec son motif' }
    }
    if (await inBase()) return { verdict: 'FAIL', detail: 'fournisseur déclaré sans clé' }

    // Avec la clé : enregistré, testé dans la foulée.
    await keyField.fill(KEY)
    await page.getByTestId('provider-save').click()
    if (!(await until(async () => /joignable/.test((await page.getByTestId('provider-test-badge-cle-ui').textContent().catch(() => '')) ?? '')))) {
      return { verdict: 'FAIL', detail: `pas de test réussi : « ${await page.getByTestId('provider-message').textContent().catch(() => '')} »` }
    }
    const saved = await inBase()
    if (!saved?.secret_ref) return { verdict: 'FAIL', detail: 'aucune référence de coffre en base' }
    // La clé que le fournisseur a reçue est celle saisie : elle a donc été
    // déposée au coffre **et** relue, pas seulement acceptée par la route.
    if (!provider.authorizations.includes(`Bearer ${KEY}`)) {
      return { verdict: 'FAIL', detail: 'le fournisseur n’a pas reçu la clé saisie' }
    }
    // Elle n'est plus nulle part où la page ou l'API pourraient la montrer.
    if ((await keyField.inputValue()) !== '') return { verdict: 'FAIL', detail: 'le champ garde la clé après l’envoi' }
    if ((await page.content()).includes(KEY)) return { verdict: 'FAIL', detail: 'la clé est dans la page' }
    if (JSON.stringify((await daemonJson(rt, '/api/providers')).body).includes(KEY)) return { verdict: 'FAIL', detail: 'l’API rend la clé' }
    if (!/coffre/.test((await page.getByTestId('provider-key-cle-ui').textContent()) ?? '')) {
      return { verdict: 'FAIL', detail: 'la carte ne dit pas que la clé est au coffre' }
    }

    // Remplacer la clé : le test suivant présente la nouvelle.
    await page.getByTestId('provider-edit-cle-ui').click()
    await keyField.fill(NEXT)
    await page.getByTestId('provider-save').click()
    if (!(await until(async () => provider.authorizations.at(-1) === `Bearer ${NEXT}`))) {
      return { verdict: 'FAIL', detail: 'la clé remplacée n’est pas celle présentée au fournisseur' }
    }
    if ((await inBase())?.secret_ref !== saved.secret_ref) return { verdict: 'FAIL', detail: 'la référence a changé : l’ancienne clé resterait orpheline au coffre' }

    // Retirer se confirme : refusé, rien ne bouge ; accepté, le fournisseur part.
    page.once('dialog', (d) => void d.dismiss())
    await page.getByTestId('provider-remove-cle-ui').click()
    await sleep(500)
    if (!(await inBase())) return { verdict: 'FAIL', detail: 'retiré malgré le refus de confirmer' }
    page.once('dialog', (d) => void d.accept())
    await page.getByTestId('provider-remove-cle-ui').click()
    if (!(await until(async () => !(await inBase())))) return { verdict: 'FAIL', detail: 'fournisseur toujours en base après confirmation' }
    return { verdict: 'PASS', detail: 'clé saisie masquée, déposée, relue au coffre, absente de la page et de l’API ; remplacée ; retrait confirmé' }
  } finally {
    await daemonJson(rt, '/api/providers/cle-ui', { method: 'DELETE' })
    provider.server.close()
  }
})

// --- D22 ---------------------------------------------------------------------

await scenario(outcomes, 'D22 le flux est la vue par défaut, détails à la demande, et rien de l’atelier ne reste', async () => {
  if (!vue) return { verdict: 'FAIL', detail: 'D2 n’a pas créé de tâche' }
  const id = vue.task.id
  // Le lien d'une tâche ouvre le flux : c'est l'interface, pas une vue annexe.
  await page.goto(`${rt.dashboard_url}#/tasks/${id}`, { waitUntil: 'domcontentloaded' })
  const stream = page.getByTestId('terminal-stream')
  if (!(await stream.waitFor({ state: 'visible', timeout: UI_TIMEOUT }).then(() => true).catch(() => false))) {
    return { verdict: 'FAIL', detail: 'le lien d’une tâche n’ouvre pas le flux' }
  }
  // Le flux commence par ce qui a été demandé, puis rejoue le journal de la
  // tâche simulée (son démarrage et ses étapes y sont).
  const first = stream.getByTestId('terminal-line').first()
  if (!(await until(async () => ((await first.textContent().catch(() => '')) ?? '').includes(vue.task.objective)))) {
    return { verdict: 'FAIL', detail: 'le flux ne commence pas par l’objectif de la tâche' }
  }
  if ((await page.getByTestId('terminal-line').count()) < 2) return { verdict: 'FAIL', detail: 'le journal n’est pas rejoué en lignes' }

  // L'invite est là (la tâche simulée ne converse pas : elle est fermée, avec
  // son motif). Sa présence suffit ; son ouverture est éprouvée par D12.
  const hasComposer = (await page.getByTestId('chat-input').count()) > 0 || (await page.getByTestId('chat-closed').count()) > 0
  if (!hasComposer) return { verdict: 'FAIL', detail: 'pas d’invite sous le flux' }

  // Détails à la demande, et retour au flux.
  await openDetails()
  if (!(await sees('Timeline'))) return { verdict: 'FAIL', detail: '« détails » ne montre pas l’inspecteur de la tâche' }
  if (await stream.isVisible()) return { verdict: 'FAIL', detail: 'le flux reste affiché sous les détails' }
  // L'ancien lien de la vue terminal désigne le flux, quelle que soit la lecture en cours.
  await page.evaluate((hash) => { (globalThis as unknown as { location: { hash: string } }).location.hash = hash }, `#/terminal/${id}`)
  if (!(await stream.waitFor({ state: 'visible', timeout: UI_TIMEOUT }).then(() => true).catch(() => false))) {
    return { verdict: 'FAIL', detail: '#/terminal/<id> ne ramène pas au flux' }
  }

  // Rien de l'atelier d'origine : ni barre d'activité, ni panneau de
  // conversation, ni terminal xterm.
  for (const gone of ['activity-tasks', 'chat-panel', 'terminal-panel']) {
    if ((await page.getByTestId(gone).count()) > 0) return { verdict: 'FAIL', detail: `« ${gone} » de l’atelier est encore là` }
  }
  if ((await page.locator('.xterm').count()) > 0) return { verdict: 'FAIL', detail: 'un terminal xterm est encore monté' }
  return { verdict: 'PASS', detail: 'flux par défaut, objectif en tête, invite présente, détails et retour, atelier absent' }
})

await scenario(outcomes, 'D7 la perte de la WebSocket se voit, et le retour aussi', async () => {
  if (!daemon?.pid) return { verdict: 'FAIL', detail: 'pas de daemon à arrêter' }
  const mort = daemon.pid
  // Un témoin posé dans la page : il disparaît si elle se recharge. Le daemon
  // revient avec le **même** bundle, donc la page doit survivre — un
  // rechargement à chaque coupure, ou en boucle, se verrait ici (D15).
  await page.evaluate(() => { (globalThis as unknown as { temoinD7?: boolean }).temoinD7 = true })
  // Un dashboard temps réel qui a perdu sa connexion continue d'afficher des
  // données d'apparence normale. Sans témoin, on croit qu'il ne se passe rien.
  daemon.kill('SIGKILL')
  await until(async () => !pidAlive(mort), 5000)
  if (!(await connection('déconnecté'))) {
    return { verdict: 'FAIL', detail: 'le daemon est mort, le dashboard affiche toujours « en direct »' }
  }
  // Et il le **reste** : après plusieurs tentatives ratées (300, 700, 1500 ms),
  // le bandeau doit redire « déconnecté ». Une tentative qui échouait dès le
  // bootstrap le laissait sur « connexion… » pour toujours — vu en CI dès que
  // D14 a rechargé la page juste avant ce scénario (Slice 7, étape 6) ; le
  // premier contrôle ne le voyait que s'il regardait avant la tentative.
  await sleep(3000)
  if (!(await connection('déconnecté', 12_000))) {
    return { verdict: 'FAIL', detail: 'après des tentatives ratées, le bandeau reste sur « connexion… » : la panne ne se voit plus' }
  }

  // Et le retour. C'est la seconde moitié qui compte : le jeton est régénéré à
  // chaque démarrage du daemon, et la page en garde un périmé. Tant qu'elle ne
  // l'oubliait pas, elle réessayait sans fin avec lui et ne revenait jamais —
  // sans rien dire d'autre que « déconnecté ».
  const neuf = await startDaemon(rt.port, mort)
  if (neuf.token === rt.token) {
    return { verdict: 'FAIL', detail: 'le daemon a rendu le même jeton : le scénario ne prouve rien' }
  }
  if (!(await connection('en direct', 30_000))) {
    return { verdict: 'FAIL', detail: 'daemon revenu, dashboard resté déconnecté (jeton périmé conservé ?)' }
  }
  if (!(await page.evaluate(() => (globalThis as unknown as { temoinD7?: boolean }).temoinD7 === true))) {
    return { verdict: 'FAIL', detail: 'la page s’est rechargée alors que le daemon sert le même bundle' }
  }
  return { verdict: 'PASS', detail: `déconnexion vue, puis reconnexion seule avec un jeton neuf (port ${neuf.port}), sans rechargement` }
})

// --- D15 (après D7 : il remplace encore le daemon) ---------------------------

await scenario(outcomes, 'D15 une page plus vieille que son daemon se recharge', async () => {
  // Le défaut : la fenêtre desktop, chargée face à un daemon plus ancien, a
  // gardé son code après le remplacement du daemon. Elle a reçu des événements
  // qu'elle ne connaissait pas et n'a plus rien affiché (Slice 7, après
  // l'essai). On rejoue un remplacement par un daemon qui sert **un autre
  // bundle** : le même code sous un autre nom, comme après une mise à jour.
  if (!daemon?.pid) return { verdict: 'FAIL', detail: 'pas de daemon à remplacer' }
  const ownScript = () =>
    page.locator('script[type="module"][src]').first().getAttribute('src', { timeout: 2000 })
  const own = await ownScript()
  if (!own) return { verdict: 'FAIL', detail: 'la page n’a pas de script de module : rien à comparer' }

  const dir = mkdtempSync(join(tmpdir(), 'midgaard-ui-bundle-'))
  try {
    cpSync(defaultDashboardDir(), dir, { recursive: true })
    const renamed = own.replace(/\.js$/, '-neuf.js')
    renameSync(join(dir, own), join(dir, renamed))
    const index = join(dir, 'index.html')
    writeFileSync(index, readFileSync(index, 'utf8').replace(own, renamed))

    await page.evaluate(() => { (globalThis as unknown as { temoinD15?: boolean }).temoinD15 = true })
    const mort = daemon.pid
    daemon.kill('SIGKILL')
    await until(async () => !pidAlive(mort), 5000)
    await startDaemon(rt.port, mort, { MIDGAARD_DASHBOARD_DIR: dir })

    const reloaded = await until(async () => (await ownScript().catch(() => null)) === renamed, 30_000)
    if (!reloaded) {
      return { verdict: 'FAIL', detail: `la page garde ${own} alors que le daemon sert ${renamed} : l’ancien code tourne toujours` }
    }
    if (await page.evaluate(() => (globalThis as unknown as { temoinD15?: boolean }).temoinD15 === true)) {
      return { verdict: 'FAIL', detail: 'le script a changé sans rechargement : le témoin a survécu' }
    }
    if (!(await connection('en direct', 30_000))) {
      return { verdict: 'FAIL', detail: 'rechargée, la page ne s’est pas reconnectée' }
    }
    return { verdict: 'PASS', detail: `rechargée d’elle-même sur le nouveau bundle (${renamed}), puis « en direct »` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- nettoyage ---------------------------------------------------------------

await browser.close()
if (daemon && running(daemon)) daemon.kill('SIGKILL')
cleanup()
process.exit(summarize(outcomes, 'Interface du dashboard (Playwright)'))
