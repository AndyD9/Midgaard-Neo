/**
 * @file Les outils du navigateur isolé (Slice 7, étape 4) : regarder et se
 * servir d'une page web, sous une session que l'humain approuve.
 *
 * ## Ce qui est approuvé, et pourquoi là
 *
 *  - **`browser_open`** prépare une session — objectif, adresse de départ,
 *    durée maximale, et les **textes que l'agent prévoit de taper** — que
 *    l'humain approuve comme toute opération préparée : l'empreinte porte sur
 *    tous ces champs (docs/SLICE7.md, décision 6) ;
 *  - **dans la session**, regarder (`browser_screenshot`), aller à une adresse
 *    (`browser_goto`), cliquer, faire défiler et presser une touche de
 *    déplacement sont **libres** : l'humain a approuvé la session et la regarde.
 *    Un clic peut envoyer un formulaire, et c'est dit dans la demande de session
 *    (décision du 2026-11-05) ;
 *  - **saisir du texte** (`browser_type`, Entrée comprise si demandée) : un
 *    texte **prévu** à l'ouverture se tape sans nouvelle demande, une fois, s'il
 *    est identique à la lettre — l'humain l'a déjà lu. Tout autre texte, et
 *    Entrée seule, sont approuvés **chacun**, avec le texte exact, l'adresse et
 *    le champ visé : c'est par là qu'une donnée part dans un formulaire. Ce que
 *    l'humain a approuvé un par un est revérifié au moment d'agir : si la page
 *    ou le champ ont changé pendant l'attente, la saisie est refusée plutôt que
 *    tapée ailleurs.
 *
 * Grouper ainsi ne relâche rien : **aucun texte n'entre dans un champ sans que
 * l'humain l'ait lu**. Ce qui change, c'est le moment où il le lit. L'essai réel
 * de l'étape 8 avait demandé sept approbations pour trois tâches ; une
 * approbation qui n'apprend rien finit par se donner sans lire.
 *
 * ## Ce que l'agent reçoit
 *
 * Chaque action rend une **capture**, qui suit le résultat comme une image de
 * `read_image`, et l'adresse, le titre et le champ actif de la page. Tout cela
 * est écrit par la page : le résultat est **non fiable** (encadré, et la tâche
 * marquée), et la capture est **éphémère** — la suivante la chasse de la
 * conversation, pour qu'une session de vingt actions ne renvoie pas vingt
 * images au modèle à chaque étape.
 *
 * Sans modèle qui lit les images ou sans port de navigateur (profil qui n'en
 * a pas), chaque outil **refuse avec son motif**, sans approbation à la place.
 */
import { z } from 'zod'
import type { ToolResult } from '@midgaard/contracts'
import {
  ToolError,
  type BrowserCapture, type BrowserPageView, type BrowserPlannedInput, type PreparedOperation, type Tool, type ToolContext,
} from './types.ts'

/** Noms des outils du navigateur. Le profil qui en a un reçoit le port. */
export const BROWSER_TOOLS = [
  'browser_open', 'browser_screenshot', 'browser_goto', 'browser_click', 'browser_scroll',
  'browser_type', 'browser_key', 'browser_close',
] as const

/**
 * Touches qu'un agent peut presser. Une liste fermée : un raccourci du
 * navigateur (outils de développement, impression) n'a rien à faire dans une
 * tâche. Une seule liste, ici : le paquet `browser` la réexporte.
 */
export const BROWSER_KEYS = [
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
] as const
export type BrowserKey = (typeof BROWSER_KEYS)[number]

/** Durée d'une session sans précision : dix minutes. */
export const BROWSER_DEFAULT_DURATION_S = 600
/** Durée maximale d'une session : trente minutes, au-delà l'humain ne surveille plus. */
export const BROWSER_MAX_DURATION_S = 1800
/** Texte maximal d'une saisie : un champ de formulaire, pas un document. */
export const BROWSER_MAX_TYPE_CHARS = 2000
/** Textes prévus à l'ouverture, au plus : l'humain doit pouvoir tous les lire. */
export const BROWSER_MAX_PLANNED = 20
/** Longueur d'un texte prévu, au plus : il s'affiche dans la demande de session. */
export const BROWSER_MAX_PLANNED_CHARS = 500

/** Pourquoi le navigateur est refusé à cette tâche, ou `null` s'il ne l'est pas. */
function unavailable(ctx: ToolContext): string | null {
  if (!ctx.browser) return 'this agent has no browser'
  if (!ctx.vision?.enabled) return ctx.vision?.reason ?? 'this model cannot read images, and the browser is seen through screenshots'
  return null
}

