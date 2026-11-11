/**
 * @file Ce que la CLI décide seule, sans daemon : lecture des arguments de
 * `harness exec` (`--prefix` compris), et contrôles de `doctor` sur Git et
 * la liste blanche.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { execAllowCheck, gitCheck, parseExecArgs } from '@midgaard/cli'

describe('parseExecArgs', () => {
  it('garde les options de la commande, qui viennent après le premier mot', () => {
    // Sans cette règle, `npx tsc --noEmit` perdrait son `--noEmit`.
    assert.deepEqual(parseExecArgs(['npx', 'tsc', '--noEmit']).argv, ['npx', 'tsc', '--noEmit'])
  })

  it('lit --yes et --dir avant la commande, et -- comme séparateur', () => {
    const r = parseExecArgs(['--yes', '--dir', '/depot', '--', 'npm', 'test', '--yes'])
    assert.equal(r.yes, true)
    assert.equal(r.dir, '/depot')
    assert.deepEqual(r.argv, ['npm', 'test', '--yes'], 'un --yes après la commande lui appartient')
  })

  it('ne confirme rien d\'office', () => {
    assert.equal(parseExecArgs(['npm', 'test']).yes, false)
  })

  it('lit --prefix avant la commande seulement (Slice 9)', () => {
    assert.equal(parseExecArgs(['--prefix', 'uv', 'run', 'pytest']).prefix, true)
    const after = parseExecArgs(['git', 'log', '--prefix'])
    assert.equal(after.prefix, false, 'un --prefix après la commande lui appartient')
    assert.deepEqual(after.argv, ['git', 'log', '--prefix'])
  })
})

describe('gitCheck', () => {
  it('accepte 2.17 et plus, avertit en deçà ou en l\'absence de Git', () => {
    assert.equal(gitCheck('git version 2.54.0 (Apple Git-157)').level, 'ok')
    assert.equal(gitCheck('git version 2.17.1').level, 'ok')
    assert.equal(gitCheck('git version 2.16.6').level, 'warn')
    assert.equal(gitCheck('git version 1.9.0').level, 'warn')
    const absent = gitCheck(null)
    assert.equal(absent.level, 'warn', 'le Researcher se passe de Git : avertissement, pas échec')
    assert.match(absent.fix ?? '', /2\.17/)
  })
})

describe('execAllowCheck', () => {
  it('est vert quand chaque commande attend un humain', () => {
    assert.equal(execAllowCheck([], [], '/depot').level, 'ok')
  })

  it('avertit dès qu\'une commande passe sans approbation, et dit pourquoi', () => {
    const c = execAllowCheck([['npm', 'test']], [{ argv: ['npx', 'tsc', '--noEmit'], prefix: false }], '/depot')
    assert.equal(c.level, 'warn')
    assert.match(c.detail, /npm test \(tous dépôts\).*npx tsc --noEmit/)
    assert.match(c.fix ?? '', /ce que l'agent a écrit/)
  })

  it('montre un préfixe comme tel, et celui que le moteur écarterait comme écarté (Slice 9)', () => {
    const c = execAllowCheck(
      [],
      [
        { argv: ['python', '-m', 'pytest'], prefix: true },
        // Ajouté avant un durcissement de la règle, ou écrit à la main en base.
        { argv: ['python', '-c'], prefix: true },
      ],
      '/depot',
    )
    assert.match(c.detail, /python -m pytest …/)
    assert.match(c.detail, /python -c … \(préfixe écarté\)/)
    assert.doesNotMatch(c.detail, /python -m pytest … \(préfixe écarté\)/)
  })
})
