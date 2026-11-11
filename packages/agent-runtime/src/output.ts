/**
 * @file La sortie d'une commande, préparée pour le terminal du dashboard
 * (Slice 6, étape 4) : découpée par ligne, expurgée, regroupée, plafonnée.
 *
 * `exec` lit sa sortie par morceaux, coupés où le système le veut — au milieu
 * d'une ligne, d'une clé, et même d'un caractère UTF-8. Quatre règles, dans cet
 * ordre, et chacune pour une raison :
 *
 *  1. **Décoder par flux.** Un caractère accentué coupé entre deux morceaux
 *     deviendrait deux caractères de remplacement si chaque morceau était
 *     décodé seul : `StringDecoder` garde l'octet incomplet pour le suivant.
 *  2. **Découper par ligne avant d'expurger.** Les motifs de l'expurgation
 *     cherchent une clé entière : coupée entre deux morceaux, elle passerait
 *     en deux moitiés, chacune trop courte pour être reconnue — et serait
 *     écrite en base. Une ligne incomplète attend donc la suite. Une ligne qui
 *     n'en finit pas (une barre de progression sans retour à la ligne) est
 *     livrée par tranches de {@link MAX_HELD_LINE} caractères, sans quoi rien
 *     ne s'afficherait jamais. Une clé à cheval sur une telle coupure n'est pas
 *     couverte : c'est la limite dite, pas une promesse.
 *  3. **Regrouper.** Une commande bavarde écrit des milliers de lignes ; un
 *     événement par ligne remplirait le journal et la reprise WebSocket. Les
 *     lignes sont livrées toutes les {@link FLUSH_MS} ms, un lot par flux.
 *  4. **Plafonner.** Au-delà de {@link MAX_COMMAND_BYTES} par commande, la
 *     sortie n'est plus écrite, et la fin le **dit**, avec ce qui manque.
 *
 * Ce que reçoit le modèle ne passe pas par ici : il lit la capture tête et
 * queue d'`exec`, inchangée.
 */
import { StringDecoder } from 'node:string_decoder'

/** Intervalle de regroupement : assez court pour paraître en direct. */
export const FLUSH_MS = 250
/** Sortie écrite au plus, par commande, tous flux confondus. */
export const MAX_COMMAND_BYTES = 128 * 1024
/** Ligne sans fin livrée par tranches de cette taille, en caractères. */
export const MAX_HELD_LINE = 4096

/** Un flux de sortie. */
export type OutputStream = 'stdout' | 'stderr'

/** Ce qui est livré : un lot de lignes d'un flux, ou l'avis de troncature final. */
export interface OutputBatch {
  stream: OutputStream
  /** Lignes expurgées, retours à la ligne compris. */
  text: string
  /** Présent sur le dernier lot quand le plafond a été atteint : octets non écrits. */
  omitted_bytes?: number
}

/** Ce qu'il faut pour préparer une sortie. */
export interface OutputBatcherOptions {
  /** Expurgation de la tâche, appliquée à chaque ligne complète. */
  redact: (text: string) => string
  /** Reçoit chaque lot prêt. Ne doit pas lever ; s'il le fait, le lot est perdu. */
  emit: (batch: OutputBatch) => void
  flushMs?: number
  maxBytes?: number
  /** Minuterie injectable, pour les tests. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void }
}

/** État d'un flux : son décodeur, la ligne en cours, les lignes prêtes. */
interface StreamState {
  decoder: StringDecoder
  partial: string
  ready: string[]
}

/**
 * Prépare la sortie d'**une** commande. `write` à chaque morceau, `close` à la
 * fin : `close` livre la dernière ligne, même sans retour à la ligne, et l'avis
 * de troncature.
 */
export class OutputBatcher {
  private readonly options: Required<Omit<OutputBatcherOptions, 'schedule'>> & Pick<OutputBatcherOptions, 'schedule'>
  private readonly streams: Record<OutputStream, StreamState> = {
    stdout: { decoder: new StringDecoder('utf8'), partial: '', ready: [] },
    stderr: { decoder: new StringDecoder('utf8'), partial: '', ready: [] },
  }
  private written = 0
  private omitted = 0
  private timer: { cancel(): void } | null = null
  private closed = false

  constructor(options: OutputBatcherOptions) {
    this.options = { flushMs: FLUSH_MS, maxBytes: MAX_COMMAND_BYTES, ...options }
  }

  /** Reçoit un morceau brut. Sans effet après {@link OutputBatcher.close}. */
  write(stream: OutputStream, chunk: Buffer): void {
    if (this.closed) return
    const state = this.streams[stream]
    state.partial += state.decoder.write(chunk)
    let newline = state.partial.indexOf('\n')
    while (newline !== -1) {
      this.take(state, state.partial.slice(0, newline + 1))
      state.partial = state.partial.slice(newline + 1)
      newline = state.partial.indexOf('\n')
    }
    while (state.partial.length >= MAX_HELD_LINE) {
      this.take(state, state.partial.slice(0, MAX_HELD_LINE))
      state.partial = state.partial.slice(MAX_HELD_LINE)
    }
    this.arm()
  }

  /** Livre ce qui reste, la dernière ligne et l'avis de troncature. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.timer?.cancel()
    this.timer = null
    for (const stream of ['stdout', 'stderr'] as const) {
      const state = this.streams[stream]
      const rest = state.partial + state.decoder.end()
      state.partial = ''
      if (rest) this.take(state, rest)
    }
    this.flush()
    if (this.omitted > 0) {
      this.options.emit({
        stream: 'stderr',
        text: `[… ${this.omitted} octets de sortie non affichés : plafond du terminal atteint]\n`,
        omitted_bytes: this.omitted,
      })
    }
  }

  /** Expurge une ligne et la met de côté, ou la compte comme omise au-delà du plafond. */
  private take(state: StreamState, line: string): void {
    const clean = this.options.redact(line)
    const bytes = Buffer.byteLength(clean)
    if (this.written + bytes > this.options.maxBytes) {
      this.omitted += bytes
      return
    }
    this.written += bytes
    state.ready.push(clean)
  }

  /** Programme la prochaine livraison, s'il y a de quoi livrer et rien de programmé. */
  private arm(): void {
    if (this.timer || this.closed) return
    if (this.streams.stdout.ready.length === 0 && this.streams.stderr.ready.length === 0) return
    const fire = () => {
      this.timer = null
      this.flush()
    }
    this.timer = this.options.schedule
      ? this.options.schedule(fire, this.options.flushMs)
      : defaultSchedule(fire, this.options.flushMs)
  }

  /** Livre un lot par flux qui a des lignes prêtes. */
  private flush(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const state = this.streams[stream]
      if (state.ready.length === 0) continue
      const text = state.ready.join('')
      state.ready = []
      this.options.emit({ stream, text })
    }
  }
}

/** Minuterie réelle, qui ne retient pas le processus. */
function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const t = setTimeout(fn, ms)
  t.unref()
  return { cancel: () => clearTimeout(t) }
}
