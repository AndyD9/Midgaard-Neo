/**
 * @file Mise en forme des montants du dashboard.
 *
 * Premier test du paquet `@midgaard/dashboard`. Il ne touche qu'aux fonctions
 * pures de `src/lib/utils.ts` : aucun rendu, aucun DOM, aucune dépendance de
 * navigateur — le test Playwright de l'interface reste porté en Slice 3.
 *
 * Ce qui est vérifié ici n'est pas cosmétique. La facture du fournisseur et
 * notre estimation ne valent **que côte à côte** : leur écart est la seule
 * façon de voir vieillir `pricing.json`. Un arrondi qui les rend identiques
 * supprime l'information que ces deux chiffres existent pour porter.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatCost, formatTokens } from '../../apps/dashboard/src/lib/utils.ts'

describe('formatCost', () => {
  // Le défaut trouvé en vraie session : 0,011632 $ facturés et 0,011763 $
  // estimés s'affichaient tous deux « 0,01 $ ». Les deux montants que le
  // dashboard met côte à côte pour montrer leur écart devenaient le même.
  it('garde distincts deux montants proches dans la tranche d\'une vraie tâche', () => {
    const facture = formatCost(0.011632)
    const estimation = formatCost(0.011763)
    assert.notEqual(facture, estimation, 'deux montants différents ne peuvent pas s\'afficher pareil')
    assert.equal(facture, '0.0116 $')
    assert.equal(estimation, '0.0118 $')
  })

  it('montre quatre décimales sous le dollar, deux au-dessus', () => {
    assert.equal(formatCost(0.0018), '0.0018 $')
    assert.equal(formatCost(0.0009), '0.0009 $')
    assert.equal(formatCost(1.2), '1.20 $')
    assert.equal(formatCost(12.345), '12.35 $')
  })

  // Les zéros inutiles tombent, mais un montant rond reste de l'argent :
  // « 0,5 $ » ne se lit pas comme « 0,50 $ ».
  it('ne descend jamais sous deux décimales', () => {
    assert.equal(formatCost(0.5), '0.50 $')
    assert.equal(formatCost(0.05), '0.05 $')
    assert.equal(formatCost(0.1), '0.10 $')
  })

  // Le défaut corrigé plus tôt dans la slice, à l'autre bout de l'échelle :
  // quatre décimales affichaient « 0,0000 $ » pour un budget non nul.
  it('ne rend jamais zéro pour un montant non nul', () => {
    assert.equal(formatCost(0.000001), '0.000001 $')
    assert.notEqual(formatCost(0.00000005), '0 $')
    assert.equal(formatCost(0), '0 $', 'zéro, lui, est bien zéro')
  })
})

describe('formatTokens', () => {
  it('abrège au-delà du millier, avec la virgule française', () => {
    assert.equal(formatTokens(999), '999')
    assert.equal(formatTokens(12400), '12,4 k')
  })
})
