/**
 * @file `read_image` (Slice 7, étape 2) : une image du projet, montrée au
 * modèle.
 *
 * Quatre règles, chacune pour une raison :
 *
 *  - **le type se lit dans les octets**, jamais dans l'extension : un `.png`
 *    qui n'en est pas un serait envoyé au fournisseur sous un faux type, et un
 *    fichier texte renommé ferait payer des jetons d'image pour du bruit ;
 *  - **la taille est plafonnée avant la lecture**, d'après la taille relevée à
 *    l'ouverture du descripteur : un fichier énorme est refusé sans être lu ;
 *  - **le chemin passe par `openUnderRoot`**, comme `read_file` : racine
 *    canonique, liens sortants refusés, identité du descripteur revérifiée ;
 *  - **seule l'empreinte va au journal** : chemin, type, taille et SHA-256 —
 *    jamais les octets. Une image peut montrer un secret, et l'expurgation ne
 *    sait pas lire une image (docs/SLICE7.md, décision 1).
 *
 * Sans modèle qui lit les images, l'outil **refuse avec son motif**, sans
 * approbation à la place : envoyer une image à un modèle qui l'ignore la
 * ferait payer pour rien (décision 2). Une image du projet n'est pas
 * encadrée : elle n'est pas plus suspecte que le dépôt (décision 4).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ImageMediaType, ToolResult } from '@midgaard/contracts'
import { openUnderRoot, toolPath } from './paths.ts'
import { ToolError, type Tool, type ToolContext } from './types.ts'

/**
 * Taille maximale d'une image, en octets. Quatre mégaoctets : au-dessus des
 * captures et des maquettes courantes, en dessous des plafonds des
 * fournisseurs — et une image compte déjà mille jetons pour 1,4 Ko de PNG
 * (essai de l'étape 1).
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/**
 * Le type d'une image, d'après ses premiers octets ; `null` si ce n'en est
 * pas une que les fournisseurs admettent.
 */
export function sniffImageType(bytes: Buffer): ImageMediaType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/** Pourquoi l'outil est refusé à ce modèle, ou `null` s'il lit les images. */
function visionRefusal(ctx: ToolContext): string | null {
  if (ctx.vision?.enabled) return null
  return ctx.vision?.reason ?? 'this model cannot read images'
}

const readImageSchema = z.object({
  path: z.string().min(1).describe('Image file path, relative to the project root (PNG, JPEG, WebP or GIF).'),
})

/** Montre une image du projet au modèle. */
export const readImageTool: Tool<z.infer<typeof readImageSchema>> = {
  name: 'read_image',
  description:
    'Look at one image file from the project — a screenshot, a mockup, a diagram — and see it. PNG, JPEG, WebP ' +
    `and GIF, up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB; the type is read from the file content, not its name. ` +
    'The image is shown to you right after this call. An image costs many input tokens: open only the ones you need.',
  schema: readImageSchema,
  policy: (_args, ctx) => {
    const refused = visionRefusal(ctx)
    return refused ? { decision: 'deny', reason: refused } : { decision: 'allow', reason: 'lecture seule sous la racine du projet' }
  },

  async run(args, ctx): Promise<ToolResult> {
    // Filet : la politique a déjà refusé, mais un appel direct ne doit pas
    // envoyer d'image à un modèle qui ne les lit pas.
    const refused = visionRefusal(ctx)
    if (refused) throw new ToolError(refused)
    const { handle, path, size } = await openUnderRoot(ctx.root, args.path)
    try {
      if (size > MAX_IMAGE_BYTES) {
        throw new ToolError(`image too large: ${args.path} is ${size} bytes, the limit is ${MAX_IMAGE_BYTES}`)
      }
      const buffer = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buffer, 0, size, 0)
      const bytes = buffer.subarray(0, bytesRead)
      const mediaType = sniffImageType(bytes)
      if (!mediaType) throw new ToolError(`not a PNG, JPEG, WebP or GIF image: ${args.path}`)
      const rel = toolPath(ctx.root, path)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      return {
        content: `Image ${rel} (${mediaType}, ${bytesRead} bytes) is attached below.`,
        bytes: bytesRead,
        // Ce que le journal garde de l'image : de quoi la retrouver et la
        // reconnaître, rien de ce qu'elle montre.
        summary: `${rel} · ${mediaType} · ${bytesRead} octets · sha256 ${sha256.slice(0, 16)}`,
        untrusted: false,
        images: [{ mediaType, data: bytes.toString('base64') }],
      }
    } finally {
      await handle.close().catch(() => {})
    }
  },
}
