# `@midgaard/agent-runtime`

La boucle d'exécution d'un agent. Elle ne connaît **ni le daemon, ni la base, ni
le coffre** : elle reçoit un adaptateur, un contexte d'outils et des crochets.

C'est ce qui permet de l'éprouver avec un faux fournisseur, sans réseau et sans
dépense — et donc de vérifier à chaque exécution de la suite que le budget
arrête bien la tâche **avant** l'appel de trop, sans payer pour le constater.

## Une itération

```text
 1. limites : annulation, délai, étapes, budget   ← AVANT l'appel modèle
 2. appel modèle
 3. consommation cumulée, diffusée
 4. pour chaque appel d'outil :
      schéma Zod → politique → [approbation humaine] → exécution → journal
 5. réinjection des résultats, et on recommence
```

L'ordre de l'étape 1 est celui du plan (§4), et il compte : une limite constatée
après l'appel a déjà été payée. Un budget qui se contente de constater n'est pas
un budget.

## Quatre décisions à connaître avant d'y toucher

**La fin est un acte, pas une interprétation.** Seul `submit_result` termine une
tâche. Un modèle qui écrit « voilà, j'ai fini » sans l'appeler n'a pas fini : il
a cessé de parler. La boucle le relance **une fois par réponse**, puis échoue
en le disant. Le droit à la relance se rouvre dès qu'une réponse appelle un
outil : au second essai réel de la Slice 8, il valait pour toute la tâche, et
un Researcher qui l'avait consommé à l'étape 1 a échoué sans relance à
l'étape 10. Une relance après une coupure le dit au modèle, avec le plafond,
raisonnement compris.

**Et elle dit *pourquoi* il n'a rien appelé.** « Aucun outil appelé » est un
symptôme, pas une cause. Dans un cas la réponse a été **coupée au plafond de
sortie** avant que l'appel n'ait pu être émis ; dans l'autre le modèle a
réellement cessé de conclure. Les deux se corrigent à l'opposé — raccourcir la
réponse demandée, ou reformuler l'objectif — et la boucle compte les troncatures
pour les distinguer dans son motif d'échec.

Ce n'est pas une précaution théorique : avec l'ancien message, qui ne disait que
le symptôme, le lecteur a imputé l'échec au plafond d'étapes qu'il venait de
poser — et a publié ce diagnostic, faux. Un message incomplet ne laisse pas son
lecteur sans réponse, il lui en fait inventer une.

**Un conseil doit viser une manette que son lecteur peut atteindre.** La boucle
conseillait de « relever `max_output_tokens` » : ce plafond appartient au
profil, et `tightenLimits` ne sait qu'abaisser — relever est impossible depuis
une délégation. Les conseils renvoient désormais à l'objectif, ou à `max_steps`
jusqu'au plafond du profil.

**Tout ce qui vient du dehors est encadré, même pour l'agent.** Un résultat
`untrusted` est enveloppé avant d'être réinjecté dans la conversation de l'agent
lui-même, pas seulement avant de remonter à qui l'a délégué. L'agent est la première
cible d'une page qui essaie de détourner la tâche. Un fichier du projet n'est
**pas** encadré : banaliser le marqueur le viderait de son sens.

**Et ce qu'il en tire est marqué non fiable.** Depuis la Slice 5, le résultat
final porte `untrusted` dès qu'un contenu encadré est entré dans la
conversation — page, sortie de commande, résultat d'une sous-tâche, recherche
web native —, cité ou non. Avant, seules les citations le marquaient : un
Researcher qui lisait une page sans la citer, ou un orchestrateur qui recopiait
le résultat d'un Researcher, rendaient un résultat présenté comme fiable.
Conséquence voulue : un Developer qui a lancé une commande rend un résultat
non fiable.

**Les limites sont dites au modèle.** Elles sont appliquées par le code de toute
façon, mais un agent qui ignore qu'il n'a que douze étapes les dépense à
explorer, puis se fait couper sans rien rendre. Lui dire son budget change sa
stratégie, pas seulement son information. **Et la fin lui est rappelée** :
à deux appels de la limite, puis au dernier, la boucle lui demande de
soumettre ce qu'il a (`STEPS_WARNING`). Annoncer le budget au départ ne
suffit pas : au second essai réel de la Slice 8, un orchestrateur a écrit
« The picture is complete » à l'étape 13, vérifié trois détails de plus, et
atteint sa limite de 16 étapes sans rien soumettre.

**Un budget inapplicable est annoncé comme tel.** Si le tarif du modèle est
inconnu, la dépense ne peut pas être plafonnée en dollars — seules les étapes et
le délai bornent la tâche. La boucle le dit **une fois**, plutôt que de laisser
croire à une protection qui n'opère pas.

## Conversation (Slice 6)

En mode `chat`, une réponse sans outil est une **réplique** : la boucle
appelle `LoopHooks.awaitInput` et repart avec le message reçu, dans la même
conversation. Trois règles :