/** Pourquoi aucune action n'est possible faute de session, ou `null` si une session est ouverte. */
function noSession(ctx: ToolContext): string | null {
  const refused = unavailable(ctx)
  if (refused) return refused
  const s = ctx.browser!.session()
  if (!('closed_reason' in s)) return null
  return s.closed_reason
    ? `the browser session is closed (${s.closed_reason}); call browser_open to ask the human for a new one`
    : 'no browser session is open: call browser_open first'
}

/** Politique commune des actions libres dans une session ouverte. */
function inSession(reason: string) {
  return (_args: unknown, ctx: ToolContext): { decision: 'allow' | 'deny'; reason: string } => {
    const refused = noSession(ctx)
    return refused ? { decision: 'deny', reason: refused } : { decision: 'allow', reason }
  }
}

/** Le port, revérifié au moment d'agir : la session a pu expirer ou être coupée pendant l'attente. */
function port(ctx: ToolContext) {
  const refused = noSession(ctx)
  if (refused) throw new ToolError(refused)
  return ctx.browser!
}

/** Vérifie qu'une adresse est ouvrable par le navigateur : `http:` ou `https:`, absolue. */
function checkUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ToolError(`not a valid absolute URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError(`only http:// and https:// addresses can be opened, not ${url.protocol}`)
  }
  return url.href
}

/**
 * Le résultat d'une action : ce que la page montre, et sa capture.
 *
 * Le résumé — qui va au journal et sert d'étiquette à l'encadrement — ne
 * garde que l'action et l'adresse ; le titre et le champ actif, écrits par la
 * page, ne vont qu'au modèle, encadrés.
 */
function captured(action: string, cap: BrowserCapture): ToolResult {
  const content = [
    `Action: ${action}`,
    `URL: ${cap.url}`,
    `Title: ${cap.title || '(none)'}`,
    `Focused element: ${cap.focused ?? '(none)'}`,
    `A ${cap.viewport.width}×${cap.viewport.height} px screenshot of the visible page is attached below; ` +
      'click coordinates are in these pixels. It replaces your previous screenshot.',
  ].join('\n')
  return {
    content,
    bytes: Buffer.byteLength(content),
    summary: `${action} → ${cap.url}`,
    untrusted: true,
    images: [{ mediaType: 'image/jpeg', data: cap.jpeg.toString('base64'), transient: true }],
  }
}

// --- Ouvrir et fermer ------------------------------------------------------

const openSchema = z.object({
  objective: z
    .string()
    .min(1)
    .max(500)
    .describe('What you will do in the browser, in one sentence. The human approves the session on this.'),
  url: z.string().min(1).describe('Absolute http:// or https:// address to start from.'),
  max_duration_s: z
    .number()
    .int()
    .min(60)
    .max(BROWSER_MAX_DURATION_S)
    .default(BROWSER_DEFAULT_DURATION_S)
    .describe(`How long the session may last, in seconds (default ${BROWSER_DEFAULT_DURATION_S}). It closes by itself then.`),
  planned_inputs: z
    .array(
      z.object({
        text: z.string().min(1).max(BROWSER_MAX_PLANNED_CHARS).describe('Exact text you will type.'),
        press_enter: z.boolean().default(false).describe('Whether you will press Enter right after it.'),
      }),
    )
    .max(BROWSER_MAX_PLANNED)
    .default([])
    .describe(
      'Every text you already know you will type in this session, in order. The human reads them with the ' +
        'session; each one is then typed once without asking again, if identical to the letter (same press_enter). ' +
        'Any other text needs its own approval.',
    ),
})

/** Ce qui est figé pour l'approbation d'une session. */
interface OpenState {
  url: string
  maxDurationS: number
  plannedInputs: BrowserPlannedInput[]
}

/**
 * Un texte prévu tel que l'humain le lit : entre guillemets, échappé comme du
 * JSON — une espace finale ou un retour à la ligne se voient — et suivi de
 * « puis Entrée » si Entrée est prévue.
 */
function describePlanned(p: BrowserPlannedInput): string {
  return `${JSON.stringify(p.text)}${p.press_enter ? ' puis Entrée' : ''}`
}

