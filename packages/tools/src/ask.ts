/**
 * @file `ask_parent` : la question d'une sous-tâche à l'orchestrateur qui l'a
 * déléguée (Slice 6).
 *
 * Comme `submit_result`, l'outil n'est pas exécuté comme les autres : la boucle
 * l'intercepte et suspend la tâche (`waiting_input`, `question`) jusqu'à la
 * réponse du parent, qu'elle rend au modèle comme résultat de l'appel. Son
 * `run` n'est qu'un filet, qui refuse : arrivé là, l'interception a manqué.
 *
 * Le daemon ne le donne qu'aux tâches qui ont un parent. Un Developer délégué
 * par Claude n'a personne à qui poser la question : il le dit dans son
 * résultat, comme avant.
 */
import { z } from 'zod'
import type { ToolResult } from '@midgaard/contracts'
import { ToolError, type Tool } from './types.ts'

/** Nom de l'outil, que la boucle intercepte. */
export const ASK_PARENT = 'ask_parent'

export const askParentSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(4000)
    .describe('One precise question that only the orchestrator can answer, with the options you see.'),
})
export type AskParentArgs = z.infer<typeof askParentSchema>

/** La question au parent. */
export const askParentTool: Tool<AskParentArgs> = {
  name: ASK_PARENT,
  description:
    'Ask the orchestrator that delegated this task a question, and wait for its answer, which comes back as ' +
    'this call\'s result. Use it only when you are blocked by something the task and context do not settle ' +
    '(an ambiguous requirement, a choice between two designs). It costs a step on both sides: do not ask what ' +
    'you can find in the project yourself.',
  schema: askParentSchema,
  policy: () => ({ decision: 'allow', reason: 'question à la tâche parente, aucun effet de bord' }),

  async run(): Promise<ToolResult> {
    throw new ToolError('ask_parent is not available here: this task has no orchestrator to ask')
  },
}
