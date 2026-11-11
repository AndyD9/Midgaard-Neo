/**
 * @file Lancement des utilitaires système, avec les précautions qui vont avec.
 *
 * Trois règles, toutes issues de §5 du plan :
 *
 *  1. **`execFile`, jamais `exec`.** Aucun shell n'est interposé, donc aucun
 *     `;`, `|` ou `$()` d'un argument ne peut devenir une commande.
 *  2. **Environnement reconstruit.** Les utilitaires reçoivent le strict
 *     nécessaire, jamais `process.env` hérité : une variable `PATH` détournée
 *     suffirait à faire exécuter autre chose que `security`.
 *  3. **Délai et terminaison.** Un utilitaire qui attend une saisie bloquerait
 *     le daemon ; il est tué au bout de {@link EXEC_TIMEOUT_MS}.
 *
 * Le secret, lui, passe par **stdin** partout où c'est possible. Reste le cas de
 * `security` sur macOS, qui n'accepte un mot de passe qu'en argument : il est
 * alors visible dans `ps` pour les processus **du même utilisateur**, ce que le
 * modèle de menace du harness place déjà hors périmètre (voir
 * `packages/daemon/README.md`). C'est dit, pas caché.
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** Délai au-delà duquel un utilitaire est considéré bloqué. */
export const EXEC_TIMEOUT_MS = 10_000

/**
 * Délai accordé à PowerShell, plus large et mesuré.
 *
 * PowerShell reconstruit son **cache d'analyse de modules** quand il n'en
 * trouve pas : 8 à 15 s sur un runner Windows, contre 264 ms une fois le cache
 * en place. C'est long, mais ce n'est pas un blocage — et couper à 10 s ferait
 * échouer le tout premier appel d'une machine au cache froid, là où patienter
 * une fois suffit. Le délai reste borné : il protège d'une attente infinie, pas
 * d'une lenteur légitime.
 */
export const POWERSHELL_TIMEOUT_MS = 40_000

/** Sortie d'un utilitaire. `code` vaut `null` s'il a été tué par un signal. */
export interface ExecOutcome {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Lance un utilitaire et attend sa fin.
 *
 * Ne **lève pas** sur un code de sortie non nul : un `find-generic-password` qui
 * ne trouve rien sort en 44, ce qui est une réponse, pas une panne. L'appelant
 * interprète le code.
 *
 * @param file     binaire à lancer, résolu via le `PATH` reconstruit
 * @param args     arguments, passés tels quels sans interprétation shell
 * @param stdin    donnée à écrire sur l'entrée standard, par exemple un secret
 * @param timeoutMs délai propre à cet appel ; {@link POWERSHELL_TIMEOUT_MS} pour
 *                  PowerShell, qui a une lenteur légitime au premier démarrage
 * @param extraEnv variables ajoutées à {@link minimalEnv} pour ce seul appel.
 *                 C'est ainsi qu'une donnée variable atteint un script sans être
 *                 concaténée à son code — voir le coffre DPAPI. Écrire dans
 *                 `process.env` ne marcherait pas : l'environnement du fils est
 *                 reconstruit, et deux appels concurrents se marcheraient dessus.
 */
export function run(
  file: string,
  args: string[],
  stdin?: string,
  extraEnv?: NodeJS.ProcessEnv,
  timeoutMs: number = EXEC_TIMEOUT_MS,
): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        // Un secret peut faire quelques kilo-octets ; une liste de modèles, plus.
        maxBuffer: 1024 * 1024,
        env: { ...minimalEnv(), ...extraEnv },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
        // ENOENT : le binaire n'existe pas sur cette machine. C'est le cas
        // nominal quand on sonde les coffres pour savoir lequel est utilisable.
        if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) return reject(err)
        // Un utilitaire tué par le délai doit le **dire**. Sans cette ligne, il
        // ressort en « code 1 » avec une sortie d'erreur vide, exactement comme
        // un échec ordinaire — et on cherche la panne là où elle n'est pas.
        // Mesuré : six cas Windows expirés à 10 s se sont présentés en CI comme
        // « windows-dpapi : code 1 ».
        const timedOut = Boolean(err?.killed)
        resolve({
          code: typeof err?.code === 'number' ? err.code : err ? 1 : 0,
          stdout: String(stdout),
          stderr: timedOut
            ? `${file} n'a pas rendu la main en ${timeoutMs / 1000} s et a été tué${
                String(stderr).trim() ? ` — ${String(stderr).trim()}` : ''
              }`
            : String(stderr),
        })
      },
    )
    child.on('error', reject)
    // Un fils qui sort sans lire son entrée fait échouer l'écriture en `EPIPE`.
    // L'erreur naît sur le flux `stdin`, pas sur le processus : sans écouteur,
    // elle devenait une exception non rattrapée — un daemon tué par un appel au
    // coffre. Constaté à la Slice 4, étape 7, d'abord en échec intermittent de
    // `secrets.test.ts`. Rien à en faire de plus : le code de sortie et la
    // sortie d'erreur du fils, rendus plus haut, disent pourquoi il est parti.
    child.stdin?.on('error', () => {})
    // Toujours fermer l'entrée standard, même quand on n'a rien à écrire. Un
    // utilitaire qui se met à poser une question — PowerShell le fait dès qu'un
    // paramètre obligatoire reçoit `$null` — lit alors une fin de fichier et
    // échoue aussitôt avec son message, au lieu d'attendre une réponse qui ne
    // viendra jamais et de se faire tuer au bout du délai.
    child.stdin?.end(stdin ?? '')
  })
}

