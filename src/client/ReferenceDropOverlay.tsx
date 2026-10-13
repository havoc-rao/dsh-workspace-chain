import { createPortal } from 'react-dom'
import { ReferenceIconRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReferenceTranslate } from './reference-locales.js'

// Core's image DropOverlay is private to ui-attachment, not a shared primitive.
// Keep its body-portal / pointer-transparent layout and semantic mask tokens,
// without importing another feature's runtime or its literal-color artwork.
export function ReferenceDropOverlay({ blocked, t }: { blocked: boolean; t: ReferenceTranslate }) {
  return createPortal(<div data-workspace-chain-reference-overlay="" role="status" aria-label={t('references')}
    style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', background: 'var(--dsw-alias-bg-mask-drop)', backdropFilter: 'blur(10px)' }}>
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '-3%', padding: '0 40px', color: 'var(--dsw-alias-label-primary)', textAlign: 'center' }}>
      <div aria-hidden="true" style={{ color: blocked ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-business-primary)', position: 'relative' }}>
        <ReferenceIconRegular kind="session" size={84} />
        {blocked && <svg width="32" height="32" viewBox="0 0 32 32" style={{ position: 'absolute', right: 0, bottom: 0, background: 'var(--dsw-alias-bg-base)', borderRadius: '50%' }}><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="3" /><path d="M7 7L25 25" stroke="currentColor" strokeWidth="3" /></svg>}
      </div>
      <div style={{ marginTop: 16, font: 'var(--dsw-font-l-20)' }}>{t(blocked ? 'blockedDrop' : 'dropHint')}</div>
      {!blocked && <div style={{ marginTop: 16, font: 'var(--dsw-font-s-14)', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'pre-wrap' }}>{t('dropDescription')}</div>}
    </div>
  </div>, document.body)
}
