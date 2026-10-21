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

/** Self-contained document: no application render, fonts, images, analytics or DB. */
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
<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;font:17px/1.6 system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:680px;margin:10vh auto;padding:28px}header{font-weight:750}h1{font-size:clamp(28px,6vw,42px);line-height:1.2}p{white-space:pre-wrap;overflow-wrap:anywhere}aside{border:1px solid GrayText;border-radius:12px;padding:20px;margin:24px 0}button,a{font:inherit;color:inherit}button{padding:10px 18px;cursor:pointer}small{display:block;margin-top:24px}li{margin:6px 0}</style></head><body><main><header>ManiCepte</header><h1 id="title">${escapeHtml(title)}</h1><p id="message">${escapeHtml(message)}</p><aside><strong>Hizmet durumu</strong><ul id="services">${status?.services.map((s) => `<li>${escapeHtml(SERVICES[s])}</li>`).join("") || "<li>Genel sistem</li>"}</ul><p id="eta">${status?.estimatedEnd ? `Tahmini bitiş: ${escapeHtml(new Date(status.estimatedEnd).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }))} (Türkiye saati)` : "Tahmini bitiş saati henüz paylaşılmadı."}</p></aside><p id="connection" role="status" aria-live="polite">Durum otomatik kontrol ediliyor.</p><button id="retry" type="button">Tekrar kontrol et</button><small>Hizmetler yeniden açıldığında otomatik yönlendirileceksin. Tahmini saat değişebilir.</small><noscript><p>Otomatik kontrol için JavaScript gerekli. Güncel durumu görmek için sayfayı yenile.</p></noscript></main>
<script>const config=${json(config)},labels=${json(MODES)},services=${json(SERVICES)};let busy=false,timer;
async function check(){if(busy)return;busy=true;clearTimeout(timer);try{const r=await fetch(config.statusUrl,{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error();const s=await r.json();if(!Object.hasOwn(labels,s.mode)||!Array.isArray(s.services))throw Error();
document.getElementById('title').textContent=labels[s.mode];document.getElementById('message').textContent=s.message||'Tüm hizmetler normal çalışıyor.';
const list=document.getElementById('services');list.replaceChildren();for(const key of s.services){if(!Object.hasOwn(services,key))throw Error();const li=document.createElement('li');li.textContent=services[key];list.append(li)}if(!s.services.length){const li=document.createElement('li');li.textContent='Genel sistem';list.append(li)}
document.getElementById('eta').textContent=s.estimatedEnd?'Tahmini bitiş: '+new Date(s.estimatedEnd).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'})+' (Türkiye saati)':'Tahmini bitiş saati henüz paylaşılmadı.';
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
