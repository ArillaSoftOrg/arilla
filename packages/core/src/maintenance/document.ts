import { MODES, SERVICES, type SystemStatus, safeReturnPath } from "./policy.ts";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
function json(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Self-contained document: no application render, fonts, images, analytics or DB.
 * System colors provide native light/dark contrast without a remote theme dependency.
 */
export function maintenanceDocument(options: {
  status: SystemStatus | null;
  statusUrl?: string;
  returnPath?: string;
  appOrigin?: string;
  autoReturn?: boolean;
  recoveryUrl?: string;
}): string {
  const { status } = options;
  const config = {
    statusUrl: options.statusUrl ?? "/api/system-status",
    returnPath: safeReturnPath(options.returnPath),
    appOrigin: options.appOrigin ?? "",
    autoReturn: options.autoReturn ?? true,
    recoveryUrl: options.recoveryUrl ?? null,
  };
  const title = status ? MODES[status.mode] : "Sisteme şu anda ulaşılamıyor";
  const message =
    status?.message ||
    (status?.mode === "normal"
      ? "Tüm hizmetler normal çalışıyor."
      : "Bağlantıyı yeniden kontrol ediyoruz. Lütfen bu ekranı açık tut.");
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ManiCepte · Sistem durumu</title>
<style>
:root{color-scheme:light dark;--paper:Canvas;--ink:CanvasText;--surface:color-mix(in srgb,CanvasText 3%,Canvas);--line:color-mix(in srgb,CanvasText 15%,Canvas);--muted:color-mix(in srgb,CanvasText 65%,Canvas);--control:GrayText;--radius:20px}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 system-ui,-apple-system,sans-serif}button{font:inherit}svg{display:block;flex-shrink:0}.page{min-height:100svh;max-width:1120px;padding:32px;margin:auto;display:flex;flex-direction:column}.masthead{display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{display:flex;align-items:center;gap:10px;font-size:23px;font-weight:750;letter-spacing:-.7px}.brand-mark{display:grid;place-items:center;width:38px;height:38px;background:var(--ink);color:var(--paper);border-radius:12px;font-size:23px;font-weight:850}.page-label{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:8px}.page-label::before{content:"";width:6px;height:6px;background:var(--ink);border-radius:50%}.content{flex:1;display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);align-content:center;align-items:center;gap:72px;padding:64px 0}.hero{min-width:0}.symbol{display:grid;place-items:center;width:72px;height:72px;border:1px solid var(--line);border-radius:22px;background:var(--surface);font-size:32px;margin-bottom:28px}.eyebrow{margin:0 0 12px;color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.04em}h1{font-size:clamp(34px,4.5vw,56px);line-height:1.12;letter-spacing:-.045em;margin:0 0 24px;font-weight:650;overflow-wrap:anywhere}#message{font-size:17px;line-height:1.8;color:var(--muted);margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.return-note{display:flex;align-items:flex-start;gap:10px;margin:28px 0 0;padding-top:24px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}.return-note svg{margin-top:3px}.status-card{border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;min-width:0;background:var(--surface)}.card-head{padding:24px 28px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px}.card-head h2{margin:0;font-size:15px;font-weight:650}.live-label{border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:11px;white-space:nowrap;color:var(--muted)}.services{list-style:none;margin:0;padding:12px 28px}.services li{display:flex;align-items:center;gap:12px;padding:14px 0;font-size:14px;overflow-wrap:anywhere}.services li+li{border-top:1px solid var(--line)}.services li::before{content:"";width:7px;height:7px;flex-shrink:0;border:1.5px solid var(--muted);border-radius:50%}.eta-block{margin:0 28px;padding:22px 0 26px;border-top:1px solid var(--line)}.eta-label{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-bottom:8px}#eta{margin:0;font-size:15px;font-weight:550;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.eta-note{margin:6px 0 0;font-size:11px;color:var(--muted)}.footer{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:24px 0 0;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.connection{margin:0}.footer button{display:flex;align-items:center;justify-content:center;gap:9px;min-height:44px;padding:10px 16px;border:1px solid var(--control);border-radius:999px;background:var(--paper);color:var(--ink);cursor:pointer;white-space:nowrap;font-size:13px}.footer button:hover{background:var(--surface)}button:focus-visible{outline:2px solid var(--ink);outline-offset:4px}noscript p{padding:16px;border:1px solid var(--line);border-radius:12px}
@media(max-width:1023px){.content{gap:40px}}@media(max-width:639px){.page{padding:24px}.brand{font-size:21px}.page-label{font-size:11px}.content{grid-template-columns:1fr;gap:32px;padding:48px 0 32px}.symbol{width:60px;height:60px;margin-bottom:24px}.card-head{padding:20px}.services{padding:8px 20px}.eta-block{margin:0 20px;padding:18px 0 22px}.footer{flex-direction:column;align-items:stretch;gap:16px}.footer button{width:100%}.return-note{margin-top:24px}h1{max-width:15ch}}
</style></head><body><div class="page"><header class="masthead"><div class="brand"><span class="brand-mark" aria-hidden="true">M</span>ManiCepte</div><span class="page-label">Sistem durumu</span></header><main class="content"><section class="hero" aria-labelledby="title"><div class="symbol" id="symbol" aria-hidden="true">${status?.mode === "normal" ? "✓" : status?.mode === "planned" ? "◷" : status?.mode === "partial" ? "◐" : "Ⅱ"}</div><p class="eyebrow" id="intro">${status?.mode === "normal" ? "Her şey yolunda" : "Seni habersiz bırakmayalım"}</p><h1 id="title">${escapeHtml(title)}</h1><p id="message">${escapeHtml(message)}</p><p class="return-note"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></svg><span>${config.autoReturn ? "Hizmetler yeniden açıldığında kaldığın yere otomatik döneceksin. Bu ekranı açık tutabilirsin." : "Bu sayfa otomatik güncellenir. Güncel sistem durumunu buradan takip edebilirsin."}</span></p></section><aside class="status-card" aria-labelledby="services-heading"><div class="card-head"><h2 id="services-heading">Hizmet durumu</h2><span class="live-label">Otomatik güncellenir</span></div><ul class="services" id="services">${status?.services.map((s) => `<li>${escapeHtml(SERVICES[s])}</li>`).join("") || "<li>Genel sistem</li>"}</ul><div class="eta-block"><div class="eta-label"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Tahmini bitiş</div><p id="eta">${status?.estimatedEnd ? escapeHtml(new Date(status.estimatedEnd).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", dateStyle: "medium", timeStyle: "short" })) : "Henüz bir saat paylaşılmadı."}</p><p class="eta-note">Türkiye saati · Tahmini saat değişebilir.</p></div></aside></main><footer class="footer"><p class="connection" id="connection" role="status" aria-live="polite">Durum otomatik kontrol ediliyor.</p><button id="retry" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 5v6h-6"/><path d="M20 11a8 8 0 1 0-2 7"/></svg>Tekrar kontrol et</button></footer><noscript><p>Otomatik kontrol için JavaScript gerekli. Güncel durumu görmek için sayfayı yenile.</p></noscript></div>
<script>const config=${json(config)},labels=${json(MODES)},services=${json(SERVICES)};let busy=false,timer;
async function check(){if(busy)return;busy=true;clearTimeout(timer);try{const r=await fetch(config.statusUrl,{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error();const s=await r.json();if(!Object.hasOwn(labels,s.mode)||!Array.isArray(s.services))throw Error();
document.getElementById('title').textContent=labels[s.mode];document.getElementById('message').textContent=s.message||'Tüm hizmetler normal çalışıyor.';document.getElementById('symbol').textContent=s.mode==='normal'?'✓':s.mode==='planned'?'◷':s.mode==='partial'?'◐':'Ⅱ';document.getElementById('intro').textContent=s.mode==='normal'?'Her şey yolunda':'Seni habersiz bırakmayalım';
const list=document.getElementById('services');list.replaceChildren();for(const key of s.services){if(!Object.hasOwn(services,key))throw Error();const li=document.createElement('li');li.textContent=services[key];list.append(li)}if(!s.services.length){const li=document.createElement('li');li.textContent='Genel sistem';list.append(li)}
document.getElementById('eta').textContent=s.estimatedEnd?new Date(s.estimatedEnd).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul',dateStyle:'medium',timeStyle:'short'}):'Henüz bir saat paylaşılmadı.';
// Ask the same policy through the status endpoint; the standalone worker also supplies blocked.
const blocked=typeof s.blocked==='boolean'?s.blocked:s.mode==='maintenance'||s.mode==='partial';
if(config.autoReturn&&!blocked){if(config.recoveryUrl){const health=await fetch(config.recoveryUrl,{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!health.ok)throw Error()}location.replace(config.appOrigin+config.returnPath);return}
document.getElementById('connection').textContent='Son kontrol: '+new Date().toLocaleTimeString('tr-TR');
}catch{document.getElementById('connection').textContent='Durum doğrulanamadı. Yeniden denenecek.'}finally{busy=false;timer=setTimeout(check,15000)}}
config.statusUrl+=(config.statusUrl.includes('?')?'&':'?')+'path='+encodeURIComponent(config.returnPath);document.getElementById('retry').addEventListener('click',check);check();</script></body></html>`;
}

export const MAINTENANCE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "retry-after": "30",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};
