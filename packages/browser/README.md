# `@midgaard/browser`

Le navigateur isolé des agents (Slice 7, étape 3) : un **Chromium jetable**,
lancé par Playwright derrière un **proxy gardé**, dont **aucun processus ne
survit**. Le paquet ouvre une session, exécute ce qu'on lui demande et dit ce
qu'il a vu ; il ne connaît ni le daemon, ni la base, ni les approbations, qui
sont l'affaire des outils (`@midgaard/tools`, `browser.ts`) ; le daemon
tient les sessions des tâches (`packages/daemon/src/browsers.ts`).

```ts
const session = await BrowserSession.open()          // garde réelle : assertPublicHost
await session.goto('https://example.org/')
const { jpeg, url, title } = await session.screenshot()
await session.click(120, 40)
await session.focused()                              // « input#q[name="q"] » : ce que l'humain approuve
await session.type('bonjour')                        // approuvé à chaque fois par l'outil
await session.press('Enter')
await session.close()                                // idempotente, ne lève pas
```

Chromium doit être installé une fois : `npx playwright install chromium`.

## Ce que la session garantit

| Garantie | Comment |
|---|---|
| Jetable | Un Chromium neuf par session, un contexte vierge : ni cookie, ni historique, ni session de l'utilisateur |
| Réseau gardé | Toute requête passe par le proxy (`proxy.ts`), qui se connecte **à l'adresse qu'il a jugée** — pas au nom —, donc sans *DNS rebinding*. Même règle qu'`http_fetch` : privé, boucle locale et IMDS refusés |
| Boucle locale gardée aussi | `--proxy-bypass-list=<-loopback>` : Chromium contourne d'office un proxy pour `127.0.0.1`, Playwright l'en empêche **sauf** si `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` est posée ; le drapeau tient alors. Vu échouer sans lui, variable posée |
| Schémas | `http:` et `https:` seulement : ni `file:`, ni `javascript:`, ni `chrome:` |
| Sans privilège | Aucun téléchargement, aucune permission, aucun service worker, aucune extension |
| Une seule page | Une fenêtre surgissante est fermée aussitôt |
| Touches | Une liste fermée (`ALLOWED_KEYS`, qui est `BROWSER_KEYS` du paquet `tools`) : pas de raccourci du navigateur |
| Aucun processus survivant | Chromium est chef de son groupe (constaté) ; confié à la garde d'`exec` dès son lancement, tué par groupe à la fermeture, et par la garde si le daemon meurt net — compté au système dans les tests, **Chromium figé avant** (`SIGSTOP`) : sinon il quitte seul à la mort de son parent, et le test passait sans la garde (Slice 7, étape 7) |

La garde est **injectable** (`guard`) pour que les tests servent leur page
locale ; le daemon passe toujours la vraie.

## Pourquoi un proxy, et pas l'interception de Playwright

`route` jugerait un **nom**, que Chromium résoudrait ensuite lui-même : entre
les deux, le DNS peut changer de réponse. Il ne voit pas non plus les
WebSocket. Le proxy voit tout ce qui sort, et c'est lui qui se connecte.

## Ce qu'elle ne garantit pas

`focused()` décrit le champ actif **d'après la page** : une page hostile peut
mentir sur la description de son propre champ, pas déplacer le clavier — la
saisie va au vrai focus. La revérification avant de taper attrape une page qui
change ; elle ne protège pas d'une page qui ment sur elle-même, et la saisie
reste dans cette page.

Ce n'est pas une sandbox : Chromium tourne sous le compte de l'utilisateur,
avec le bac à sable de Chromium et rien de plus. Une faille de Chromium
exploitée par une page atteindrait ce que l'utilisateur atteint. Le paquet
réduit ce que la page peut **faire** — réseau, fichiers, permissions — et ne
promet rien au-delà.