/**
 * Environnement minimal des utilitaires.
 *
 * Ce qui est repris l'est pour une raison nommée, et rien d'autre ne passe :
 * ajouter une variable ici, c'est l'exposer à trois utilitaires système.
 *
 * Une seule variable est **imposée** plutôt que reprise : `PSModulePath` sous
 * Windows, pour que PowerShell cesse de parcourir les modules de la machine —
 * voir le commentaire dans le corps.
 *
 * `PATH` est repris pour que `security`, `secret-tool` et `powershell` restent
 * trouvables — les remplacer par des chemins absolus en dur casserait les
 * installations non standard, et un `PATH` détourné suppose déjà un attaquant
 * dans la session de l'utilisateur, donc déjà vainqueur. `HOME`, `USERPROFILE`
 * et `LOCALAPPDATA` sont nécessaires pour que chaque mécanisme trouve son
 * propre magasin.
 *
 * @param platform plateforme visée ; injectée pour que la branche Windows soit
 *                 vérifiable depuis un Mac — c'est la leçon de `dpapiDir` :
 *                 une règle qui ne s'exécute que sur une plateforme doit au
 *                 moins pouvoir se **lire** sur les autres
 * @param source   environnement d'origine ; injecté pour la même raison
 * @returns l'environnement transmis aux utilitaires, à compléter par appel
 */
export function minimalEnv(
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const keep = [
    'PATH', 'Path',
    'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'TEMP', 'TMP',
    // `secret-tool` ne parle pas au trousseau directement : il passe par le bus
    // de session. Sans ces deux variables il ne le trouve pas, échoue sur une
    // machine où le trousseau fonctionne pourtant, et le harness se rabat sur
    // le fichier en croyant qu'il n'y a pas de trousseau.
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR',
    // PowerShell range là son cache d'analyse de modules. Sans cette variable,
    // il le reconstruit à **chaque** appel : 8 à 15 s, contre 264 ms quand il
    // le retrouve. Trouvée par bissection sur les 145 variables que notre liste
    // écartait, après deux hypothèses fausses — ce n'était ni l'environnement
    // perdu, ni `PSModulePath`. Absente de la plupart des machines, où
    // PowerShell retombe sur un emplacement par défaut sous `LOCALAPPDATA`,
    // que l'on transmet déjà.
    'PSModuleAnalysisCachePath',
  ]
  const env: NodeJS.ProcessEnv = { LC_ALL: 'C' }
  for (const k of keep) if (source[k] !== undefined) env[k] = source[k]

  // Windows : `PSModulePath` est **imposée**, et réduite aux modules du système.
  //
  // La raison est de **sécurité**, et elle seule : un module déposé dans un des
  // dossiers de la liste héritée peut masquer une applet, et celles employées
  // ici manipulent des clés d'API en clair. Pointer vers le seul dossier du
  // système ferme cette porte — c'est la même raison qui fait reconstruire tout
  // cet environnement.
  //
  // ⚠️ Ce n'est **pas** le correctif d'un défaut connu, et une version
  // précédente de ce commentaire l'affirmait à tort. Sur un runner Windows,
  // PowerShell met 11 à 15 s à répondre dès qu'une applet est appelée avec cet
  // environnement réduit, contre moins d'une seconde avec l'environnement
  // complet — et imposer `PSModulePath` n'y change rien, mesuré. Il manque donc
  // autre chose à cette liste ; la cause reste ouverte, et le coffre DPAPI
  // n'est pas constaté tant qu'elle l'est.
  if (platform === 'win32' && env.SystemRoot) {
    env.PSModulePath = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
  }
  return env
}
