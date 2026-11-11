/**
 * @file Les fournisseurs de modèles, dans la vue « Profils » : les déclarer,
 * déposer ou remplacer leur clé, les tester, les retirer — sans terminal.
 *
 * Jusqu'ici la clé ne se saisissait que par `harness providers add`. La carte
 * emploie **la même route** (`POST /api/providers`) : rien ne change au
 * daemon, qui dépose la clé au coffre système et n'en garde qu'une référence.
 *
 * **Ce que la carte garantit sur la clé** :
 *  - elle se saisit dans un champ masqué, sans remplissage automatique ni
 *    mémorisation par le navigateur ;
 *  - elle part dans le corps d'une requête vers le daemon, sur la même
 *    origine — jamais dans une URL, jamais dans un stockage du navigateur ;
 *  - elle est **effacée de la mémoire de la page** dès l'envoi, réussi ou non ;
 *  - elle ne revient jamais : le daemon ne rend qu'un `secret_ref`, et la
 *    carte dit seulement « clé au coffre ».
 *
 * Comme la CLI, la carte **teste dans la foulée** : un fournisseur déclaré
 * mais injoignable ne se découvrirait sinon qu'à la première tâche. Le test
 * prouve la clé, pas seulement l'adresse (voir CLAUDE.md).
 *
 * Plusieurs clés d'un même fournisseur se déclarent sous des identifiants
 * différents (`venice`, `venice-perso`) ; chaque profil choisit le sien dans
 * la carte « Exécutants ».
 */
import { useCallback, useEffect, useState } from 'react'
import { KeyRound, RefreshCw, Save, Trash2 } from 'lucide-react'
import type { ProviderConfig, ProviderPreset } from '@midgaard/contracts'
import { ApiError, fetchProviders, refreshProviderPricing, removeProvider, saveProvider, testProvider } from '@/lib/api'
import { PRESET_OPTIONS, draftError, draftOf, emptyDraft, keyStatus, requestOf, type ProviderDraft } from '@/lib/providers'
import { formatDateTime } from '@/lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardBody, CardHeader, CardTitle } from './ui/card'

/** Style commun des champs du formulaire. */
const FIELD = 'w-full rounded border border-border bg-surface px-2 py-1 font-mono text-xs'

/** Le motif joint à un refus du daemon, sinon son code. */
function reasonOf(e: unknown): string {
  return e instanceof ApiError && e.reason ? e.reason : (e as Error).message
}

/**
 * La carte des fournisseurs.
 * @param onChanged appelé après tout changement : les profils qui dépendent
 *                  d'un fournisseur (activés, désactivés) sont à relire
 */
