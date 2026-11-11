/**
 * @file Consommation et coût d'une tâche.
 *
 * **Le chiffre n'est jamais montré seul.** Un montant sans sa provenance invite
 * à le prendre pour la facture ; or il peut venir du fournisseur lui-même, d'une
 * table de tarifs locale qui a pu vieillir, ou de nulle part. La pastille dit
 * lequel des trois, et quand le fournisseur annonce son propre coût on affiche
 * **aussi** notre estimation : l'écart entre les deux est la seule façon de
 * s'apercevoir que `pricing.json` a dérivé.
 */
import { Coins } from 'lucide-react'
import type { Task, Usage } from '@midgaard/contracts'
import { formatCost, formatTokens } from '@/lib/utils'
import { Badge, type BadgeTone } from './ui/badge'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

/** Libellé et ton de chaque provenance de coût. */
const SOURCE: Record<Usage['cost_source'], { label: string; tone: BadgeTone }> = {
  provider: { label: 'facturé par le fournisseur', tone: 'done' },
  pricing_table: { label: 'estimé depuis les tarifs locaux', tone: 'waiting' },
  unknown: { label: 'tarif inconnu pour ce modèle', tone: 'neutral' },
}

export function UsageCard({ task }: { task: Task }) {
  const u = task.usage
  // Rien à montrer tant qu'aucun modèle n'a été appelé : une carte « 0 $ » sur
  // une tâche simulée laisserait croire qu'on a mesuré quelque chose.
  if (u.model_calls === 0) return null

  const source = SOURCE[u.cost_source]
  const budget = task.limits.max_cost_usd
  const part = u.cost_source === 'unknown' || budget === 0 ? null : Math.min(1, u.cost_usd / budget)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="size-4 text-muted" /> Consommation
        </CardTitle>
        <Badge tone={source.tone}>{source.label}</Badge>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-2xl">
            {u.cost_source === 'unknown' ? '—' : formatCost(u.cost_usd)}
          </span>
          <span className="text-muted">
            sur un budget de {formatCost(budget)} · {u.model_calls} appel(s)
          </span>
        </div>

        {part !== null && (
          <div className="h-1.5 overflow-hidden rounded-full bg-border" role="presentation">
            <div
              className={part >= 1 ? 'h-full bg-danger' : 'h-full bg-accent'}
              style={{ width: `${Math.round(part * 100)}%` }}
            />
          </div>
        )}

        {u.cost_usd_reported !== null && u.cost_usd_estimated !== null && (
          <p className="text-xs text-muted">
            Notre estimation : {formatCost(u.cost_usd_estimated)}.{' '}
            {gap(u.cost_usd_reported, u.cost_usd_estimated, u.cached_tokens, u.input_tokens)}
          </p>
        )}

        {u.cost_source === 'unknown' && (
          <p className="text-xs text-muted">
            Aucun tarif connu pour ce modèle : le budget en dollars n'a pas pu être appliqué, seules les
            limites d'étapes et de durée ont borné cette tâche. Relève les tarifs avec{' '}
            <code className="font-mono">harness pricing refresh</code>.
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
          <Stat label="Entrée" value={formatTokens(u.input_tokens)} />
          <Stat label="Sortie" value={formatTokens(u.output_tokens)} />
          {u.reasoning_tokens > 0 && <Stat label="Raisonnement" value={formatTokens(u.reasoning_tokens)} />}
          {u.cached_tokens > 0 && <Stat label="Cache lu" value={formatTokens(u.cached_tokens)} />}
          {u.web_searches > 0 && <Stat label="Recherches web" value={String(u.web_searches)} />}
        </dl>
      </CardBody>
    </Card>
  )
}

/**
 * Compare facture et estimation, et **attribue** l'écart.
 *
 * Deux causes produisent le même écart, et appellent deux gestes opposés :
 *
 * 1. une table de tarifs périmée — il faut la rafraîchir ;
 * 2. des jetons servis depuis le cache du fournisseur, facturés à tarif réduit
 *    chez lui mais au prix fort chez nous, faute de tarif publié — il n'y a
 *    rien à faire, et l'estimation est haute pour une raison connue.
 *
 * N'en connaître qu'une envoyait l'utilisateur lancer un `pricing refresh`
 * qui ne changeait rien : constaté sur une tâche affichant « écart de 36 % :
 * les tarifs locaux ont probablement vieilli » alors que la table avait été
 * relevée chez le fournisseur **le jour même**, et que 60 % de l'entrée venait
 * du cache (docs/SLICE2.md, § défaut n° 4).
 *
 * @param reported  ce que le fournisseur a facturé
 * @param estimated ce que notre table calcule
 * @param cached    jetons d'entrée servis depuis le cache
 * @param input     jetons d'entrée au total
 */
function gap(reported: number, estimated: number, cached: number, input: number): string {
  if (estimated === 0) return ''
  const ratio = Math.abs(reported - estimated) / estimated
  if (ratio < 0.2) return 'Les deux concordent.'
  const pct = Math.round(ratio * 100)

  // Le cache n'explique qu'une estimation **haute** : il ne peut que nous
  // faire surfacturer, jamais sous-facturer. Si la facture dépasse l'estimation,
  // la table reste la seule explication.
  if (estimated > reported && cached > 0) {
    const share = input > 0 ? Math.round((cached / input) * 100) : 0
    return (
      `Écart de ${pct} % : ${share} % des jetons d'entrée viennent du cache, que nous facturons ` +
      `au tarif plein faute de tarif publié. L'estimation est haute pour cette raison, pas parce que ` +
      `les tarifs auraient vieilli.`
    )
  }
  return `Écart de ${pct} % : les tarifs locaux ont probablement vieilli.`
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  )
}
