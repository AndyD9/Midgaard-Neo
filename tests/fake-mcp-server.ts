/**
 * @file Faux serveur MCP stdio, pour éprouver le client du daemon
 * (`@midgaard/mcp-client`, Slice 8) sans REA ni Ghidra.
 *
 * C'est un vrai serveur du SDK, sur un vrai tube : seul son comportement est
 * scripté, par des outils qui reproduisent ce qu'un serveur réel fait de
 * gênant — durer, annoncer sa progression, lancer un processus à lui, mourir
 * en cours d'appel, écrire sur sa sortie d'erreur.
 *
 * Il se lance par `node [--conditions=midgaard-dev] tests/fake-mcp-server.ts`,
 * suivi d'un mode facultatif :
 *
 *  - `--hang` : lit son entrée sans jamais répondre, `initialize` compris ;
 *  - `--stubborn` : ignore `SIGTERM` et survit à la fermeture de son entrée,
 *    pour prouver que l'arrêt va jusqu'à `SIGKILL` ;
 *  - `--fail-with-env NOM` : écrit la valeur de la variable `NOM` sur sa
 *    sortie d'erreur, puis quitte sans répondre — comme un serveur qui
 *    répète un jeton dans son message d'échec. Le test vérifie qu'elle est
 *    expurgée avant d'être montrée.
 *
 * `FAKE_MCP_ECHO_DESCRIPTION`, si elle est déclarée, remplace la description
 * de l'outil `echo` : c'est un serveur mis à jour qui annonce un outil
 * autrement, pour éprouver l'empreinte d'un outil coché (Slice 8, étape 2).
 * `FAKE_MCP_ECHO_DESCRIPTION_FILE` la lit dans un fichier, relu à chaque
 * lancement : un serveur mis à jour **sur place**, sans que sa déclaration
 * change (étape 3).
 *
 * Le dossier `FAKE_MCP_MARKS`, s'il est déclaré dans son environnement, reçoit
 * un fichier par événement que le test doit constater sans le lui demander
 * (`cancelled` : une annulation reçue ; `server-<pid>` : un processus serveur
 * lancé, `sleeper-<pid>` : un fils lancé par `spawn_sleeper`, pour compter
 * ceux qui survivraient). Il reçoit aussi `calls.log`, une ligne par appel
 * d'outil **reçu** : c'est ce qui prouve qu'un appel refusé n'est jamais
 * arrivé au serveur (`test:security`, X10).
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const mode = process.argv[2]
const marks = process.env.FAKE_MCP_MARKS

/** Laisse une trace que le test lira : le serveur n'a pas d'autre moyen de lui parler hors protocole. */
function mark(name: string, content = ''): void {
  if (marks) writeFileSync(join(marks, name), content)
}

/** Note qu'un appel est arrivé jusqu'ici, avant d'y répondre. */
function called(tool: string): void {
  if (marks) appendFileSync(join(marks, 'calls.log'), `${tool}\n`)
}

if (mode === '--fail-with-env') {
  process.stderr.write(`cannot start: token ${process.env[process.argv[3] ?? ''] ?? '(absent)'} refused\n`)
  process.exit(1)
} else if (mode === '--hang') {
  // Lit sans répondre : un programme qui n'est pas un serveur MCP.
  process.stdin.resume()
} else {
  if (mode === '--stubborn') {
    process.on('SIGTERM', () => {})
    // Survit à la fin de l'entrée : rien d'autre ne le retient.
    setInterval(() => {}, 1_000)
  }

  const server = new McpServer({ name: 'fake-mcp', version: '1.0.0' }, { instructions: 'Fake server for tests.' })

  server.registerTool(
    'echo',
    {
      description:
        (process.env.FAKE_MCP_ECHO_DESCRIPTION_FILE && existsSync(process.env.FAKE_MCP_ECHO_DESCRIPTION_FILE)
          ? readFileSync(process.env.FAKE_MCP_ECHO_DESCRIPTION_FILE, 'utf8')
          : process.env.FAKE_MCP_ECHO_DESCRIPTION) ?? 'Return the text it was given.',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => {
      called('echo')
      return { content: [{ type: 'text', text }] }
    },
  )

  server.registerTool(
    'env',
    {
      description: 'List the names of the environment variables it received, or return the value of one.',
      inputSchema: { name: z.string().optional() },
    },
    async ({ name }) => {
      called('env')
      // Rendre une valeur : c'est ainsi qu'un serveur répète un jeton qu'on lui
      // a confié, et que la suite de sécurité vérifie qu'il est expurgé.
      const text = name ? (process.env[name] ?? '(absent)') : JSON.stringify(Object.keys(process.env).sort())
      return { content: [{ type: 'text', text }] }
    },
  )

  server.registerTool(
    'slow',
    { description: 'Wait, announcing progress, unless cancelled.', inputSchema: { ms: z.number() } },
    async ({ ms }, extra) => {
      called('slow')
      const started = Date.now()
      let step = 0
      while (Date.now() - started < ms) {
        if (extra.signal.aborted) {
          mark('cancelled', String(Date.now()))
          return { content: [{ type: 'text', text: 'cancelled' }], isError: true }
        }
        if (extra._meta?.progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken: extra._meta.progressToken, progress: ++step, message: `step ${step}` },
          })
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      return { content: [{ type: 'text', text: 'done' }] }
    },
  )

  server.registerTool('spawn_sleeper', { description: 'Start a child process that never ends; return its pid.' }, async () => {
    // Un fils **non détaché** : il reste dans le groupe du serveur, comme
    // Ghidra lancé par REA. Il ne lit pas son entrée, donc il ne mourra pas
    // de lui-même avec son parent : seul un signal au groupe le tue.
    called('spawn_sleeper')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    mark(`sleeper-${child.pid}`, String(child.pid))
    return { content: [{ type: 'text', text: String(child.pid) }] }
  })

  server.registerTool(
    'exit',
    { description: 'Exit the server process in the middle of the call.', inputSchema: { code: z.number() } },
    async ({ code }) => {
      setTimeout(() => process.exit(code), 20)
      return new Promise(() => {})
    },
  )

  server.registerTool(
    'stderr',
    { description: 'Write the text on standard error.', inputSchema: { text: z.string() } },
    async ({ text }) => {
      process.stderr.write(text)
      return { content: [{ type: 'text', text: 'written' }] }
    },
  )

  server.registerTool('fail', { description: 'A tool that reports an error result.' }, async () => ({
    content: [{ type: 'text', text: 'it went wrong' }],
    isError: true,
  }))

  await server.connect(new StdioServerTransport())
  // Un fichier par processus lancé : le test compte ensuite ceux qui vivent encore.
  mark(`server-${process.pid}`, String(process.pid))
}
