import { rm } from 'node:fs/promises'
// Only generated artifacts; keep removed source modules out of the published tarball.
await rm(new URL('../lib/', import.meta.url), { recursive: true, force: true })
