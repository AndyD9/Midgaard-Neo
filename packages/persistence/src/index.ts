/**
 * @file Point d'entrée de `@midgaard/persistence` : la mémoire longue du harness.
 *
 * Dépend uniquement de `@midgaard/contracts` et de `node:sqlite` — le module
 * SQLite intégré à Node, qui évite toute dépendance native à compiler.
 */
export { HarnessStore } from './store.ts'
export type { EventInput, Recorded, TaskPatch } from './store.ts'
export { MIGRATIONS, SCHEMA_VERSION, migrate, schemaVersionOf } from './migrations.ts'
export type { Migration } from './migrations.ts'
