import { build } from 'esbuild'
const shared = ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-runtime/client', '@deepseek-ai/dsh-client-ui-slots']
for (const [id, file] of [['dsh-workspace-chain', 'client.js'], ['dsh-external/dsh-workspace-chain', 'client-registry.js']]) {
  await build({ entryPoints: ['src/client/index.tsx'], outfile: `lib/${file}`, bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic', external: shared,
    banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
    footer: { js: 'return module.exports;}});' },
    plugins: [{ name: 'client-purity', setup(b) { b.onResolve({ filter: /^(node:|@deepseek-ai\/)/ }, args => {
      if (shared.includes(args.path)) return { path: args.path, external: true }
      throw new Error(`Client bundle cannot import ${args.path}; use the service contract`)
    }) } }],
  })
}
