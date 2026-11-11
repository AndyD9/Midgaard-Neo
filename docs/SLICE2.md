# Slice 2 — Agents réels

**Date :** 2026-10-29 · **Objectif :** faire tourner de **vrais** agents — des
fournisseurs derrière une interface commune, une boucle avec budgets et limites,
des outils de lecture contrôlés, un coffre pour les clés, et un coût qui
corresponde à la facture.

**État : livrable atteint, mesuré, et éprouvé en vraie session.** Un Researcher
exécute de vraies tâches sur Venice, et **le coût affiché correspond au centime
près au solde débité** — vérifié **trois** fois, à 0,0 % d'écart, en relevant le
solde chez le fournisseur avant et après. 174 vérifications unitaires (dont 41
de coffre, rejouées sur quatre plateformes en intégration continue), 10
d'instance unique, 7 d'intégration, 7 d'interface dans un vrai navigateur, 12 de
bout en bout MCP et 5 d'essai réel, 0 échec.

*(Ce document a été complété le 2026-10-29 : trois des cinq dettes qu'il
ouvrait sont soldées, et le § « Les dettes, soldées » raconte les sept pannes
réelles que leur fermeture a révélées — dont trois par l'intégration continue,
qui a demandé cinq passages pour obtenir quatre verts.)*

L'essai en vraie session Claude Code, que la version précédente de ce document
annonçait comme restant à faire, **a eu lieu** : il confirme les invariants — une
attente de 62,6 s sans coupure dans le vrai client, le `context` qui évite la
redécouverte, le web encadré et sourcé — et **rapporte quatre défauts
d'ergonomie** — cinq avec le mineur —, **tous corrigés depuis**, chacun avec sa
vérification.
L'essai a aussi produit une erreur de diagnostic de ma part, rectifiée au § du
défaut n° 2 : elle est conservée telle quelle, parce qu'elle est la meilleure
démonstration du défaut en question.

Ce qui n'a **pas** encore eu lieu est dit tel quel au § « Limites connues » :
aucune ligne de ce document ne décrit quelque chose qui n'existe pas.

---

## Les décisions prises avec l'auteur

Trois questions ont été posées avant d'écrire une ligne, parce que trois
réponses différentes auraient donné trois produits différents.

| Question | Réponse retenue |
|---|---|
| Quel fournisseur pour l'essai réel ? | **Venice.ai** |
| Recherche web du Researcher (point laissé ouvert, PLAN §9.3) | **Native au fournisseur**, crochets OpenAI et Gemini écrits mais non exécutés |
| Coffre système | **Multi-plateforme obligatoire**, Windows compris |

La première a eu la conséquence la plus structurante, et elle n'était pas
prévisible : **Venice expose une API compatible OpenAI**.

---

## Ce que Venice change au plan

### Un adaptateur de moins

Le plan voulait un adaptateur OpenAI et un adaptateur Gemini, pour éprouver
l'interface contre deux protocoles réellement différents. Venice parle le
protocole d'OpenAI — mêmes `messages`, mêmes `tools`, mêmes `tool_calls`, même
`finish_reason`. Ce n'est donc pas un troisième adaptateur, mais le même avec
une autre `base_url` et un objet d'extension.

D'où une distinction qui n'était pas au plan et qui porte tout le reste :

- **`kind`** dit *comment on parle* — la forme du fil, donc l'adaptateur ;
- **`preset`** dit *à qui on parle* — l'endpoint, donc les tarifs, les
  extensions disponibles et la clé de tarif.

L'intention du plan est préservée : Gemini reste la seconde forme de fil, et
c'est elle qui prouve que l'interface en est une.

### Le coût cesse d'être une promesse

Le livrable exigeait que « le coût affiché corresponde à la facture ». Avec un
tableau de tarifs maintenu à la main, c'est une promesse invérifiable : il
vieillit, et personne ne s'en aperçoit parce qu'il produit toujours un montant
plausible.

Venice renvoie **`cost.usd` sur chaque réponse**, et publie
`model_spec.pricing` sur `GET /models`. Deux conséquences :

1. On garde **deux** montants côte à côte — celui qu'on calcule et celui que le
   fournisseur annonce — et `cost_source` dit lequel est affiché. L'écart entre
   les deux est ce qui révèle une table périmée. Sans les deux, la dérive serait
   invisible ;
2. `harness pricing refresh venice` reconstruit la table depuis l'API. Un tarif
   relevé chez le fournisseur ne peut pas avoir dérivé.

Et une règle qui vaut partout : un modèle sans tarif connu rend
`cost_source: 'unknown'`, jamais `0 $`. **Zéro est un coût, pas une ignorance.**

### La recherche web, tranchée

Le point 3 du §9 du plan — « fournisseur de recherche web pour le Researcher et
son modèle de facturation » — est refermé : **recherche native du fournisseur**.

Chez Venice, c'est `venice_parameters.enable_web_search`, facturé 0,01 $ la
requête sur le même solde, avec `enable_web_citations` qui rend des citations
**structurées** (`title`, `url`, `content`, `date`). Ce dernier point n'est pas
un détail : un bloc `{title, url}` s'encadre proprement en `<untrusted_data>`,
du texte libre beaucoup moins.

Les alternatives écartées, et pourquoi : une API tierce (Brave, Tavily, Exa)
aurait coûté un compte, un secret de plus dans le coffre et une ligne de tarif
hors modèle, sans rien apporter de plus ; les recherches natives d'OpenAI et de
Gemini exigent des clés qui n'existent pas encore.

**Conséquence de conception** : `web_search` n'est **pas** un outil appelable.
C'est un drapeau de requête, pas une fonction. En faire un outil exigerait un
appel de modèle supplémentaire par recherche — payer deux fois ce que le
fournisseur fait en une. Il reste l'interrupteur du profil, et la boucle
journalise un appel `web_search` *a posteriori* dès que des citations
reviennent : observable, compté, attribué, sans surcoût.

---

## Écarts au plan, et leurs raisons

Quatre, chacun assumé et documenté sur place.

### 1. Aucun SDK de fournisseur

Le plan (§1) verrouillait `openai` et `@google/genai`. Les deux adaptateurs
tapent l'API HTTP directement.

1. On n'appelle **qu'un endpoint par fournisseur**, sans flux ;
2. il faut **contrôler le corps au champ près** — Venice refuse en 400 tout
   champ de premier niveau inconnu, et attend son extension propre ;
3. **une seule discipline HTTP** (délai, reprise, annulation, expurgation) au
   lieu de trois comportements à connaître ;
4. les SDK **bougent** : la Slice 0 avait déjà relevé que `@google/genai` ≥ 2
   change la forme des appels.

C'est le raisonnement qui avait fait préférer `node:http` à Fastify et
`node:sqlite` à `better-sqlite3`. Le prix est assumé : les erreurs de l'API,
c'est nous qui les interprétons. **Résultat : la Slice 2 n'ajoute aucune
dépendance d'exécution.**

### 2. Pas de table `usage`

Le plan (§6) la prévoyait. Le cumul vit dans `tasks.usage_json`, et son
historique dans le journal, où chaque `usage.updated` porte le cumul du moment.
Une troisième copie n'aurait ajouté qu'une cohérence de plus à tenir.

### 3. La liste blanche HTTP n'est pas le seul mode

Le plan (§5) imposait une liste blanche de domaines. Un Researcher qui ne peut
lire que des domaines prévus d'avance ne sert à rien : personne ne connaît à
l'avance l'URL de la documentation qu'il faudra consulter.

`MIDGAARD_HTTP_POLICY` propose donc trois modes — `open` (défaut), `approval`,
`allowlist` — et le défaut est **annoncé** plutôt que présenté comme une liste
blanche qui n'en serait pas une. Les adresses privées et l'IMDS restent refusées
dans les trois cas, sans dérogation possible.

