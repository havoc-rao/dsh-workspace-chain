// Plugin-owned CSS, delivered inside both module-loader JS bundles. The
// namespaced selector avoids importing another feature's class or CSS runtime.
export function installWorkspaceReferenceStyle(): () => void {
  const style = document.createElement('style')
  style.dataset.workspaceChainReferenceStyle = ''
  style.textContent = workspaceReferenceStyle
  document.head.append(style)
  return () => style.remove()
}

export const workspaceReferenceStyle = `
[data-ref-chip="workspace"] {
  display: inline;
  max-width: 100%;
  margin: 0 2px;
  padding: 0 4px;
  border-radius: var(--dsw-radius-sm);
  line-height: inherit;
  vertical-align: baseline;
  color: var(--dsw-alias-state-business-primary);
  background: transparent;
  font-weight: 500;
  white-space: inherit;
  overflow-wrap: anywhere;
  text-align: inherit;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
[data-ref-chip="workspace"]:hover {
  background: var(--dsw-alias-state-business-tertiary);
}
`
