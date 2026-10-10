// Minimal server-rendered pages. Mobile-first, light and dark.

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function page(title: string, body: string, opts: { wide?: boolean; script?: string } = {}): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f7f5f2;--card:#fff;--ink:#1d1b19;--muted:#6f6a64;--line:#e6e1da;--accent:#e2572b;--ok:#2f8f5b;--chip:#f1ede7}
@media (prefers-color-scheme:dark){:root{--bg:#141312;--card:#1e1c1a;--ink:#f2efea;--muted:#a49d94;--line:#34302c;--accent:#ff7a4d;--ok:#5cc38b;--chip:#2a2724}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",Segoe UI,Roboto,sans-serif}
main{max-width:${opts.wide ? "1280px" : "460px"};margin:0 auto;padding:28px 16px 48px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}p.sub{color:var(--muted);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin:0 0 12px}
.step{display:flex;gap:12px;align-items:flex-start}.num{flex:none;width:28px;height:28px;border-radius:50%;background:var(--chip);display:grid;place-items:center;font-weight:600;font-size:14px}
.done .num{background:var(--ok);color:#fff}.step h2{font-size:17px;margin:2px 0 6px}.step p{margin:0 0 10px;color:var(--muted);font-size:14px}
.btn{display:inline-block;border:0;border-radius:12px;padding:12px 16px;font:600 16px/1 inherit;background:var(--accent);color:#fff;text-decoration:none;cursor:pointer;width:100%;text-align:center}
.btn.secondary{background:var(--chip);color:var(--ink)}.row{display:flex;gap:8px}.row .btn{flex:1}
input,select{width:100%;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:16px inherit;margin:0 0 10px}
.muted{color:var(--muted);font-size:14px}.ok{color:var(--ok);font-weight:600}
</style></head><body><main>${body}</main>${opts.script ? `<script>${opts.script}</script>` : ""}</body></html>`;
}