/** Demande une session de navigateur, que l'humain approuve. */
export const browserOpenTool: Tool<z.infer<typeof openSchema>> = {
  name: 'browser_open',
  description:
    'Ask a human to approve a browser session: a fresh, isolated browser (no cookies, no logins, public internet ' +
    'only) opened at `url`, for `objective`, for at most `max_duration_s`. Once approved, you see a screenshot ' +
    'after every action. Inside the session, browser_screenshot, browser_goto, browser_click, browser_scroll ' +
    'and navigation keys are free. List in `planned_inputs` every text you already know you will type: the ' +
    'human approves them with the session, and each is then typed once without asking again. Any other text, ' +
    'and the Enter key on its own, need a human approval each. A click is never asked about, even one that ' +
    'submits a form: the human approves the session knowing this, so only submit a form when the objective ' +
    'says so. The human watches the session live and can close it at any time. One session at a time.',
  schema: openSchema,
  policy: (_args, ctx) => {
    const refused = unavailable(ctx)
    if (refused) return { decision: 'deny', reason: refused }
    if (!('closed_reason' in ctx.browser!.session())) {
      return { decision: 'deny', reason: 'a browser session is already open: use it, or call browser_close first' }
    }
    return { decision: 'approval', reason: 'une session de navigateur est approuvée par un humain' }
  },

  /**
   * Fige l'adresse et la durée. La durée est bornée par l'échéance de la tâche :
   * une session ne survit pas à sa tâche, l'humain doit donc lire la vraie.
   */
  async prepare(args, ctx): Promise<PreparedOperation> {
    const url = checkUrl(args.url)
    const left = ctx.deadline ? Math.floor((ctx.deadline - Date.now()) / 1000) : Infinity
    const maxDurationS = Math.max(1, Math.min(args.max_duration_s, left))
    const minutes = Math.round((maxDurationS / 60) * 10) / 10
    const plannedInputs = args.planned_inputs.map((p) => ({ text: p.text, press_enter: p.press_enter }))
    const state: OpenState = { url, maxDurationS, plannedInputs }
    // Les textes prévus sont lus **ici**, avec la session : c'est leur seule
    // approbation. Ils entrent donc dans le détail, et dans l'empreinte.
    const planned = plannedInputs.length
      ? ` — textes prévus, tapés une fois chacun sans nouvelle demande : ${plannedInputs.map(describePlanned).join(' ; ')}`
      : ''
    return {
      // La fin du texte n'est pas une formule : c'est ce que l'humain accepte.
      // Un clic part sans demande, y compris sur un bouton d'envoi ; le
      // reconnaître dans la page serait une promesse qu'une page hostile
      // déjoue (décision du 2026-11-05, docs/SLICE7.md, étape 7).
      summary:
        `ouvrir un navigateur isolé sur ${url}, ${minutes} min au plus — objectif : ${args.objective}${planned}` +
        ' — clics libres pendant la session, envoi de formulaire compris ; tout autre texte, et Entrée seule, approuvés chacun',
      detail: { tool: 'browser_open', objective: args.objective, url, max_duration_s: maxDurationS, planned_inputs: plannedInputs },
      state,
    }
  },

  async run(args, ctx, prepared): Promise<ToolResult> {
    const refused = unavailable(ctx)
    if (refused) throw new ToolError(refused)
    // Sans préparation (appel direct), on prépare ici, comme `exec`.
    const op = (prepared ?? (await browserOpenTool.prepare!(args, ctx))).state as OpenState
    const cap = await ctx.browser!.open({
      objective: args.objective, url: op.url, max_duration_s: op.maxDurationS, planned_inputs: op.plannedInputs,
    })
    return captured(`opened ${op.url}`, cap)
  },
}

const emptySchema = z.object({})

/** Ferme la session. */
export const browserCloseTool: Tool<z.infer<typeof emptySchema>> = {
  name: 'browser_close',
  description: 'Close the browser session when you are done with it. It also closes by itself at its deadline and when the task ends.',
  schema: emptySchema,
  policy: inSession('fermer la session, aucun effet de bord'),
  async run(_args, ctx): Promise<ToolResult> {
    await port(ctx).close('closed by the agent')
    const content = 'The browser session is closed.'
    return { content, bytes: content.length, summary: 'session fermée', untrusted: false }
  },
}

// --- Regarder et se déplacer, libres dans la session -------------------------

