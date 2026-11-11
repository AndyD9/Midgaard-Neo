#!/usr/bin/env node
/**
 * @file Point d'entrée exécutable du daemon : `node packages/daemon/src/main.ts`.
 *
 * C'est **ici seulement** que l'environnement est lu. Tout le reste du paquet
 * reçoit une configuration en paramètre, ce qui permet aux tests de faire tourner
 * un daemon complet sur un dossier temporaire sans toucher à l'environnement du
 * processus.
 */
import { loadConfig } from '@midgaard/contracts'
import { startDaemon } from './daemon.ts'

const config = loadConfig(process.env)
// L'environnement est transmis explicitement : il sert de dernier recours pour
// une clé de fournisseur, et c'est ici — et seulement ici — qu'on le lit.
const daemon = await startDaemon(config, { env: process.env })

// Code 0 : un autre daemon fait déjà le travail, ce n'est pas une erreur.
if (!daemon) process.exit(0)

process.on('SIGINT', () => daemon.close('SIGINT'))
process.on('SIGTERM', () => daemon.close('SIGTERM'))

await daemon.stopped
process.exit(0)
