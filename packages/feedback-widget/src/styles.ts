export const STYLE = `
:host{all:initial;--wf-accent:#4f46e5;--wf-accent-ink:#fff;--wf-bg:#fff;--wf-ink:#0f172a;--wf-muted:#64748b;--wf-line:#e2e8f0;--wf-soft:#f1f5f9;--wf-danger:#b91c1c;--wf-ok:#047857;--wf-shadow:0 12px 32px rgba(15,23,42,.18),0 2px 6px rgba(15,23,42,.08)}
@media (prefers-color-scheme:dark){:host{--wf-accent:#818cf8;--wf-accent-ink:#0b0b1a;--wf-bg:#18181b;--wf-ink:#f4f4f5;--wf-muted:#a1a1aa;--wf-line:#3f3f46;--wf-soft:#27272a;--wf-danger:#f87171;--wf-ok:#34d399}}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
button{font:inherit;cursor:pointer;border:0;background:none;color:inherit}
button:focus-visible,textarea:focus-visible{outline:2px solid var(--wf-accent);outline-offset:2px}
.launcher{position:fixed;z-index:2147483646;bottom:max(16px,env(safe-area-inset-bottom));min-width:48px;min-height:48px;padding:0 16px;border-radius:24px;background:var(--wf-accent);color:var(--wf-accent-ink);font-size:14px;font-weight:600;box-shadow:var(--wf-shadow);display:flex;align-items:center;gap:8px}
.launcher svg{width:20px;height:20px;flex:none}
.right .launcher{right:max(16px,env(safe-area-inset-right))}.left .launcher{left:max(16px,env(safe-area-inset-left))}
.panel{position:fixed;z-index:2147483647;bottom:calc(max(16px,env(safe-area-inset-bottom)) + var(--wf-kb,0px));width:360px;max-width:calc(100vw - 32px);max-height:calc(var(--wf-vh,100vh) - 32px);overflow:auto;background:var(--wf-bg);color:var(--wf-ink);border:1px solid var(--wf-line);border-radius:14px;box-shadow:var(--wf-shadow);padding:16px;display:flex;flex-direction:column;gap:12px;font-size:14px;line-height:1.4}
.right .panel{right:max(16px,env(safe-area-inset-right))}.left .panel{left:max(16px,env(safe-area-inset-left))}
.panel[hidden],.launcher[hidden],[hidden]{display:none!important}
@media (max-width:520px){.panel{left:0!important;right:0!important;bottom:var(--wf-kb,0px);width:100%;max-width:100%;border-radius:16px 16px 0 0;border-bottom:0;padding:16px max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}}
.head{display:flex;align-items:center;justify-content:space-between;gap:8px}
h2{margin:0;font-size:16px;font-weight:650}
.close{min-width:44px;min-height:44px;margin:-10px -10px -10px 0;border-radius:22px;font-size:22px;line-height:1;color:var(--wf-muted)}
label{font-size:13px;font-weight:600}
textarea{width:100%;min-height:96px;resize:vertical;border:1px solid var(--wf-line);border-radius:10px;padding:10px 12px;font-size:16px;line-height:1.4;color:var(--wf-ink);background:var(--wf-bg)}
textarea::placeholder{color:var(--wf-muted)}
.tools{display:flex;flex-wrap:wrap;gap:8px}
.tool{min-height:44px;padding:0 14px;border-radius:10px;border:1px solid var(--wf-line);background:var(--wf-soft);font-size:14px;font-weight:550;display:inline-flex;align-items:center;gap:6px}
.tool[aria-pressed=true]{border-color:var(--wf-accent);color:var(--wf-accent)}
.tool:disabled{opacity:.5;cursor:default}
.attachment{display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--wf-line);border-radius:10px}
.attachment img{width:72px;height:48px;object-fit:cover;border-radius:6px;background:var(--wf-soft)}
.attachment audio{flex:1;min-width:0;height:36px}
.attachment .grow{flex:1;min-width:0;font-size:13px;color:var(--wf-muted)}
.remove{min-width:44px;min-height:44px;border-radius:10px;color:var(--wf-muted);font-size:13px}
.recording{color:var(--wf-danger);font-variant-numeric:tabular-nums}
.privacy{margin:0;font-size:12px;color:var(--wf-muted)}
.status{margin:0;font-size:13px;min-height:18px}.status.error{color:var(--wf-danger)}.status.ok{color:var(--wf-ok)}
.send{min-height:48px;border-radius:12px;background:var(--wf-accent);color:var(--wf-accent-ink);font-size:15px;font-weight:650}
.send:disabled{opacity:.5;cursor:default}
`;
