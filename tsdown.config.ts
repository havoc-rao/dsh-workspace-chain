/**
 * tsdown build for the two client wire bundles — mirrors the DSH official
 * client-bundle preset (packages/client/tsdown.client.ts) as applied by
 * dsh-better-sidebar's tsdown.config.ts:
 *
 * - `lib/client.js` serves the official profile channel, registering with the
 *   package-name id `dsh-workspace-chain` (client-modules compose keys on the
 *   package name), and
 * - `lib/client-registry.js` serves the plugin-registry channel
 *   (dsh.plugin.json), registering with the manifest id
 *   `dsh-external/dsh-workspace-chain` (the registry browser-side arrive()
 *   check requires bundle id === plugin id).
 *
 * Both bundles compile the same src/client/index.tsx — only the registered id
 * and the output file name differ, so they cannot drift:
 * - externals resolve through the loader module table at runtime (the web
 *   shell's PLATFORM_MODULES seed list, plus the runtime/client exemption),
 * - every other dependency is inlined into the bundle,
 * - the purity gate rejects any other @deepseek-ai value import: cross-plugin
 *   collaboration goes through cordis services, never value imports,
 * - each artifact registers itself via window.__ModuleLoader__.load({id,
 *   factory}) with the (require) => exports CJS closure shape.
 *
 * dsh-code-finder: codeFinderTsdown() adds dev-only (NODE_ENV=development)
 * element-level data-locatorjs injection at the source transform stage, so
 * locators point at the original src/client/*.tsx positions; production
 * builds (no NODE_ENV) carry zero injection.
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown.
 * Build order (pnpm build): clean.mjs wipes lib wholesale before tsc, then
 * tsdown runs with clean: false so it never touches tsc's output.
 */
import { builtinModules } from 'node:module'
import type { UserConfig } from 'tsdown'
import { codeFinderTsdown } from '@havocrao/dsh-code-finder/tsdown'

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

/** Module specifiers the web shell shares into the frozen module table (the
 *  official PLATFORM_MODULES list, plus the runtime/client exemption). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Wire/type layers a client bundle may inline (mirror of the official
 *  INLINE_SAFE list): browser-safe contract surfaces with no runtime identity
 *  to share. Everything else under @deepseek-ai/* is either a module-table
 *  entry (external) or a leak the purity gate rejects. */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

/** A rolldown plugin as tsdown's config accepts it. */
type BuildPlugin = NonNullable<UserConfig['plugins']>

/** The shared client-bundle purity gate (see the file doc). */
function purityGatePlugin(): BuildPlugin {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) {
        throw new Error(
          `client bundle purity: Node builtin "${source}" cannot run in the browser module table — `
          + 'select the dependency browser export or add an explicit browser implementation',
        )
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
      if (INLINE_SAFE.test(source)) return null // wire/type layer: inline is the point
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) and not an inline-safe wire layer — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }
}

/**
 * One client bundle build for a plugin id. The same src/client/index.tsx is
 * compiled twice with only the registered id and the output file name
 * differing (see the file doc).
 * @param pluginId - the `__ModuleLoader__.load({ id })` value of this bundle.
 * @param entryFile - the output file name under lib/.
 */
function clientBundle(pluginId: string, entryFile: string): UserConfig {
  return {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    // clean stays off: the build script removes lib/ wholesale before tsc, so
    // a tsdown clean here would wipe the lib/types declarations tsc just
    // emitted.
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      // No client code uses import.meta.resolve; keep the stub so a stray
      // reference cannot resolve to Node's loader (browser CJS has none).
      'import.meta.resolve': 'undefined',
    },
    // CJS output otherwise makes some transitive packages resolve their Node
    // entry even though this bundle runs in the browser. Keep browser
    // conditional exports authoritative for both source import() and
    // generated require() edges.
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    // External wins for module-table entries; every other dependency inlines.
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [codeFinderTsdown(), purityGatePlugin()],
    outputOptions: {
      entryFileNames: entryFile,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      // The CJS wrapper factory's `require` only resolves module-table entries;
      // disable code splitting so every artifact is one script.
      codeSplitting: false,
    },
  }
}

export default [
  // Official profile channel: bundle id = package name (package.json `name`).
  clientBundle('dsh-workspace-chain', 'client.js'),
  // Plugin-registry channel: bundle id = manifest id (dsh.plugin.json `id`).
  clientBundle('dsh-external/dsh-workspace-chain', 'client-registry.js'),
] satisfies UserConfig[]