### 4. Un paquet `secrets` qui n'était pas à l'arborescence

Le plan (§2) ne le prévoyait pas. Le coffre est une préoccupation séparable, qui
servira au-delà des clés de fournisseurs, et le mettre dans `providers` aurait
mêlé « parler à un modèle » et « garder un secret ».

---

## Le coffre, et ce qu'il promet vraiment

| Plateforme | Mécanisme | Protégé par l'OS | Le secret passe par |
|---|---|---|---|
| macOS | `security` — trousseau | oui | argument (voir ci-dessous) |
| Windows | PowerShell `ConvertFrom-SecureString` — DPAPI | oui | entrée standard |
| Linux | `secret-tool` — libsecret | oui | entrée standard |
| partout | repli fichier `0600` | **non** | — |

`SecretVault.osBacked` porte cette dernière colonne, et `harness doctor`
l'affiche : un repli fichier est annoncé comme tel, jamais présenté comme un
coffre.

**Aucune dépendance native**, comme `node:sqlite` en Slice 1. `keytar` aurait
demandé un binaire précompilé ou un compilateur ; le Credential Manager de
Windows sait écrire un identifiant mais **pas relire un mot de passe** —
délibérément — et le module PowerShell qui le permettrait n'est pas installé
d'office.

**Limite assumée** : `security add-generic-password` n'accepte le mot de passe
qu'en argument ; il est donc visible dans `ps` pour les processus du **même**
utilisateur, le temps de l'écriture. Ceux-là peuvent de toute façon lire le
jeton du daemon dans `~/.midgaard/daemon.json`, ce qui est déjà hors du modèle
de menace. La lecture, elle, n'expose rien.

---

## Trois bogues que seule l'exécution a révélés

Aucun des trois ne se voyait à la lecture. Tous les trois ont été trouvés en
faisant tourner le code, et chacun a donné un test.

### 1. Le trousseau macOS rend l'hexadécimal sans le dire

`security find-generic-password -w` rend le mot de passe **en hexadécimal** —
sans préfixe, sans signalement — dès qu'il contient un octet non imprimable en
ASCII. Un aller-retour naïf rendait `736b2d…` au lieu de la clé, et corrompait
silencieusement toute clé non anglaise.

Deviner à la relecture est impossible : `abcdef` est un mot de passe valide
**et** de l'hexadécimal valide. L'ambiguïté est donc supprimée à l'écriture, en
ne déposant que de l'ASCII imprimable (`mg1:` + base64).

### 2. L'expurgation ne masquait pas les jetons porteurs

La fonction de remplacement prenait l'argument `string` de `String.replace` —
le **texte entier** — pour un groupe de capture, et cherchait donc tout le
document à l'intérieur du seul motif trouvé. Le motif `Bearer` ne remplaçait
rien. Second défaut au même endroit : une longueur fixe sur les clés Google
laissait en clair la **queue** d'une clé plus longue, c'est-à-dire exactement ce
qu'il ne faut pas laisser.

### 3. Une racine de projet sous un lien symbolique rejetait ses propres fichiers

La vérification de chemin compare un chemin réel à la racine autorisée. Si la
racine n'est pas canonicalisée, un projet situé sous un lien symbolique — ce
qu'est `/tmp` sur macOS, et ce que sont bien des dossiers personnels — voit
chacune de ses lectures refusée « hors du projet », pour des fichiers qui en font
partie. La racine est désormais canonicalisée dans la boucle, une fois.

---

## Et un quatrième, trouvé en éprouvant le chemin complet

Celui-là est le plus intéressant, parce qu'il a été trouvé **en testant avec une
fausse clé** — un test qui aurait pu passer pour superflu.

Le « Test connection » annonçait **« joignable »** avec une clé bidon. Vérifié
ensuite à la main contre la vraie API : `GET /api/v1/models` de Venice répond
`200` **sans aucun en-tête d'autorisation**. Le test ne prouvait donc rien de la
clé, et l'utilisateur ne l'aurait découvert qu'à sa première délégation, loin de
la cause.

C'est le défaut n° 1 de la Slice 0 sous une autre forme : **affirmer que quelque
chose marche sans l'avoir constaté.**

Correction : une sonde **authentifiée** par préréglage.
`GET /api_keys/rate_limits` rend `401 Authentication failed` sur une clé
invalide (mesuré), et donne le solde au passage — une tâche qui échouerait en
`402 INSUFFICIENT_BALANCE` vaut mieux d'être annoncée au test que découverte au
milieu d'une délégation. Chez OpenAI, `/models` exige déjà la clé : aucune sonde
supplémentaire. Toujours aucun jeton facturé par un test.

---

## Ce qui est prouvé

| Suite | Contenu | Résultat |
|---|---|---|
| `npm run test:unit` | 133 tests : machine à états, persistance, configuration, **normalisation des deux adaptateurs**, **coûts**, **sécurité des outils**, **boucle d'agent**, **formatage des montants** | 133/133, ~1 s |
| `npm run test:lock` | 8 daemons lancés ensemble, 10 manches | 10/10, ~30 s |
| `npm run test:restart` | 7 scénarios sur de vrais processus et de vraies sockets | 7/7, ~45 s |
| `npm run test:wait` | 12 scénarios de bout en bout, client MCP officiel | 12/12, ~178 s |
| `npm run test:live` | 5 scénarios **contre la vraie API Venice** — opt-in, s'abstient sans clé | 5/5, ~3 min, **0,0033 $** |

### Ce que les nouveaux tests verrouillent

**Le budget arrête la tâche avant l'appel de trop.** Trois appels à 0,40 $ sous
un budget de 1 $ : on vérifie qu'il n'y a **pas de quatrième appel**, et que le
statut est `budget_exceeded` et non `failed`. Sans faux fournisseur, ce test
coûterait de l'argent à chaque exécution ; avec, il tourne en millisecondes.

**La sécurité des chemins.** Remontée par `..`, lien symbolique sortant, chemin
absolu hors racine, lien de dossier sortant pendant une recherche — tous
refusés. Et le refus ne révèle pas où menait le lien.

**La revérification à chaque saut de redirection**, testée comme **invariant**
plutôt que par son effet : une suite hors ligne ne peut pas partir d'un vrai
hôte public, et constater un refus au premier saut ne prouverait rien sur les
suivants. La garde est donc injectée et l'on vérifie qu'elle est appelée pour
les deux hôtes, dans l'ordre. C'est la consigne de `CLAUDE.md` — tester les
invariants directement, pas leurs effets visibles.

**Le piège de coût de Gemini** : `thoughtsTokenCount` n'est pas compris dans
`candidatesTokenCount` alors que Google le facture au tarif de sortie.
Additionner naïvement sous-estime la facture d'un modèle de raisonnement.

**La dégradation de la provenance d'un coût** : un total qui mélange un appel
facturé et un appel estimé n'est pas une facture ; un seul tarif manquant rend
le total inconnu, et non partiellement juste.

---

## Essai réel

**Date :** 2026-10-29 · **Fournisseur :** Venice.ai · **Modèle :**
`deepseek-v4-flash-0731` (0,13 / 0,26 $ le million de jetons).

Une suite dédiée, **opt-in**, le rejoue : `npm run test:live`. Elle ne tourne
que si une clé est déjà déposée dans le coffre, et **s'abstient** sinon — une
absence de clé n'est pas un défaut du code. Elle est séparée de `npm test`
parce qu'elle ne peut être ni gratuite, ni hors ligne, ni tout à fait
reproductible, alors que les autres doivent être les trois.

