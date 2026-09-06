/** Scoped styles use the same DSH surface tokens as enhanced-workspace rows. */
export const delegationStyle = `
.dsh-chain-task {
  --chain-muted: var(--ds-color-text-secondary, #85858b);
  --chain-border: var(--ds-color-border, rgba(128,128,128,.2));
  --chain-accent: var(--dsw-alias-state-business-primary, var(--ds-color-accent, #4c8dff));
  margin: 6px 0; min-width: 0; border: 1px solid var(--chain-border);
  border-radius: var(--dsw-row-radius, 8px); overflow: hidden;
  color: var(--ds-color-text-primary, inherit); font-size: 13px; line-height: 1.5;
}
.dsh-chain-task * { box-sizing: border-box; }
.dsh-chain-task .chain-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
.dsh-chain-task .chain-folder { display: flex; flex: none; color: var(--chain-muted); }
.dsh-chain-task .chain-project { min-width: 0; flex: 1; }
.dsh-chain-task .chain-name { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-chain-task .chain-path { display: block; color: var(--chain-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.dsh-chain-task .chain-status { display: inline-flex; align-items: center; gap: 5px; flex: none; color: var(--chain-muted); font-size: 11px; }
.dsh-chain-task .chain-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--chain-accent); }
.dsh-chain-task[data-state="complete"] .chain-dot { background: var(--ds-color-success, #4c9b76); }
.dsh-chain-task[data-state="error"] .chain-dot { background: var(--ds-color-error, #dc6060); }
.dsh-chain-task .chain-inspect { border: 0; border-radius: 4px; background: transparent; color: var(--chain-muted); padding: 3px 5px; cursor: pointer; font: inherit; font-size: 11px; }
.dsh-chain-task .chain-inspect:hover,
.dsh-chain-task summary:hover { background: var(--ds-color-hover, rgba(128,128,128,.08)); }
.dsh-chain-task .chain-inspect:focus-visible,
.dsh-chain-task summary:focus-visible { outline: 2px solid var(--chain-accent); outline-offset: -2px; }
.dsh-chain-task details { border-top: 1px solid var(--chain-border); }
.dsh-chain-task summary { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; list-style: none; user-select: none; }
.dsh-chain-task summary::-webkit-details-marker { display: none; }
.dsh-chain-task .chain-chevron { flex: none; color: var(--chain-muted); transition: transform 120ms ease; }
.dsh-chain-task details[open] > summary .chain-chevron { transform: rotate(90deg); }
.dsh-chain-task .chain-label { flex: none; font-size: 12px; color: var(--chain-muted); }
.dsh-chain-task .chain-preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dsh-chain-task details[open] .chain-preview { visibility: hidden; }
.dsh-chain-task .chain-content { margin: 0 12px 12px 25px; padding-left: 10px; border-left: 1px solid var(--chain-border); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow-y: auto; font: inherit; line-height: 1.65; }
.dsh-chain-task[data-state="error"] .chain-result .chain-label { color: var(--ds-color-error, #dc6060); }
.dsh-chain-task .chain-background { margin: 0; padding: 0 12px 10px 36px; color: var(--chain-muted); font-size: 12px; }
.dsh-chain-task .chain-record { margin: 0; padding: 0 12px 10px 36px; color: var(--chain-muted); font-size: 11px; overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .dsh-chain-task .chain-chevron { transition: none; } }
@media (max-width: 420px) { .dsh-chain-task .chain-head { flex-wrap: wrap; } .dsh-chain-task .chain-project { flex-basis: calc(100% - 28px); } .dsh-chain-task .chain-status { margin-left: 24px; } }
`
