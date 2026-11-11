# `@midgaard/providers`

Adaptateurs de fournisseurs de modèles. La boucle d'agent ne connaît que
`{ text, toolCalls[], usage }` ; **tout ce qui diffère entre fournisseurs se
normalise ici**, et nulle part ailleurs.

## Deux formes de fil, trois endpoints

| | compatible OpenAI | Gemini |
|---|---|---|
| Rôles | `system`, `user`, `assistant`, `tool` | `user` et `model` seulement |
| Consigne système | un message | un champ à part, `systemInstruction` |
| Appel d'outil | `tool_calls[].function.arguments`, **chaîne JSON** | `functionCall.args`, **objet désérialisé** |
| Retour d'outil | rôle `tool` + `tool_call_id` | `functionResponse` dans un `Content` de rôle `user`, **sans identifiant** |
| Jetons de raisonnement | compris dans `completion_tokens` | `thoughtsTokenCount`, **en plus** de `candidatesTokenCount` |

**Venice n'est pas un troisième adaptateur.** Son API est compatible OpenAI :
c'est le même adaptateur avec une autre `base_url`, plus un objet d'extension
`venice_parameters`. D'où la distinction entre `kind` (comment on parle, donc
l'adaptateur) et `preset` (à qui on parle, donc les tarifs et les extensions).

## Images et capacité « vision » (Slice 7)

Un message **utilisateur** peut porter des images (`images`, en base64) : une
partie `image_url` en URL `data:` pour l'API compatible OpenAI, une partie
`inlineData` pour Gemini. Seul le message utilisateur en porte : aucune des
deux API n'admet d'image dans un retour d'outil, et la boucle joindra donc
l'image d'un outil dans un message utilisateur qui suit son résultat. Une
image ne vit que dans la conversation, jamais en base.

`capabilities()` dit si le modèle configuré lit les images, **d'après le
catalogue du fournisseur** : `GET /models` de Venice publie
`supportsVision` pour chaque modèle, lu une fois par heure et gardé en
mémoire (`CATALOG_TTL_MS`). OpenAI et un endpoint `custom` ne publient rien :
la réponse est `null`, « inconnu », jamais devinée d'après le nom du modèle.
Un catalogue illisible rend aussi « inconnu », sans faire échouer la tâche.

Les tests vérifient la forme envoyée et la lecture du catalogue sur réponses
enregistrées. Contre l'API réelle, `npm run test:live-vision` (opt-in, payant)
joint l'icône de la coque à `mistral-small-3-2-24b-instruct` : le modèle a
nommé la lettre, et l'image a coûté environ mille jetons d'entrée, facturés
par Venice au montant de l'estimation (`docs/SLICE7.md`).

## Pourquoi pas les SDK officiels

Le plan (§1) verrouillait `openai` et `@google/genai`. La Slice 2 ne les prend
pas, pour quatre raisons :

1. On n'appelle **qu'un endpoint par fournisseur**, sans flux. Un SDK complet
   pour un `POST` JSON coûte plus qu'il ne rend.
2. Il faut **contrôler le corps au champ près** : Venice refuse en 400 tout
   champ de premier niveau inconnu, et attend son extension propre.
3. **Une seule discipline HTTP** — délai, reprise, annulation, expurgation —
   plutôt que trois comportements à connaître.
4. Les SDK **bougent** : la Slice 0 avait déjà relevé que `@google/genai` ≥ 2
   change la forme des appels. L'API REST, elle, est documentée et stable.

Même raisonnement que `node:http` sur Fastify et `node:sqlite` sur
`better-sqlite3` en Slice 1. Le prix est assumé : les erreurs de l'API, c'est
nous qui les interprétons.

## Le coût, et sa provenance

Chaque réponse rend un `Usage` qui porte **deux** montants :

- `cost_usd_reported` — ce que le fournisseur annonce. Venice le fait
  (`cost.usd` sur chaque réponse) ; OpenAI et Gemini non ;
- `cost_usd_estimated` — ce que `pricing.json` donne.

`cost_source` dit lequel est retenu : `provider` l'emporte toujours sur
`pricing_table`. L'écart entre les deux est la **seule** façon de s'apercevoir
qu'une table de tarifs a dérivé ; sans les deux, personne ne le verrait.

Modèle sans tarif connu → `cost_source: 'unknown'` et `cost_usd` à zéro.
Zéro est un coût, pas une ignorance : l'interface affiche « tarif inconnu »,
jamais « 0 $ ».

`fetchVenicePricing` reconstruit la table depuis `GET /models`, qui publie
`model_spec.pricing`. Un tarif relevé chez le fournisseur ne peut pas dériver.
Il relève aussi `cache_input`, le tarif des jetons lus en cache : sans lui,
tout était compté au plein tarif, et l'estimation de l'essai de la Slice 4
(étape 8) dépassait la facture de 124 % ; avec lui, elle tombe dessus au
microdollar. `cache_write` n'est pas relevé : l'usage ne compte pas les
écritures en cache.

## Test de connexion

**`GET /models` de Venice répond `200` sans aucune clé** — mesuré. Un test qui
s'y fierait annoncerait « joignable » à quelqu'un dont la clé est fausse. Le
test fait donc deux appels : la liste des modèles, puis une **sonde
authentifiée** (`AUTH_PROBE`) là où `/models` est public. Aucun jeton n'est
facturé : pas d'appel de complétion.

## Limite connue

**L'adaptateur Gemini n'a jamais été exécuté contre l'API réelle** — aucune clé
n'était disponible en Slice 2. Il est écrit d'après la documentation REST et
vérifié sur réponses enregistrées. Le grounding `google_search` n'est pas activé
non plus : il partage le tableau `tools` avec les `functionDeclarations`, et rien
dans la documentation ne dit qu'ils cohabitent. Détail dans
[`docs/SLICE2.md`](../../docs/SLICE2.md).