- **La fin reste un acte.** Seul `submit_result` termine, même en
  conversation. La relance de la sortie `oneshot` ne s'applique pas à une
  réplique.
- **L'attente ne consomme pas le délai.** L'échéance est repoussée de la
  durée de chaque attente, et celle des outils (`exec`) avec elle. Étapes et
  budget, eux, se comptent sur toute la conversation.
- **La consigne le dit au modèle.** `buildMessages` ajoute un bloc
  « CONVERSATION » après celle du profil, présente l'objectif comme le premier
  message de l'utilisateur, et dit que l'attente ne compte pas dans le temps.

Une annulation pendant l'attente rend `cancelled`, une attente expirée
`timed_out`, sans appel modèle de plus.

En mode `review` (un Developer délégué par un orchestrateur), `submit_result`
est une **proposition** : la boucle attend le verdict du parent. Acceptée, elle
rend le résultat tel qu'il a été soumis ; renvoyée, le modèle lit le retour en
réponse à son appel et recommence. `ask_parent` suspend de même la tâche jusqu'à
la réponse. `finishBlocked` refuse le `submit_result` d'un parent dont un enfant
attend, et le modèle continue. La consigne le dit, sur une tâche déléguée
seulement.

## Sortie en direct (Slice 6)

`OutputBatcher` (`output.ts`) prépare la sortie d'**une** commande pour le
terminal du dashboard, dans cet ordre :

1. décodage UTF-8 **par flux** (`StringDecoder`) : un caractère coupé entre deux
   morceaux reste un caractère ;
2. découpe **par ligne, avant l'expurgation** : une clé coupée entre deux
   morceaux serait sinon écrite en clair, en deux moitiés trop courtes pour les
   motifs. Une ligne sans fin est livrée par tranches de 4096 caractères ; une
   clé à cheval sur une telle coupure n'est pas couverte, et c'est dit ;
3. regroupement : un lot par flux toutes les 250 ms ;
4. plafond : 128 Ko par commande, puis un avis qui dit combien manque.

La boucle en crée un par appel d'outil et livre ses lots à
`LoopHooks.onToolOutput`, que le moteur écrit en `exec.output`. Le modèle ne
lit rien de tout cela.

## Images (Slice 7)

Les images rendues par les outils d'une étape rejoignent le modèle dans **un**
message utilisateur, après tous les résultats de l'étape : aucune API n'en
admet dans un message de rôle `tool`, et l'API Chat Completions refuse un
message utilisateur glissé entre deux résultats. Elles ne passent pas par
l'expurgation, qui ne sait pas les lire, et ne sont jamais journalisées.

Deux règles pour les captures du navigateur :

- **une capture chasse la précédente** : une image marquée `transient` est
  retirée de la conversation dès qu'une autre arrive (`dropTransientImages`),
  et le message qui la portait le dit. Chaque étape renvoie toute la
  conversation ; vingt captures gardées coûteraient vingt images à chaque
  appel. Une image du projet (`read_image`) reste ;
- **le message qui porte une capture la dit non fiable** : une image ne se met
  pas entre balises, la phrase qui l'accompagne le dit à sa place. Le résultat
  de l'outil, lui, est encadré, et la tâche marquée.

## Outils construits pour la tâche (Slice 8)

`LoopInput.extraTools` porte les outils des serveurs MCP de la tâche, que le
daemon a construits au départ. Ils sont proposés au modèle **après** ceux du
profil, décrits par le schéma de leur serveur (`Tool.parameters`), et
autorisés parce que le daemon les a construits — pas parce que le modèle les
nomme. Le reste du chemin est celui de tout outil : politique, préparation,
approbation, exécution, encadrement du résultat non fiable.

## Statuts d'arrêt

| Raison | Statut | Pourquoi pas `failed` |
|---|---|---|
| budget atteint | `budget_exceeded` | rien n'a échoué, un plafond a été atteint |
| délai dépassé | `timed_out` | idem |
| annulation | `cancelled` | demandée par un humain |
| étapes épuisées sans résultat | `failed` | là, quelque chose n'a pas marché |

Confondre les deux premiers avec `failed` enverrait l'utilisateur chercher un
bogue là où il n'y a qu'une limite à relever.

## Contexte

Le contexte vient de qui délègue (§4 du plan). Le runtime y ajoute
seulement l'arborescence du workspace, bornée à deux niveaux, et les consignes du
profil. Un agent qui commencerait par lire trente fichiers pour comprendre où il
est dépenserait plus que la question ne valait, et déléguer deviendrait plus cher
que faire soi-même.

C'est **qui délègue** qui fournit ce contexte : l'humain qui lance la tâche du
dashboard, ou l'orchestrateur intégré au daemon, sur n'importe quel modèle. Ce
que lit l'agent ne nomme jamais qui l'a délégué — la consigne lui dit
seulement qu'un orchestrateur l'a fait. Un test le vérifie sur le texte
entier remis au modèle (`tests/unit/agent-runtime.test.ts`, « neutralité
envers l'orchestrateur »).
