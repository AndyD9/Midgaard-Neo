/**
 * @file Lecture d'un patch unifié, sans dépendance au DOM : testable depuis
 * `node --test`, comme `utils.ts`.
 */

/**
 * Découpe un patch unifié en morceaux par fichier, indexés par chemin.
 *
 * Le chemin est lu sur les lignes `+++ b/X` ou `--- a/X` (selon qu'il s'agit
 * d'un ajout ou d'une suppression), produites avec les préfixes imposés par le
 * daemon (`--src-prefix=a/ --dst-prefix=b/`), et en dernier recours sur
 * `diff --git a/X b/X`, ambiguë dès qu'un chemin contient une espace.
 *
 * **Piège constaté** : quand un chemin contient une espace, Git termine les
 * lignes `---`/`+++` par une **tabulation**, pour lever l'ambiguïté. Sans la
 * retirer, le fichier `a b.ts` devenait `a b.ts\t`, et le dashboard affichait
 * « patch absent » pour un fichier bel et bien modifié. Trouvé par le test qui
 * découpe un vrai patch, pas par la lecture de la documentation.
 */
export function splitPatch(patch: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!patch) return out
  const parts = patch.split(/^(?=diff --git )/m)
  for (const part of parts) {
    if (!part.startsWith('diff --git ')) continue
    const plus = /^\+\+\+ b\/(.+?)\t?$/m.exec(part)?.[1]
    const minus = /^--- a\/(.+?)\t?$/m.exec(part)?.[1]
    const header = /^diff --git a\/(.+) b\/\1$/m.exec(part)?.[1]
    const path = plus ?? minus ?? header
    if (path) out.set(path, part.replace(/\n$/, ''))
  }
  return out
}