/** Regarde la page. */
export const browserScreenshotTool: Tool<z.infer<typeof emptySchema>> = {
  name: 'browser_screenshot',
  description:
    'Take a new screenshot of the page, for instance after waiting for something to load. Every other browser ' +
    'action already returns one: do not call this right after them.',
  schema: emptySchema,
  policy: inSession('regarder la page, dans la session approuvée'),
  async run(_args, ctx): Promise<ToolResult> {
    return captured('screenshot', await port(ctx).screenshot())
  },
}

const gotoSchema = z.object({
  url: z.string().min(1).describe('Absolute http:// or https:// address.'),
})

/** Va à une adresse. */
export const browserGotoTool: Tool<z.infer<typeof gotoSchema>> = {
  name: 'browser_goto',
  description: 'Load an http:// or https:// address in the browser session. Private and loopback addresses are refused.',
  schema: gotoSchema,
  policy: inSession('aller à une adresse publique, dans la session approuvée'),
  async run(args, ctx): Promise<ToolResult> {
    const url = checkUrl(args.url)
    return captured(`went to ${url}`, await port(ctx).goto(url))
  },
}

const clickSchema = z.object({
  x: z.number().int().min(0).describe('Horizontal position, in pixels of the latest screenshot.'),
  y: z.number().int().min(0).describe('Vertical position, in pixels of the latest screenshot.'),
})

/** Clique. */
export const browserClickTool: Tool<z.infer<typeof clickSchema>> = {
  name: 'browser_click',
  description:
    'Click at a position of the page, in pixels of the latest screenshot. Click a field before typing into it. ' +
    'No human approves a click, even one on a button that submits a form: submit only what the objective calls for.',
  schema: clickSchema,
  policy: inSession('cliquer, dans la session approuvée'),
  async run(args, ctx): Promise<ToolResult> {
    return captured(`clicked (${args.x}, ${args.y})`, await port(ctx).click(args.x, args.y))
  },
}

const scrollSchema = z.object({
  dy: z.number().int().min(-5000).max(5000).describe('Pixels to scroll: positive goes down, negative goes up.'),
})

/** Fait défiler. */
export const browserScrollTool: Tool<z.infer<typeof scrollSchema>> = {
  name: 'browser_scroll',
  description: 'Scroll the page vertically.',
  schema: scrollSchema,
  policy: inSession('faire défiler, dans la session approuvée'),
  async run(args, ctx): Promise<ToolResult> {
    return captured(`scrolled ${args.dy} px`, await port(ctx).scroll(args.dy))
  },
}

// --- Saisir et valider, approuvés chacun ------------------------------------

/**
 * Ce que l'humain approuve pour une saisie : la page et le champ visés. Relevés
 * à la préparation, revérifiés au moment d'agir.
 */
interface InputState {
  view: BrowserPageView
  /**
   * Vrai si la saisie est un texte prévu, approuvé avec la session : aucun
   * humain n'attend, il n'y a donc rien à revérifier, mais le texte doit
   * encore figurer dans la liste au moment de taper.
   */
  planned?: boolean
}

/** Fige la page et le champ d'une saisie, pour que l'humain approuve où elle part. */
async function prepareInput(
  ctx: ToolContext,
  what: string,
  detail: Record<string, unknown>,
): Promise<PreparedOperation> {
  const view = await port(ctx).view()
  const state: InputState = { view }
  return {
    summary: `${what} dans ${view.focused ?? 'aucun champ actif'} de ${view.url}`,
    detail: { ...detail, url: view.url, focused: view.focused },
    state,
  }
}

/**
 * Revérifie, au moment d'agir, que la page et le champ sont ceux que l'humain
 * a approuvés. Une page peut changer seule pendant l'attente (un minuteur, une
 * redirection) : taper ailleurs que là où l'humain l'a lu serait une saisie
 * qu'il n'a pas approuvée.
 */
async function checkInput(ctx: ToolContext, prepared: PreparedOperation | undefined): Promise<void> {
  if (!prepared) return
  const { view } = prepared.state as InputState
  const now = await port(ctx).view()
  if (now.url !== view.url || now.focused !== view.focused) {
    throw new ToolError(
      `the page changed while the human was deciding (approved: ${view.focused ?? 'no field'} on ${view.url}; ` +
        `now: ${now.focused ?? 'no field'} on ${now.url}). Nothing was typed: look again, then ask again.`,
    )
  }
}

const typeSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(BROWSER_MAX_TYPE_CHARS)
    .describe('Exact text to type into the focused field. Click the field first.'),
  press_enter: z
    .boolean()
    .default(false)
    .describe('Press Enter right after typing, within the same approval: use it rather than a separate browser_key.'),
})

