/**
 * @file `submit_result` : l'outil terminal, le seul qui finit une tâche.
 *
 * Le plan (§4) est catégorique : « arrêt sur résultat structuré explicite :
 * l'agent appelle un outil terminal `submit_result` plutôt que de laisser la
 * boucle deviner la fin depuis du texte libre ».
 *
 * La raison tient à ce qu'on perd autrement. Une boucle qui s'arrête sur « le
 * modèle n'a demandé aucun outil » s'arrête aussi quand il réfléchit à voix
 * haute, quand il pose une question, ou quand il s'excuse. On récupère alors du
 * texte libre là où Claude attend un résultat exploitable, et on ne sait pas
 * distinguer « fini » de « coincé ». Avec un outil terminal, la fin est un
 * **acte**, pas une interprétation.
 *
 * Cet outil n'est pas exécuté comme les autres : la boucle l'intercepte, valide
 * sa charge utile et conclut la tâche. Son `run` n'est qu'un filet.
 */
import { z } from 'zod'
import type { ToolResult } from '@midgaard/contracts'
import type { Tool } from './types.ts'

/**
 * Charge utile du résultat.
 *
 * `citations` n'est pas décoratif : c'est ce qui permet à l'utilisateur de
 * vérifier une affirmation sans refaire la recherche. La description le demande
 * explicitement au modèle, parce qu'un champ facultatif qu'on ne réclame pas
 * reste vide.
 */
export const submitResultSchema = z.object({
  summary: z
    .string()
    .min(1)
    .max(2000)
    .describe('One or two sentences answering the task. The answer itself, not a description of your process.'),
  details: z
    .string()
    .max(40_000)
    .default('')
    .describe('The full answer in Markdown: findings, reasoning, caveats, and what you could not establish.'),
  citations: z
    .array(z.object({ title: z.string().max(300), url: z.string().max(2000) }))
    .max(50)
    .default([])
    .describe('Sources backing the answer. Required for anything you learned from the web.'),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .default('medium')
    .describe('How much the evidence actually supports the answer. Say low rather than guessing.'),
})
export type SubmitResultArgs = z.infer<typeof submitResultSchema>

/** L'outil terminal. */
export const submitResultTool: Tool<SubmitResultArgs> = {
  name: 'submit_result',
  description:
    'Finish the task and return the structured answer. Call this exactly once, when you are done. ' +
    'Nothing else ends the task: writing that you are finished in plain text does not, and the task ' +
    'will keep burning your remaining steps and budget.',
  schema: submitResultSchema,
  policy: () => ({ decision: 'allow', reason: 'résultat structuré, aucun effet de bord' }),

  // La boucle intercepte cet appel avant d'arriver ici. Ce corps n'existe que
  // pour que l'interface reste uniforme et qu'un oubli d'interception se voie.
  async run(args): Promise<ToolResult> {
    return {
      content: args.summary,
      bytes: Buffer.byteLength(args.summary),
      summary: 'résultat soumis',
      untrusted: false,
      citations: args.citations,
    }
  },
}