| # | Scénario | Résultat |
|---|---|---|
| L1 | Le Researcher est annoncé disponible, et il l'est | 6 outils, clé acceptée, 141 modèles |
| L2 | Une vraie tâche aboutit à un résultat structuré | 2 appels modèle, 0,001699 $ |
| L3 | **Le coût affiché correspond au solde débité** | 0,003307 $ comptés, 0,003307 $ débités — **0,0 % d'écart** |
| L4 | Un budget volontairement bas arrête la tâche | `budget_exceeded` après **1 seul** appel modèle |
| L5 | Ce qui revient du web remonte encadré, avec ses sources | 2 sources, encadrement `<untrusted_data nonce=…>` présent |

### Le livrable, mesuré deux fois

Le solde Venice est relevé **chez le fournisseur** avant et après, et comparé à
ce que le harness a compté. C'est la seule vérification qui vaille : un tableau
de tarifs peut mentir, un solde non.

| | Compté par le harness | Débité par Venice | Écart |
|---|---|---|---|
| Suite `test:live`, 3 tâches | 0,003307 $ | 0,003307 $ | **0,0 %** |
| Tâche isolée, dossier runtime réel | 0,002412 $ | 0,002412 $ | **0,0 %** |

Exact au microdollar, deux fois. C'est possible parce que Venice annonce
`cost.usd` sur chaque réponse et qu'on retient **son** chiffre : on ne calcule
pas la facture, on la recopie.

Une **troisième** mesure, prise dans les mêmes conditions pendant l'essai en
vraie session, donne le même résultat : 0,00075362 $ débités pour 0,00075362 $
comptés.

### Ce qu'une vraie tâche donne

La tâche jouée dans le dossier runtime réel, pour qu'elle soit consultable dans
le dashboard :

> *Quels invariants le dépôt Midgaard déclare-t-il « à ne pas casser », et lequel
> a été appris en mesurant une coupure de client MCP à 60 secondes ?*

```text
statut       completed · 54,9 s · 2 appels modèle
jetons       18 002 entrée (dont 4 864 de cache) · 2 184 sortie (dont 707 de raisonnement)
coût         0,002412 $ — facturé par le fournisseur

étape 1   read_file   CLAUDE.md         8 ms   10 875 octets
étape 1   read_file   docs/SLICE0.md    1 ms   16 342 octets
étape 1   read_file   docs/SLICE1.md    1 ms   14 813 octets
étape 2   submit_result                        confiance : high
```

Réponse rendue : « Le dépôt déclare 19 invariants « à ne pas casser » dans
`CLAUDE.md` ; celui appris en mesurant une coupure de client MCP à 60 secondes
est « Notifications de progression pendant toute attente longue ». » — exact.

Trois choses se lisent dans ces quatre lignes :

1. **Le contexte fourni par Claude fait son travail.** L'agent n'a pas exploré
   le dépôt : il a lu les trois fichiers qu'on lui avait nommés, et rien d'autre.
   Deux appels modèle au total. C'est précisément l'économie que le §4 du plan
   visait — sans elle, déléguer coûte plus cher que faire soi-même.
2. **Les appels d'outils partent en parallèle**, trois d'un coup à la même
   itération, comme la limite `max_tool_calls_per_step` l'autorise.
3. **La fin est un acte** : `submit_result` à l'étape 2, pas une interprétation
   de texte libre.

### L'estimation locale est systématiquement haute, et on sait pourquoi

Sur cette tâche : **0,002908 $ estimés** contre **0,002412 $ facturés**, soit
+20,6 %. Ce n'est pas du bruit, c'est le cache.

Venice sert 4 864 des 18 002 jetons d'entrée depuis son cache, à tarif réduit —
mais `GET /models` **ne publie pas** ce tarif réduit, et la documentation des
prix l'omet également. Notre table facture donc les jetons de cache au tarif
plein, faute de mieux. Inventer un rabais plausible serait pire : le chiffre
retenu reste celui du fournisseur, et l'estimation ne sert que de témoin.

**C'est exactement ce que les deux montants côte à côte servent à révéler.**
Sans eux, l'écart serait invisible — et sur un fournisseur qui n'annonce aucun
coût (OpenAI, Gemini), c'est l'estimation haute qui serait affichée comme une
facture.

### Deux bogues du test, pas du produit

Le premier essai a donné 2 échecs sur 5. Les deux venaient de la suite :

1. **Une attente de 60 s tombe pile sur la coupure du client.** Le client du SDK
   n'envoie aucun jeton de progression, donc le serveur ne peut pas le tenir
   éveillé — c'est précisément ce que mesure le scénario S5 de `test:wait`, et
   la suite réelle est tombée dedans. Ramené à 25 s par tranche. Claude, lui,
   fournit un jeton et peut demander 300 s sans risque.
2. **Cumuler le coût scénario par scénario était faux.** Une tâche dont
   l'attente échoue **continue de tourner** côté daemon, et de dépenser. Son
   coût manquait au total, et l'écart de 47,6 % accusait le comptage pour une
   erreur du test. Le total vient désormais du registre du daemon, qui est de
   toute façon la source de vérité.

Le second est intéressant au-delà du test : il rappelle qu'**interrompre une
attente n'arrête pas une tâche** — ce que le scénario S4 garantit depuis la
Slice 0, et qu'il faut avoir en tête quand on compte de l'argent.

### Un défaut d'affichage, corrigé au passage

`budget de 0,0000 $ atteint` pour un budget de 0,000001 $ : quatre décimales
effaçaient un montant non nul, et le message ressemblait à un bogue. Le
formatage descend maintenant jusqu'à huit décimales quand il le faut.

### Ce que cet essai ne pouvait pas dire

Cet essai emploie le **client officiel du SDK**, le même protocole que Claude
Code, dans de vrais processus. Il ne remplace pas un essai dans une vraie
session : le client du SDK n'a ni les mêmes délais ni les mêmes habitudes, et
c'est ce constat qui a produit les deux défauts majeurs des Slices 0 et 1.

