/**
 * @file Saisie d'un secret (clé d'API) sur l'entrée standard, pour
 * `harness providers add`.
 *
 * **Rien de ce qui est tapé ne s'affiche.** C'est la seule promesse de ce
 * module, et elle a été fausse de la Slice 2 à la Slice 5 : la saisie coupait
 * bien l'écho du terminal (mode brut), mais ouvrait aussi une interface
 * `readline` en mode terminal, qui **réaffiche elle-même** chaque caractère
 * reçu, précédé de son invite par défaut `> `. La clé finissait en clair dans
 * le terminal et dans son historique (docs/SLICE5.md, leçon n° 36). Ici, aucune
 * `readline` : on lit les octets en mode brut et on n'écrit que l'invite et le
 * retour à la ligne final.
 *
 * Les flux sont injectés pour que le test puisse vérifier, octet pour octet,
 * ce qui a été écrit pendant la saisie.
 */

/** Entrée lisible ; `isTTY` et `setRawMode` n'existent que sur un terminal. */
export interface SecretInput extends NodeJS.ReadableStream {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
}

/** Ce dont la saisie a besoin : l'entrée et la sortie, injectables. */
export interface SecretIo {
  input: SecretInput
  output: { write: (text: string) => unknown }
}

/** Ctrl-C en mode brut : le terminal ne l'envoie plus comme un signal. */
const CTRL_C = '\u0003'
/** Ctrl-D : fin de saisie sans clé. */
const CTRL_D = '\u0004'

/**
 * Lit un secret sur l'entrée standard.
 *
 * Deux modes, selon d'où l'on vient :
 *  - **tube** (`echo "$CLE" | harness providers add …`) : on lit la première
 *    ligne, sans rien afficher ;
 *  - **terminal** : saisie sans écho, en mode brut. Le mode est rétabli dans
 *    tous les cas, y compris sur Ctrl-C — un terminal laissé en mode brut est
 *    inutilisable, et l'utilisateur ne sait pas pourquoi.
 *
 * @param prompt Invite affichée avant la saisie, sans les deux-points.
 * @param io Flux d'entrée et de sortie ; par défaut ceux du processus.
 * @returns Le secret, débarrassé des espaces autour ; `null` si rien n'a été
 *   saisi, ou sur Ctrl-C / Ctrl-D.
 */
export async function readSecret(
  prompt: string,
  io: SecretIo = { input: process.stdin, output: process.stdout },
): Promise<string | null> {
  const { input, output } = io
  if (!input.isTTY || !input.setRawMode) {
    const chunks: Buffer[] = []
    for await (const c of input) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    const first = Buffer.concat(chunks).toString('utf8').split('\n')[0]?.trim()
    return first || null
  }

  const setRawMode = input.setRawMode.bind(input)
  output.write(`${prompt} : `)
  setRawMode(true)
  try {
    const typed = await new Promise<string>((resolve) => {
      let value = ''
      const finish = (result: string) => {
        input.off('data', onData)
        // Le seul écho permis : le retour à la ligne, pour que la sortie
        // suivante ne se colle pas à l'invite.
        output.write('\n')
        resolve(result)
      }
      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        for (const char of text) {
          if (char === '\r' || char === '\n') return finish(value)
          if (char === CTRL_C || char === CTRL_D) return finish('')
          if (char === '\u007f' || char === '\b') {
            value = value.slice(0, -1)
            continue
          }
          value += char
        }
      }
      input.on('data', onData)
      input.resume()
    })
    return typed.trim() || null
  } finally {
    setRawMode(false)
    // Sans pause, l'entrée reste en lecture et retient le processus ouvert.
    input.pause()
  }
}