/**
 * Vrai si cette saisie figure, à la lettre et avec la même Entrée, parmi les
 * textes prévus qui restent à la session : l'humain l'a lue avec elle.
 */
function isPlanned(ctx: ToolContext, args: { text: string; press_enter: boolean }): boolean {
  const s = ctx.browser!.session()
  return !('closed_reason' in s) && s.planned_inputs.some((p) => p.text === args.text && p.press_enter === args.press_enter)
}

/** Saisit un texte dans le champ actif, et presse Entrée si c'est demandé. */
export const browserTypeTool: Tool<z.infer<typeof typeSchema>> = {
  name: 'browser_type',
  description:
    'Type text into the focused field of the page (click it first), then press Enter if `press_enter` is true. ' +
    'A text listed in planned_inputs when the session opened is typed once without asking again, if identical ' +
    'to the letter (same press_enter). Any other text needs a human approval, reading the exact text, the page ' +
    'and the field; if the page changes while they decide, nothing is typed. Never type secrets, passwords or ' +
    'personal data: you have none, and the human will refuse.',
  schema: typeSchema,
  policy: (args, ctx) => {
    const refused = noSession(ctx)
    if (refused) return { decision: 'deny', reason: refused }
    return isPlanned(ctx, args)
      ? { decision: 'allow', reason: 'texte prévu, approuvé avec la session' }
      : { decision: 'approval', reason: 'une saisie est approuvée par un humain, texte exact compris' }
  },
  async prepare(args, ctx): Promise<PreparedOperation> {
    const what = `saisir ${JSON.stringify(args.text)}${args.press_enter ? ' puis presser Entrée' : ''}`
    const op = await prepareInput(ctx, what, { tool: 'browser_type', text: args.text, press_enter: args.press_enter })
    // Même jugement que la politique, au même moment : la boucle exécute les
    // appels l'un après l'autre, la liste n'a donc pas pu changer entre les deux.
    return { ...op, state: { ...(op.state as InputState), planned: isPlanned(ctx, args) } }
  },
  async run(args, ctx, prepared): Promise<ToolResult> {
    const planned = prepared ? (prepared.state as InputState).planned === true : isPlanned(ctx, args)
    if (planned) {
      // Retiré **avant** de taper : un texte prévu ne sert qu'une fois. S'il
      // n'est plus là, rien ne part sans l'humain.
      if (!port(ctx).claimPlanned({ text: args.text, press_enter: args.press_enter })) {
        throw new ToolError('this planned text was already typed in this session: call browser_type again to ask the human')
      }
    } else {
      await checkInput(ctx, prepared)
    }
    let cap = await port(ctx).type(args.text)
    if (args.press_enter) cap = await port(ctx).press('Enter')
    return captured(`typed ${args.text.length} characters${args.press_enter ? ', then pressed Enter' : ''}`, cap)
  },
}

const keySchema = z.object({
  key: z.enum(BROWSER_KEYS).describe('The key to press. Enter on its own needs a human approval: it submits forms.'),
})

/** Presse une touche. Entrée, qui envoie un formulaire, est approuvée. */
export const browserKeyTool: Tool<z.infer<typeof keySchema>> = {
  name: 'browser_key',
  description:
    `Press one key on the page: ${BROWSER_KEYS.join(', ')}. Enter on its own needs a human approval, since it ` +
    'submits forms: after typing, use browser_type with press_enter instead. The other keys are free.',
  schema: keySchema,
  policy: (args, ctx) => {
    const refused = noSession(ctx)
    if (refused) return { decision: 'deny', reason: refused }
    return args.key === 'Enter'
      ? { decision: 'approval', reason: 'Entrée envoie un formulaire : approuvée par un humain' }
      : { decision: 'allow', reason: 'touche de déplacement ou d\'édition, dans la session approuvée' }
  },
  // Préparée pour toute touche, mais seule Entrée est soumise à l'humain : la
  // vérification au moment d'agir ne coûte qu'une lecture de la page.
  prepare: (args, ctx) => prepareInput(ctx, `presser ${args.key}`, { tool: 'browser_key', key: args.key }),
  async run(args, ctx, prepared): Promise<ToolResult> {
    if (args.key === 'Enter') await checkInput(ctx, prepared)
    return captured(`pressed ${args.key}`, await port(ctx).press(args.key))
  },
}