Les quatre questions qu'il laissait ouvertes — `context` spontané,
`harness_list_agents` avant la délégation, limites abaissées d'office, effet de
l'encadrement `<untrusted_data>` sur le rapport — ont été posées à une vraie
session le jour même : voir **[Essai en vraie session Claude Code](#essai-en-vraie-session-claude-code)**
ci-dessous, qui y répond et rapporte quatre défauts d'ergonomie.

---

## Essai en vraie session Claude Code

**Date :** 2026-10-29 · **Client :** `claude-code` **2.1.309**, app desktop ·
**Modèle orchestrateur :** Claude Opus 5 · **Coût total de l'essai :** 0,020434 $.
Sources : `~/.midgaard/mcp-trace.jsonl`, la base, et le dashboard.

C'est l'essai que le § « Ce que cet essai ne pouvait pas dire » appelait : non
plus le client
officiel du SDK, mais Claude Code lui-même, avec ses délais et ses habitudes.
**Il a trouvé quatre défauts d'ergonomie**, dont un faux négatif d'outil et un
message d'erreur qui envoie vers un réglage hors d'atteinte. Aucun n'était
visible depuis le client du SDK, parce qu'aucun ne se déclenche sans un modèle
qui se trompe de bonne foi.

### Chronologie (UTC)

| Heure | Événement |
|---|---|
| 06:24:44 | Ouverture de session ; capacités du client enregistrées — `elicitation`, `roots`, `extensions`, `supports_native_tasks: false` |
| 06:25:4x | `harness_list_agents` appelé **avant** toute délégation ; `simulated` et `researcher` annoncés actifs |
| 06:25:52 | Délégation n° 1 au `researcher`, `max_cost_usd` 0,02 **et `max_steps` 6 de ma propre initiative** |
| 06:25:58 | Attente n° 1, `timeout_s` **180 choisi par Claude** |
| 06:27:00 | **Échec** : 62,57 s d'attente, 4 notifications, aucune coupure. L'agent a épuisé les 6 étapes sans `submit_result` — **0,006264 $ pour rien** |
| 06:28:46 | Délégation n° 1 bis : plafond d'étapes retiré, et mise en garde sur `search_files` ajoutée au `context` |
| 06:29:09 | Résultat en **2 appels modèle**, 20,76 s, 1 notification, 0,001785 $ — réponse vérifiée exacte contre le code |
| 06:30:03 | Délégation n° 2, question exigeant le web, `max_cost_usd` 0,05 (choisi pour couvrir les 0,01 $ de la recherche) |
| 06:30:47 | Résultat avec **7 citations** et encadrement `<untrusted_data nonce="d83616a7…">`, 40,88 s, 2 notifications, 0,011632 $ |
| 06:32:03 | Tâche `simulated` de 25 s, gratuite, pour voir le dashboard bouger sans payer |
| 06:33:30 | Mesure propre solde avant / après sur une tâche de 0,00075362 $ |

### Ce qui est confirmé

| Question | Réponse |
|---|---|
| L'attente tient-elle au-delà de 60 s **dans le vrai client** ? | **Oui** : 62,57 s en un seul appel, 4 notifications, aucune coupure. C'est la première mesure de cet invariant hors du client du SDK |
| Claude appelle-t-il `harness_list_agents` avant de déléguer ? | **Oui**, systématiquement — mais voir la réserve ci-dessous : le mérite en revient au serveur |
| Le `context` évite-t-il la redécouverte ? | **Oui, et c'est mesurable** : 3 `read_file` sur les 3 fichiers nommés, **zéro** lecture de `CLAUDE.md` ou de `docs/SLICE2.md`, dont le contenu utile était passé en `context` |
| Claude suit-il `next_action` ? | **Oui** : une attente par délégation, jamais de sondage par `harness_get_task_status` |
| Le coût affiché est-il la facture ? | **Oui, remesuré ici** : 0,00075362 $ débités chez Venice, **0,00075362 $ comptés** — 0,0 % d'écart, une troisième fois |
| Le web revient-il encadré et sourcé ? | **Oui** : `<untrusted_data nonce=…>` avec préambule, 7 citations `{title, url}`, et un `note` qui redit la consigne |
| `roots` sert-elle vraiment ? | **Oui** : le dashboard affiche « Racine de lecture : /Users/andydodakal/Documents/Midgaard », que le client a déclarée |
| Le dashboard bouge-t-il en direct ? | **Oui** : étape 1/5 → 2/5 → 4/5 sans rechargement, par WebSocket ; coûts, 9 appels d'outils avec leurs arguments, et sources s'affichent |
| Les « Tasks » MCP natives sont-elles rouvertes ? | **Non** : `supports_native_tasks: false` en 2.1.309, inchangé. `harness_wait_for_task` reste nécessaire |

### Ce qui n'est pas confirmé

| | |
|---|---|
| Que Claude appelle `harness_list_agents` **spontanément** | Les `instructions` du serveur le lui ordonnent en toutes lettres, et la description de `harness_delegate_task` le répète. L'essai prouve que la consigne est suivie, pas qu'elle serait superflue |
| Que Claude passe un `context` utile **de lui-même** | Même réserve : la consigne est explicite aux deux endroits. Ce que l'essai prouve, c'est que la consigne **fonctionne** — ce qui est la question utile, puisque la consigne, elle, est acquise |
| Qu'un plafond d'étapes bas soit sans danger | Démenti : voir le défaut n° 2 |
| Le comportement sous approbation humaine | Non exercé ici : aucun outil du `researcher` ne demande d'approbation. C'était l'objet de l'essai de la Slice 1 |

### Ce que l'encadrement `<untrusted_data>` a changé

**Il a changé le rapport, et de façon vérifiable.** La réponse web tranchait une
dette ouverte de cette slice — le grounding `google_search` de Gemini — et la
tentation était de l'inscrire ici comme un fait établi. L'encadrement l'a
interdit : ce qui remonte est **ce qu'un agent a lu sur des pages**, pas ce que
le dépôt a constaté. La dette n° 2 est donc mise à jour plus bas en **attribuant
la source**, et elle reste ouverte jusqu'à un appel réel.

Le préambule porte aussi l'instruction de ne pas obéir au contenu encadré. Rien
dans ce que l'agent a rapporté n'essayait de donner un ordre, donc cette
protection-là n'a pas été éprouvée ; seule l'attribution l'a été.

### Les quatre défauts d'ergonomie

Les quatre sont corrigés, le cinquième aussi, et chaque correctif est vérifié là
où le défaut se voyait — dans le dashboard servi, dans la réponse MCP — pas
seulement dans un test.

#### 1. `search_files` répond « 0 correspondance » au lieu d'une erreur

Le plus grave, parce que c'est un **faux négatif qui a l'air d'une vraie
réponse**. L'agent a cherché `checkLimits` en passant un **fichier** dans `path` :

```text
search_files {"pattern":"checkLimits","path":"packages/agent-runtime/src/loop.ts"}
  -> succeeded | 0 correspondance(s) dans 0 fichier(s)
```

`checkLimits` existe pourtant à `loop.ts:186` et `budget.ts:43`. Le schéma dit
bien « Directory to search in » — l'agent a mal employé l'outil. Mais l'outil
répond à un mauvais emploi par un chiffre faux et confiant, au lieu d'une
erreur. Cause exacte : `packages/tools/src/fs.ts:164` fait
`readdir(dir).catch(() => [])` ; sur un fichier, `readdir` lève `ENOTDIR`
(reproduit directement), le `catch` l'avale, la marche est vide et le résultat
devient « (aucune correspondance) » — indistinguable d'une vraie absence.

L'agent a cru la réponse, a reformulé quatre fois, et a brûlé son budget
d'étapes. **C'est la cause première de l'échec de la délégation n° 1.** Un
`ENOTDIR` remonté en `ToolError` l'aurait corrigé au premier essai.

Seconde lecture possible : le résumé « 0 correspondance(s) dans **0** fichier(s) »
disait la vérité — zéro fichier parcouru — mais personne ne lit « 0 fichier »
comme « ton chemin n'est pas un répertoire ».

**Corrigé.** `search_files` vérifie désormais que la racine de la recherche est
un répertoire et refuse sinon, en disant quoi faire :

```text
search_files searches a directory, and "packages/agent-runtime/src/loop.ts" is
not one. Search "packages/agent-runtime/src" instead and narrow with glob, or
read the file with read_file.
```

L'appel exact qui avait menti pendant l'essai a été rejoué contre le dépôt :
il refuse, et le répertoire qu'il propose rend les 5 occurrences réelles de
`checkLimits`, `loop.ts:186` comprise. La tolérance reste où elle a un sens —
un sous-dossier illisible n'interrompt toujours pas une recherche.

Un refus ne coûte pas la tâche, et c'est ce qui rend le correctif sûr : la
boucle rattrape une `ToolError` et la rend au modèle en `Failed: …`
(`loop.ts:463-468`), en la journalisant comme appel échoué. Le modèle lit donc
le message, apprend qu'il s'est trompé de forme, et corrige au tour suivant —
là où il croyait auparavant un zéro et s'entêtait. Échanger un faux négatif
contre une erreur dure aurait été un mauvais marché ; ce n'est pas ce qui se
passe.

Deux tests le verrouillent, et le second compte autant que le premier : il
vérifie que le motif **existe** quand on cherche comme il faut. Sans lui, le
test du refus passerait aussi pour un motif simplement absent. Retirer la garde
fait bien échouer le premier et seulement lui — vérifié.

#### 2. Le motif d'échec ne nomme pas la cause, et le conseil vise un réglage hors d'atteinte

La délégation n° 1 a rendu ceci :

```text
status  failed · step 6/5
error   l'agent s'est arrêté sans appeler submit_result, même après relance
        — aucun résultat structuré à remonter
hint    The task ended without a result. Do not retry automatically; tell the user.
```

Ce message dit un **symptôme**. En le lisant, j'ai conclu que la cause était
**le `max_steps: 6` que j'avais posé moi-même**, et je l'ai écrit tel quel dans
la première version de ce document.

**C'était faux**, et il a fallu ouvrir la boucle pour le voir. La tâche n'a
jamais atteint la garde d'étapes : celle-ci aurait rendu « limite de 6 étapes
atteinte sans résultat soumis ». Le vrai enchaînement est ailleurs —
`loop.ts` échoue quand **deux** réponses d'affilée n'appellent aucun outil, et
la seconde avait été **coupée au plafond de sortie** avant d'avoir pu émettre
`submit_result`. Relever `max_steps` n'y aurait rien changé : la même
troncature serait survenue au même tour. Ce qui a sauvé la reprise, c'est
d'avoir demandé **une réponse plus courte**.

Le seul indice de la vraie cause vivait dans une note d'exécution, visible
seulement dans le dashboard ou la base :

> `réponse coupée à 4096 jetons de sortie ; relève max_output_tokens si cela se répète`

Or `max_output_tokens` **n'est pas un paramètre de `harness_delegate_task`** —
le schéma n'expose que `max_cost_usd`, `max_steps` et `timeout_s`. Et même
exposé, `tightenLimits` (`packages/contracts/src/agent.ts:105`) ne sait
qu'**abaisser** : « relever » est impossible par construction depuis une
délégation. Le conseil s'adressait donc à qui édite
`packages/daemon/src/agents.ts`, pas à qui lit le message.

**C'est le défaut le mieux démontré des quatre**, parce que la démonstration est
l'erreur elle-même : le lecteur à qui ce message est destiné l'a mal diagnostiqué,
et a publié le mauvais diagnostic. Un message qui ne nomme que le symptôme ne
laisse pas son lecteur sans réponse — il lui en fait inventer une.

À noter au crédit du harness : **`hint` dit explicitement de ne pas réessayer
tout seul et de prévenir l'utilisateur.** C'est exactement la bonne consigne, et
elle m'a retenu de relancer en boucle une tâche qui coûtait de l'argent.

**Corrigé.** La boucle distingue désormais les deux pannes, qui se corrigent à
l'opposé l'une de l'autre :

```text
réponse coupée à 4096 jetons de sortie avant tout appel d'outil (1 fois, relance
comprise) : submit_result n'a jamais pu être émis. L'objectif demande une réponse
trop longue — demande-la plus courte. Ce plafond appartient au profil de l'agent :
une délégation ne peut que l'abaisser, jamais le relever.
```

Quand il n'y a pas eu de troncature, le message reste le sien et gagne sa
sortie : *reformule l'objectif pour qu'il appelle une réponse structurée*. La
note de troncature ne renvoie plus vers `max_output_tokens` mais vers l'objectif,
et la garde d'étapes nomme maintenant ses deux issues — *relève `max_steps`
jusqu'au plafond du profil, ou simplifie l'objectif* —, toutes deux atteignables
depuis une délégation.

Trois tests le verrouillent, dont un qui vérifie que le message **n'invente pas**
une troncature là où il n'y en a pas eu.

#### 3. `step` affiche un dénominateur qui ne veut rien dire pour un agent réel

`step: "6/5"` pour une tâche plafonnée à **6** étapes ; `"2/5"` et `"1/5"` pour
des tâches plafonnées à **12**. Le dénominateur est `steps_total`, que
`packages/daemon/src/task-manager.ts:195` remplit avec la constante
`STEPS_TOTAL` **de l'exécutant simulé**, pour toutes les tâches. La vraie limite
est `max_steps`, qui vit dans `limits_json`.

Le défaut traverse les trois interfaces : MCP (`packages/mcp-server/src/server.ts:217`),
CLI (`packages/cli/src/commands.ts:145`) et dashboard (« étape 6 sur 5 »). Il
est cosmétique, mais il ment au seul endroit où l'on cherche à savoir si une
tâche a touché son plafond — et « 6/5 » m'a d'abord fait croire à un dépassement
d'un cran, pas à ma propre limite atteinte.

**Corrigé** à la source : `steps_total` vaut désormais `max_steps` pour un agent
réel, et ne garde la constante du simulé que pour l'exécutant simulé, dont les
étapes sont comptées d'avance et font partie de son rythme. Les trois interfaces
sont réparées d'un coup, puisqu'elles lisent toutes le même champ.

Vérifié de bout en bout sur le vrai système plutôt que supposé : une tâche réelle
plafonnée à 4 étapes rend `2/4` (elle rendait `2/5`), et une tâche simulée rend
toujours `5/5`. Les tâches déjà en base gardent leur ancien dénominateur : c'est
ce qu'elles valaient au moment où elles ont tourné.

#### 4. L'écart de coût accuse la table de tarifs quand la cause est le cache

Sur la tâche échouée, le dashboard affiche :

> Notre estimation : 0,0098 $. **Écart de 36 % : les tarifs locaux ont probablement vieilli.**

C'est faux, et cette slice le sait déjà : la tâche a lu **34,8 k jetons de cache
sur 58,3 k d'entrée**, et le § « L'estimation locale est systématiquement haute »
explique que Venice ne publie pas son tarif de cache. La table n'a pas vieilli —
elle a été relevée chez le fournisseur le jour même. Le message envoie vers
`harness pricing refresh venice`, qui ne changerait rien.

`apps/dashboard/src/components/UsageCard.tsx:97` ne connaît qu'une cause
possible à un écart. Il en existe une seconde, documentée, et que le nombre de
jetons de cache suffirait à distinguer.

**Corrigé.** `gap()` reçoit les jetons de cache et attribue l'écart. La même
tâche affiche maintenant :

> Notre estimation : 0,0098 $. **Écart de 36 % : 60 % des jetons d'entrée
> viennent du cache, que nous facturons au tarif plein faute de tarif publié.
> L'estimation est haute pour cette raison, pas parce que les tarifs auraient
> vieilli.**

L'attribution n'est pas accordée à la légère : le cache ne peut rendre
l'estimation que **haute**, jamais basse. Si la facture dépasse l'estimation, la
table reste la seule explication et le message d'origine revient. Relevé dans le
dashboard servi par le daemon, pas seulement dans le code.

#### Et un cinquième, mineur, dans le même esprit

`formatCost` (`apps/dashboard/src/lib/utils.ts:54`) passe à **deux** décimales
au-dessus de 0,01 $. La tâche web facturée 0,011632 $ et estimée 0,011763 $
s'affiche donc « 0,01 $ » **des deux côtés**. La phrase « Les deux concordent »
reste exacte — elle compare les vraies valeurs avec un seuil de 20 % — mais les
deux chiffres dont tout le § « Le coût cesse d'être une promesse » dit qu'ils
n'ont de valeur **que côte à côte** deviennent identiques à l'œil, pile dans la
tranche où vit une vraie tâche. C'est le défaut « budget de 0,0000 $ » déjà
corrigé plus haut, à l'autre bout de l'échelle.

**Corrigé.** Le nombre de décimales suit l'ordre de grandeur : deux au-dessus du
dollar, **quatre** en dessous — l'échelle d'une tâche d'agent —, et jusqu'à huit
plus bas encore. Les zéros inutiles tombent, mais jamais sous deux décimales :
un budget reste « 0,50 $ », qui se lit comme de l'argent, et non « 0,5 $ ».

La même tâche affiche désormais **0,0116 $** facturés contre **0,0118 $**
estimés. « Les deux concordent » reste vrai, et devient enfin vérifiable à
l'œil : le lecteur voit *de combien* ils concordent.

Ce défaut a valu au dashboard son **premier test**. Il ne touche qu'aux
fonctions pures de `src/lib/utils.ts` — aucun rendu, aucun DOM —, et le projet
TypeScript des tests a dû être élargi d'un cran pour les atteindre, le dashboard
ayant sa propre configuration et n'appartenant pas à la solution `tsc -b`. Le
test Playwright de l'interface reste porté en Slice 3 ; celui-ci ne le remplace
pas, il couvre la seule logique qui ne demande pas de navigateur.

### Ce que l'essai apprend sur le comportement de Claude

**Le `context` fonctionne, et son effet se mesure.** Les deux délégations sur le
dépôt ont lu exactement les fichiers nommés, et rien d'autre. Mieux : la seconde
portait un **avertissement sur un outil** — « `search_files` n'accepte qu'un
répertoire » — et l'agent a cessé de s'y casser les dents. Le `context` ne sert
donc pas qu'à transmettre des faits : il transmet aussi les pièges connus.

**Ce que j'ai cru coûteux ne l'était pas, et je ne l'ai su qu'en ouvrant la
boucle.** J'ai abaissé `max_cost_usd` parce qu'on me l'avait demandé, et
`max_steps: 6` de ma propre initiative, sur le raisonnement « une lecture de
trois fichiers tient en six étapes ». Quand la tâche a échoué, j'ai imputé
l'échec à ce plafond — c'était le chiffre que j'avais choisi, et le message
d'erreur ne proposait rien d'autre à regarder.

**La tâche n'a jamais atteint ce plafond.** Elle a échoué sur deux réponses
tronquées d'affilée, et un `max_steps` plus large aurait donné le même échec au
même tour. Mon initiative n'a rien coûté ; c'est mon diagnostic qui était faux.

La leçon n'est donc pas « ne touche pas aux limites », mais plus désagréable :
**un message qui ne nomme qu'un symptôme oriente son lecteur vers le chiffre
qu'il a sous la main**, et ce chiffre est rarement la cause. J'avais le dashboard,
la base, et le code — j'ai quand même conclu de travers, et publié la conclusion.
Un utilisateur qui n'a que le message n'avait aucune chance. C'est pour cela que
le défaut n° 2 valait d'être corrigé à la source plutôt que signalé.

Ce qui reste vrai de l'épisode : la tâche échouée a coûté **0,006264 $ pour rien**,
soit plus de trois fois une tâche qui aboutit. Une tâche qui échoue a déjà dépensé.

**Le délai, lui, se choisit sans risque.** 180 s, 180 s, 240 s, 120 s selon ce
que j'attendais — jamais la valeur par défaut sans y penser, et jamais de
coupure. Interrompre une attente n'arrête pas la tâche : le coût est donc nul.

### Conséquence pour les dettes de la Slice 3

La délégation n° 2 a rapporté, **sur la foi de pages web citées et non d'un
appel réel**, que la documentation de Google énonce que `googleSearch` ne peut
pas être combiné avec des `functionDeclarations` dans la même requête
`generateContent`, et que l'« Interactions API » est recommandée pour les
nouveaux développements tandis que `generateContent`, étiqueté *legacy*, reste
recommandé pour la production stable.

Si cela se confirme, la dette n° 2 (« rouvrir le grounding ») ne se règle pas
par un essai mais par un **choix d'architecture** : deux appels, ou l'Interactions
API. Elle reste ouverte — rien ici n'a été constaté contre l'API réelle, et
c'est précisément la discipline que l'encadrement `<untrusted_data>` impose.

---

## Limites connues

- ~~**Le dashboard n'a qu'un test, et il ne rend rien.**~~ **Réglé** le
  2026-10-29 : `npm run test:ui`, 7 scénarios dans un vrai navigateur. Voir
  § « Les dettes, soldées ».
- **L'approbation humaine n'a pas été rejouée en Slice 2** *par un agent réel*.
  Aucun outil du `researcher` n'en demande — c'est en lecture seule. Le chemin
  lui-même l'est désormais : le scénario D4 de `test:ui` clique « Approuver »
  dans le dashboard et constate la tâche repartir. Ce qui reste à faire en
  Slice 3, c'est qu'un agent **écrivant** la déclenche.
- **L'estimation locale est haute de ~20 % sur un modèle qui sert du cache**,
  parce que Venice ne publie pas son tarif de cache. Sans conséquence tant que
  le fournisseur annonce son propre coût ; à garder en tête pour OpenAI et
  Gemini, qui ne l'annoncent pas.
- **L'adaptateur Gemini n'a jamais été exécuté contre l'API réelle.** Écrit
  d'après la documentation REST, vérifié sur réponses enregistrées. À
  reconfirmer avec une clé. Au passage, la documentation de Google recommande
  désormais une « Interactions API » pour les nouveaux projets et qualifie
  `generateContent` de *legacy* tout en le maintenant : à réévaluer en même temps.
- **Le grounding `google_search` de Gemini n'est pas activé.** Il partage le
  tableau `tools` avec les `functionDeclarations`. Le Researcher a besoin de ses
  fonctions — sans `submit_result`, aucune tâche ne peut finir. Le crochet est
  écrit, il n'est pas franchi. **Une recherche web déléguée le 2026-10-29
  rapporte, sur la foi de pages de documentation Google citées, que les deux ne
  peuvent pas cohabiter dans une même requête `generateContent`** — ce qui
  changerait la dette d'un essai en un choix d'architecture (deux appels, ou
  l'« Interactions API »). Rien n'a été constaté contre l'API réelle : c'est
  un rapport encadré en `<untrusted_data>`, pas une mesure, et la dette reste
  ouverte.
- ~~**Windows et Linux ne sont pas vérifiés automatiquement** pour le coffre.~~
  **Réglé et constaté** le 2026-10-29, passage `40937579307` : quatre postes au
  vert. La phrase barrée était même trop indulgente — le coffre n'avait **aucun**
  test, pas même le repli. Voir § « Les dettes, soldées », qui raconte les cinq
  pannes qu'il a fallu cinq passages pour trouver.
- **La sonde de libsecret ne distingue pas un service sans collection.**
  `secret-tool lookup` réussit là où tout `store` échoue : elle prouve que le
  service répond, pas qu'il a où ranger. La combler demanderait d'écrire un
  secret d'essai à chaque démarrage. Constaté en CI, assumé.
- **Le DNS rebinding reste théoriquement possible** sur `http_fetch` : on vérifie
  toutes les adresses résolues, puis `fetch` résout une seconde fois.
- **`pricing.json` livré ne contient que des tarifs Venice**, relevés à la main
  le 2026-10-29. OpenAI et Gemini en sont **volontairement absents** : inventer
  un tarif serait pire que de l'ignorer, et le harness affiche alors « tarif
  inconnu ». `harness pricing refresh venice` remplace le relevé manuel.
- **Pas de projets, pas de worktrees, pas d'écriture.** C'est la Slice 3.

---

## Ce qui attend la Slice 3

Le plan prévoyait déjà `workspace`, les outils d'écriture et l'UI d'approbation
bloquante. S'y ajoutaient cinq dettes nées de cette slice. **Trois sont soldées**
le 2026-10-29 — le § suivant raconte ce qu'elles ont révélé — et **deux restent
ouvertes**, toutes deux faute de clé Google :

1. **Éprouver Gemini contre l'API réelle**, et trancher `generateContent` contre
   l'Interactions API.
2. **Rouvrir le grounding `google_search`** une fois une clé disponible. La
   question a changé de nature : une recherche web rapporte que la documentation
   de Google **interdit** la cohabitation avec les `functionDeclarations` (voir
   § « Limites connues »). À confirmer par un appel réel, puis à trancher — deux
   appels, ou l'Interactions API.

Elles ne sont pas commencées, et c'est volontaire : écrire un adaptateur contre
une documentation est précisément ce qui a produit les deux pannes du coffre
racontées plus bas. Ce qui manque ici n'est pas du code, c'est une clé.

---

## Les dettes, soldées — 2026-10-29

Trois dettes fermées, et **sept pannes réelles** trouvées en les fermant — plus
deux messages qui n'en étaient pas. Cinq des sept ne se voyaient que sur une
plateforme ou dans un navigateur : rien ne les aurait montrées depuis ce Mac. La
leçon est la même pour les trois, et elle est désagréable : *du code écrit
d'après une documentation, relu et plausible, ne vaut rien tant qu'il n'a pas
tourné.* Les sept vivaient dans du code qu'on aurait signé sans hésiter.

### Dette n° 3 — le coffre, sur les trois plateformes

La Slice 2 disait « DPAPI et libsecret sont écrits, pas constatés ». C'était
encore optimiste : **le coffre n'avait aucun test**, pas même le repli fichier.
Toutes les suites posent `MIDGAARD_VAULT=file` — à raison, puisqu'un coffre
système est par utilisateur et qu'écrire `provider.venice` depuis un test
écraserait la vraie clé — et le trousseau n'était donc jamais touché.

`tests/unit/secrets.test.ts` passe la même batterie au coffre **réel de la
machine** et au repli : aller-retour, secret non-ASCII, remplacement,
suppression, absence, et deux références qui ne se mélangent pas. Elle ne
connaît aucun coffre en particulier ; elle ne parle qu'à `SecretVault`.
L'isolation se fait par la référence : un préfixe `test.conformance.<pid>.<aléa>`
tiré à chaque exécution, et supprimé même quand un cas échoue.

**Écrire la batterie a suffi à trouver deux pannes, avant son premier lancement.**

- **DPAPI rangeait toutes les références dans un seul fichier.** La référence
  voyageait par `process.env` ; or `run()` reconstruit l'environnement du fils à
  partir d'une liste blanche où elle ne figurait pas. Le script PowerShell lisait
  `$null`, et `Join-Path $dir ($null + '.dpapi')` désignait toujours la même
  cible. Sous Windows, **chaque clé déposée écrasait la précédente, et toute
  relecture rendait la dernière écrite — sans la moindre erreur.** Vérifié en
  reproduisant la transmission, pas déduit. Un seul des six cas le voit : celui
  qui garde deux références vivantes en même temps ; les cinq autres passent sur
  un coffre qui range tout au même endroit, ce qui a été constaté en leur
  soumettant exprès un coffre cassé.
- **libsecret se déclarait disponible sans bus de session.** `secret-tool` sort
  en 1 aussi bien pour « secret absent » que pour « bus injoignable », et la
  sonde acceptait les deux. Sur un serveur sans session graphique, libsecret
  était donc élu, puis levait à chaque écriture — alors que le repli fichier
  existe précisément pour ce cas. Une absence est muette, une panne parle : c'est
  la sortie d'erreur qui les sépare. Au passage, `DBUS_SESSION_BUS_ADDRESS` et
  `XDG_RUNTIME_DIR` manquaient à la liste blanche, sans quoi `secret-tool` ne
  trouve pas le trousseau même là où il fonctionne.

La correction commune est la même dans les deux cas : `run()` accepte désormais
un environnement explicite pour l'appel, ce qui règle aussi une course entre deux
`set` simultanés — ils se volaient leur référence dans `process.env`.

**Une machine ne prouve qu'un coffre.** D'où `.github/workflows/vault.yml` :
quatre postes — macOS, Windows, Linux avec trousseau, Linux **sans**. Le
quatrième prouve une *absence*, et c'est le plus utile des quatre : c'est lui qui
aurait pris la sonde libsecret trop indulgente. Chaque poste pose
`MIDGAARD_REQUIRE_VAULT`, et la suite échoue si ce n'est pas ce coffre-là qui a
été retenu — sans quoi un poste sans trousseau sauterait la batterie et passerait
au vert sans rien avoir éprouvé. Un saut n'est pas une réussite.

#### Ce que la CI a coûté, et rapporté

Le workflow a tourné le 2026-10-29. **Il a fallu cinq passages pour obtenir
quatre verts**, et chacun des quatre rouges disait quelque chose de vrai. C'est
le meilleur argument qu'on puisse donner en faveur de la dette n° 3 : rien de
tout cela n'était visible depuis un Mac.

| Passage | macOS | Windows | libsecret | Linux nu | Ce que le rouge disait |
|---|---|---|---|---|---|
| 1 | ✓ | ✗ | ✗ | ✓ | DPAPI expire à 10 s ; trousseau Linux sans collection |
| 2 | ✓ | ✗ | 33/34 | ✓ | la recette Linux tient ; `delete` d'un absent lève |
| 3 | ✓ | ✗ | ✓ | ✓ | relevé : l'environnement arrive, ce sont les applets |
| 4 | ✓ | ✗ | ✓ | ✓ | `PSModulePath` n'y change rien — hypothèse fausse |
| 5 | ✓ | ✓ | ✓ | ✓ | — |

**Trois pannes de plus, toutes sur des plateformes qu'on n'a pas.**

- **DPAPI reconstruisait le cache d'analyse de modules de PowerShell à chaque
  appel.** 8 à 15 s, contre 264 ms quand il le retrouve : au-delà du délai, donc
  six cas expirés. Il manquait `PSModuleAnalysisCachePath` à la liste blanche —
  non pas une variable que PowerShell *lit pour travailler*, mais une qu'il lit
  **pour ne pas refaire un travail**. Deux corrections : la variable passe, et
  PowerShell reçoit son propre délai de 40 s, parce qu'un cache froid est une
  lenteur légitime et que couper à 10 s ferait échouer le premier appel d'une
  machine neuve.
- **Supprimer un secret absent levait, sur les deux plateformes, pour deux
  raisons différentes.** `secret-tool clear` sort en 1 sur un secret absent ;
  PowerShell sort en 1 dès que sa dernière commande a échoué, même avec
  `-ErrorAction SilentlyContinue`. Le contrat de `SecretVault` dit pourtant que
  l'absence n'est pas une erreur, et macOS le tenait (code 44 toléré), le repli
  fichier aussi (`rmSync` avec `force`). Trois plateformes, trois mécanismes, un
  seul contrat : c'est précisément ce qu'une batterie de conformité sert à tenir,
  et ce qu'aucun test écrit plateforme par plateforme n'aurait pris.
- **libsecret se déclarait disponible sur un trousseau sans collection.**
  `secret-tool lookup` réussissait là où tout `store` échouait. La sonde prouve
  que le **service** répond ; elle ne prouve pas qu'il a **où ranger**. Limite
  réelle et assumée — la combler demanderait d'écrire un secret d'essai à chaque
  démarrage. La recette de CI crée désormais la collection, et un dépôt d'essai
  la vérifie *avant* la suite, pour qu'un futur rouge désigne la recette plutôt
  que le code.

**Et deux messages qui n'en étaient pas**, trouvés en cherchant les trois
premières :

- un utilitaire tué par le délai ressortait en « code 1 » avec une sortie
  d'erreur vide, exactement comme un échec ordinaire. C'est ce qui a fait
  chercher la panne de DPAPI dans `set` — le seul appel qui écrit sur l'entrée
  standard — alors que `get` expirait tout autant ;
- une panne de coffre Windows s'affichait `#< CLIXML <Objs Version="1.1.0.1"…` :
  PowerShell, flux redirigés, ne *écrit* pas sur la sortie d'erreur, il y
  sérialise des objets.

#### Trois hypothèses fausses, et ce qu'elles apprennent

Le cas DPAPI a demandé **cinq passages**, parce que les trois premières
explications étaient les miennes et non celles de la machine :

1. *« `Join-Path` pose une question quand son paramètre obligatoire est nul. »*
   Le script n'en contient plus — toujours expiré.
2. *« L'entrée standard reste ouverte, donc la question attend. »* Elle est
   fermée dans tous les cas — toujours expiré.
3. *« Il manque `PSModulePath`. »* Imposée, réduite ou absente, aucun effet. Et
   le relevé qui semblait la confirmer disait **14 832 ms sous un délai de
   15 s** : j'avais pris une quasi-expiration pour une réussite.

La quatrième n'a pas été devinée : une bissection sur les 145 variables que la
liste blanche écartait l'a nommée en sept étapes. Chercher par élimination
coûtait **un** passage ; en deviner trois en a coûté **trois**.

C'est, mot pour mot, le défaut n° 2 de l'essai en vraie session — *un message
qui ne nomme qu'un symptôme oriente son lecteur vers le chiffre qu'il a sous la
main, et ce chiffre est rarement la cause* — cette fois à mes dépens, et avec le
dashboard, la base et le code sous les yeux. La correction du message
d'expiration, elle, a servi dès le passage suivant : c'est elle qui a permis
d'écarter la première hypothèse au lieu de la croire.

Deux commentaires de code affirmaient la troisième explication. Ils ont été
rectifiés **avant** toute autre chose, cause ouverte assumée : une explication
fausse laissée dans le code est pire que pas d'explication.

#### Ce que la dette vaut maintenant

**Constatée, sur les quatre postes** (passage `40937579307`, 2026-10-29) :
trousseau macOS, DPAPI Windows, libsecret sous session de bureau, et le repli
fichier sur un Linux sans trousseau — ce dernier prouvant une *absence*, qui est
le comportement attendu et non une panne. DPAPI répond en moins de 1,5 s par cas
là où il expirait à 10 s.

Ce qui n'est **pas** couvert, et qui est dit tel quel : la sonde de libsecret ne
distingue pas un service sans collection, et aucun poste ne couvre un Windows
sans PowerShell 5.1 ni un macOS au trousseau verrouillé.

### Dette n° 4 — le dashboard, rendu dans un navigateur

Le report durait depuis la Slice 1. `npm run test:ui` lance 7 scénarios contre un
vrai daemon et un vrai Chromium. Playwright y est employé en **bibliothèque**, pas
en lanceur : les suites de ce dépôt ont leur forme, et un second lanceur avec sa
configuration et son rapporteur aurait coûté plus qu'il ne rend.

| | Ce qu'il protège |
|---|---|
| D1 | L'URL annoncée sert une application qui **démarre** — fichiers, `/ui/bootstrap`, WebSocket, console muette |
| D2 | Une tâche créée apparaît **sans rechargement** |
| D3 | La progression avance seule, sur le **vrai dénominateur** (défaut n° 3 de l'essai en vraie session) |
| D4 | Une approbation donnée **au clic** débloque la tâche |
| D5 | Une tâche sans appel de modèle n'affiche **pas** « 0 $ » |
| D6 | Un lien profond rouvre la bonne tâche après rechargement |
| D7 | La perte de la WebSocket **et son retour** se voient |

**Deux pannes réelles, toutes deux invisibles sans rendu.**

- **La carte « Exécutants » ne s'affichait jamais au premier chargement.** React
  exécute les effets des enfants avant ceux du parent : `AgentsCard` demandait
  ses données avant que `useHarness` n'ait seulement lancé le bootstrap,
  recevait deux `401`, et son `catch` vide la faisait disparaître. Mesuré en
  relevant l'ordre des requêtes : `/api/agents` et `/api/providers` partent
  **avant** `/ui/bootstrap`. La carte qui existe précisément pour dire à un
  nouveau venu qu'aucun fournisseur n'est configuré était absente de son écran
  d'accueil — exactement le défaut n° 1 de la Slice 0, réapparu par une autre
  porte. Corrigé à la cause : `api()` obtient un jeton avant d'appeler, au lieu
  d'espérer qu'un autre l'ait fait.
- **Le dashboard ne se reconnectait jamais après un redémarrage du daemon.** Le
  jeton est régénéré à chaque démarrage ; `connect()` voyait un jeton non nul,
  sautait le bootstrap, et réessayait indéfiniment avec une valeur périmée. La
  page restait « déconnecté » jusqu'à un rechargement manuel. Corrigé en
  oubliant le jeton à la fermeture de la WebSocket.

Chaque correctif a été retiré pour vérifier qu'il est bien ce qui fait passer son
scénario, et que l'échec tombe sur **celui-là seulement**.

**Et une erreur de ma part, conservée parce qu'elle est instructive.** Le premier
jet de D7 passait sans le correctif du jeton. J'en ai conclu, à tort, que la
panne n'existait pas. La cause était dans mon test : `getByText('en direct')`
trouvait sa correspondance dans le texte de l'écran vide — « Elle apparaîtra ici
en direct. » — et non dans le badge de connexion. **Un faux positif, dans un test
écrit pour attraper les faux positifs de l'interface.** Les états de connexion
sont désormais cherchés dans le `<header>` et nulle part ailleurs. C'est la même
famille que le défaut n° 1 de l'essai en vraie session : une réponse fausse qui a
l'air d'une vraie réponse, et qu'on croit.

Second rappel du même ordre, plus bénin : le premier jet de D4 concluait à une
panne du panneau d'approbation. Le dashboard se comportait **comme documenté** —
il ne vole pas la sélection en cours, puisque la tâche qu'on regarde
s'échapperait au moment même où on l'approuve. C'était au test de cliquer.

### Dette n° 5 — le conseil de `doctor` sur le coffre

Trois lignes, et la plus petite des cinq. `vaultAdvice(platform, env)` dépend
désormais de la plateforme, parce que **la cause en dépend** : sous Linux il
manque un paquet qu'on installe ; sous macOS et Windows le magasin est livré avec
le système, et son silence signale autre chose — un environnement restreint, un
`PATH` amputé. Chaque branche nomme l'utilitaire qu'on peut aller vérifier soi-même.

Un cas s'y est ajouté, trouvé en écrivant le test : le repli **demandé** par
`MIDGAARD_VAULT=file`. Rien n'y manque, et proposer un paquet enverrait chercher
ce qu'on a soi-même écarté. C'est le cas de toutes les suites du dépôt, donc
celui qu'un développeur de ce projet rencontre le plus souvent.

### Ce que les trois ont en commun

Les sept pannes ont la même forme, et c'est celle des cinq défauts de l'essai
en vraie session : **un système qui répond quelque chose de plausible au lieu de
signaler qu'il ne peut pas répondre.** DPAPI rendait une clé — la mauvaise.
libsecret se disait prêt — il ne l'était pas. La carte des exécutants ne
s'affichait pas — sans un mot. Le dashboard affichait « déconnecté » — sans dire
qu'il ne reviendrait jamais.

S'y ajoutent les trois que la CI a révélées, et qui disent la même chose d'un
cran plus loin : DPAPI n'échouait pas, il **attendait** — et notre propre
outillage présentait cette attente comme un échec ordinaire. libsecret se
déclarait prêt sur un trousseau qui n'avait nulle part où ranger. Et supprimer
un secret absent levait sur les deux plateformes, chacune par un mécanisme
différent, alors que le contrat disait le contraire depuis le début.

Aucune n'aurait été trouvée par une relecture. Toutes l'ont été en **exécutant ce
qu'on n'exécutait pas** : le coffre réel, le navigateur réel, les trois
plateformes réelles. C'est le même exercice que le clone depuis GitHub dans un
dossier vierge qui avait révélé la dette n° 5 — emprunter un chemin qu'on
n'emprunte jamais soi-même. Chaque fois qu'on l'a fait dans cette slice, il y
avait quelque chose.

