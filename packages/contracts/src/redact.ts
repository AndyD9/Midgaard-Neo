/**
 * @file Expurgation des secrets, avant journalisation et avant persistance.
 *
 * Le plan (§5) l'exige : « expurgation par motif dans tous les logs et
 * événements avant persistance ». La raison est banale et c'est pour cela
 * qu'elle compte — un secret qui traverse un outil, une erreur de fournisseur ou
 * une page web finit dans une base que l'utilisateur sauvegardera, copiera, ou
 * joindra à un rapport de bogue sans y penser.
 *
 * Deux filets, et il en faut deux :
 *
 *  1. **Les secrets connus**, passés explicitement. C'est le filet exact : on
 *     sait quoi chercher, on ne peut pas le manquer.
 *  2. **Les motifs**, pour les secrets qu'on ne connaît pas — une clé tierce
 *     trouvée dans un fichier lu par un outil, un jeton dans une page web. Ce
 *     filet-là est forcément incomplet, et c'est assumé : il attrape les formes
 *     courantes, pas toutes.
 *
 * Ce qu'on ne fait **pas** : expurger les chaînes courtes. Remplacer toute
 * séquence qui ressemble à un secret rendrait les journaux illisibles et
 * cacherait les vraies erreurs. Les motifs exigent donc une longueur minimale.
 */

/** Ce qui remplace un secret expurgé. Volontairement visible dans un journal. */
export const REDACTED = '«secret expurgé»'

/**
 * Motifs de secrets courants.
 *
 * Chacun exige une longueur qui rend la coïncidence improbable : `sk-` suivi de
 * seize caractères n'arrive pas par hasard dans une phrase, `sk-` tout seul si.
 */
const PATTERNS: readonly RegExp[] = [
  // Clés de style OpenAI et compatibles, Venice comprise : sk-…, sk-proj-…
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Clés Google (Gemini, Maps…) : AIza suivi d'au moins 35 caractères. Le `,`
  // compte : une longueur fixe laissait en clair la queue d'une clé plus longue,
  // et c'est justement la queue qu'il ne faut pas laisser.
  /\bAIza[0-9A-Za-z_-]{35,}/g,
  // Jetons porteurs dans un en-tête ou une trace d'erreur.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  // Clés Anthropic.
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  // Jetons GitHub (ghp_, gho_, ghs_, github_pat_).
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Clés d'accès AWS.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Un « api_key »/« token »/« secret » suivi de sa valeur, dans du JSON ou une URL.
  /\b(api[_-]?key|access[_-]?token|secret|password)\b["'\s:=]+["']?([A-Za-z0-9._~+/=-]{16,})["']?/gi,
]

/**
 * Construit une fonction d'expurgation.
 *
 * @param secrets secrets connus, par exemple les clés des fournisseurs
 *                configurés. Les chaînes de moins de huit caractères sont
 *                ignorées : expurger `abc` effacerait la moitié des journaux.
 * @returns une fonction qui expurge un texte
 *
 * @example
 * const redact = createRedactor([apiKey])
 * log(redact(error.message))
 */
export function createRedactor(secrets: readonly string[] = []): (text: string) => string {
  // Les plus longs d'abord : si un secret est le préfixe d'un autre, remplacer
  // le court en premier laisserait la fin du long en clair.
  const known = [...new Set(secrets.filter((s) => s.length >= 8))].sort((a, b) => b.length - a.length)

  return (text: string): string => {
    if (!text) return text
    let out = text
    for (const secret of known) out = out.split(secret).join(REDACTED)
    for (const pattern of PATTERNS) {
      // Les motifs à groupe de capture ne remplacent que la **valeur**, pour que
      // `"api_key": "…"` reste lisible comme tel dans un journal expurgé.
      out = out.replace(pattern, (match: string, ...rest: unknown[]) => {
        // `String.replace` passe, après les groupes de capture, l'offset puis le
        // **texte entier**. Celui-ci est une chaîne longue : le confondre avec
        // un groupe faisait chercher tout le document à l'intérieur du seul
        // motif trouvé, donc ne remplaçait rien. Mesuré, pas supposé.
        const captures = rest.slice(0, Math.max(0, rest.length - 2))
        const value = captures.find((g): g is string => typeof g === 'string' && g.length >= 16)
        return value ? match.replace(value, REDACTED) : REDACTED
      })
    }
    return out
  }
}

/**
 * Expurge en profondeur une valeur JSON, clés comprises.
 *
 * Sert aux arguments d'appels d'outils, qui sont persistés : ce sont des objets,
 * pas du texte, et les sérialiser pour les expurger puis les reparser perdrait
 * leur forme en cas de contenu non sérialisable.
 *
 * @param depth garde-fou contre une structure cyclique ou absurdement profonde
 */
export function redactDeep(value: unknown, redact: (t: string) => string, depth = 0): unknown {
  if (depth > 12) return '«profondeur maximale atteinte»'
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact, depth + 1)
    return out
  }
  return value
}