export function ProvidersCard({ onChanged }: { onChanged?: () => void }) {
  const [providers, setProviders] = useState<ProviderConfig[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      setProviders((await fetchProviders()).providers)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => void load(), [load])

  const existing = providers?.find((p) => p.id === draft.id.trim())

  /** Change de préréglage, et propose son modèle si le champ n'a pas été touché. */
  function choosePreset(preset: ProviderPreset): void {
    setDraft((d) => {
      const untouched = d.model === '' || d.model === PRESET_OPTIONS[d.preset].suggestedModel
      return { ...d, preset, model: untouched ? PRESET_OPTIONS[preset].suggestedModel : d.model }
    })
  }

  /** Enregistre, puis teste : ce que l'humain lit ensuite est un constat. */
  async function submit(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault()
    const refusal = draftError(draft, existing)
    if (refusal) return setMessage({ ok: false, text: refusal })
    const request = requestOf(draft)
    // La clé quitte l'état de la page avant même la réponse : un échec ne la
    // laisse pas affichable, et il faudra la ressaisir.
    setDraft((d) => ({ ...d, apiKey: '' }))
    setBusy('save')
    setMessage(null)
    try {
      await saveProvider(request)
      try {
        const { test } = await testProvider(request.id)
        setMessage({ ok: test.ok, text: test.ok ? `« ${request.id} » enregistré et joignable — ${test.detail}` : `« ${request.id} » enregistré, mais le test échoue : ${test.detail}` })
      } catch (e) {
        setMessage({ ok: false, text: `« ${request.id} » enregistré, mais non testé : ${reasonOf(e)}` })
      }
    } catch (e) {
      setMessage({ ok: false, text: `Refusé : ${reasonOf(e)}` })
    } finally {
      setBusy(null)
      await load()
      onChanged?.()
    }
  }

  /** Lance une action sur un fournisseur déclaré, et relit la liste. */
  async function act(label: string, run: () => Promise<string>): Promise<void> {
    setBusy(label)
    setMessage(null)
    try {
      setMessage({ ok: true, text: await run() })
    } catch (e) {
      setMessage({ ok: false, text: reasonOf(e) })
    } finally {
      setBusy(null)
      await load()
      onChanged?.()
    }
  }

  /** Retirer efface la clé du coffre : cela se confirme. */
  function remove(id: string): void {
    const warning =
      `Retirer le fournisseur « ${id} » ?\n\n` +
      'Sa clé sera effacée du coffre. Les profils qui l’emploient seront désactivés, pas supprimés : leurs réglages sont conservés.'
    if (!window.confirm(warning)) return
    void act(`remove-${id}`, async () => {
      await removeProvider(id)
      return `« ${id} » retiré, sa clé effacée du coffre`
    })
  }

  return (
    <Card data-testid="providers-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted" /> Fournisseurs
        </CardTitle>
        <span className="text-xs text-muted">{providers ? `${providers.length} déclaré(s)` : ''}</span>
      </CardHeader>
      <CardBody className="space-y-4 text-sm">
        {error && <p className="text-xs text-danger">{error}</p>}
        {providers?.length === 0 && (
          <p className="text-xs text-waiting" data-testid="providers-empty">
            Aucun fournisseur : seul le profil simulé peut tourner. Ajoute une clé ci-dessous.
          </p>
        )}

        {providers?.map((p) => {
          const key = keyStatus(p)
          return (
            <section key={p.id} className="space-y-1 rounded-md border border-border p-3" data-testid={`provider-${p.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-medium">{p.id}</span>
                <span className="text-xs text-muted">
                  {PRESET_OPTIONS[p.preset].label} · {p.default_model}
                </span>
                <Badge tone={p.last_test?.ok ? 'done' : p.last_test ? 'danger' : 'neutral'} data-testid={`provider-test-badge-${p.id}`}>
                  {p.last_test ? (p.last_test.ok ? 'joignable' : 'injoignable') : 'jamais testé'}
                </Badge>
                <Badge tone={key.inVault ? 'neutral' : 'waiting'} data-testid={`provider-key-${p.id}`}>
                  {key.text}
                </Badge>
              </div>
              {p.base_url && <p className="font-mono text-xs break-all text-muted">{p.base_url}</p>}
              {p.last_test && (
                <p className={p.last_test.ok ? 'text-xs text-muted' : 'text-xs whitespace-pre-wrap text-danger'}>
                  {p.last_test.detail} — {formatDateTime(p.last_test.at)}
                </p>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`test-${p.id}`, async () => {
                      const { test } = await testProvider(p.id)
                      if (!test.ok) throw new Error(`« ${p.id} » : ${test.detail}`)
                      return `« ${p.id} » joignable — ${test.detail}`
                    })
                  }
                  data-testid={`provider-test-${p.id}`}
                >
                  <RefreshCw className={busy === `test-${p.id}` ? 'animate-spin' : undefined} /> Tester la connexion
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => {
                    setDraft(draftOf(p))
                    setMessage(null)
                  }}
                  data-testid={`provider-edit-${p.id}`}
                >
                  <KeyRound /> Changer la clé ou le modèle
                </Button>
                {p.preset === 'venice' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(`pricing-${p.id}`, async () => {
                        const { models } = await refreshProviderPricing(p.id)
                        return `tarifs relevés chez « ${p.id} » : ${models} modèle(s)`
                      })
                    }
                    data-testid={`provider-pricing-${p.id}`}
                  >
                    Relever les tarifs
                  </Button>
                )}
                <Button size="sm" variant="danger" className="ml-auto" disabled={busy !== null} onClick={() => remove(p.id)} data-testid={`provider-remove-${p.id}`}>
                  <Trash2 /> Retirer
                </Button>
              </div>
            </section>
          )
        })}

        {/* `autoComplete="off"` sur le formulaire, `new-password` sur la clé :
            le navigateur ne propose ni de la remplir ni de la retenir. */}
        <form className="space-y-2 border-t border-border pt-3" onSubmit={(e) => void submit(e)} autoComplete="off" data-testid="provider-form">
          <p className="text-xs font-medium">{existing ? `Modifier « ${existing.id} »` : 'Ajouter un fournisseur'}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted">Préréglage</span>
              <select className={FIELD} value={draft.preset} onChange={(e) => choosePreset(e.target.value as ProviderPreset)} data-testid="provider-preset">
                {(Object.keys(PRESET_OPTIONS) as ProviderPreset[]).map((preset) => (
                  <option key={preset} value={preset}>
                    {PRESET_OPTIONS[preset].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted">Identifiant (un par clé : venice, venice-perso…)</span>
              <input className={FIELD} value={draft.id} onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))} spellCheck={false} data-testid="provider-id" />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted">Modèle par défaut</span>
              <input className={FIELD} value={draft.model} onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))} spellCheck={false} data-testid="provider-model" />
            </label>
            {(PRESET_OPTIONS[draft.preset].needsBaseUrl || draft.baseUrl !== '') && (
              <label className="space-y-1 text-xs">
                <span className="text-muted">Adresse de l’endpoint</span>
                <input
                  className={FIELD}
                  value={draft.baseUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                  placeholder="https://…/v1"
                  spellCheck={false}
                  data-testid="provider-base-url"
                />
              </label>
            )}
          </div>
          <label className="block space-y-1 text-xs">
            <span className="text-muted">
              Clé d’API{existing?.secret_ref ? ' — laisse vide pour garder celle du coffre' : ''}
            </span>
            <input
              type="password"
              className={FIELD}
              value={draft.apiKey}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              autoComplete="new-password"
              spellCheck={false}
              data-testid="provider-key-input"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={busy !== null} data-testid="provider-save">
              <Save /> {existing ? 'Enregistrer et tester' : 'Ajouter et tester'}
            </Button>
            {existing && (
              <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setDraft(emptyDraft())}>
                Annuler
              </Button>
            )}
          </div>
          {message && (
            <p className={message.ok ? 'text-xs text-done' : 'text-xs whitespace-pre-wrap text-danger'} role="status" data-testid="provider-message">
              {message.text}
            </p>
          )}
          <p className="text-xs text-muted">
            La clé part au coffre système de cette machine et n’est jamais réaffichée, ni écrite en base. Le test qui
            suit ne facture rien.
          </p>
        </form>
      </CardBody>
    </Card>
  )
}
