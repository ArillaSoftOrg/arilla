#!/usr/bin/env node
/**
 * PR politikası (docs/decisions/0137). Bağımlılık kurmaz; yalnızca node ve GitHub REST API.
 *
 * Komutlar (GITHUB_TOKEN, GITHUB_REPOSITORY ortamdan):
 *   node scripts/pr-policy.mjs evaluate <pr>    risk + bağımlılık + onay -> `pr policy` durumu
 *   node scripts/pr-policy.mjs dependents <pr>  #<pr>'ye bağımlı açık PR'ları yeniden değerlendir
 *   node scripts/pr-policy.mjs merge-group <sha> <ref>  merge queue grubu için aynı karar
 *   node scripts/pr-policy.mjs sweep            açık PR'lar: yeniden değerlendir + çakışma raporu
 *
 * Güven modeli:
 * - Betik her zaman TABAN daldan (main) çalışır (`pull_request_target`); PR kendi kapısını
 *   değiştiremez. PR kodu checkout edilmez, çalıştırılmaz.
 * - Risk sınıflandırması deterministiktir (yol + eklenen satır kalıpları). Model/AI kararı
 *   kullanılmaz ve hiçbir AI çıktısı bu kapıyı geçemez.
 * - Yüksek riskli PR, yazma yetkili bir İNSANIN `risk-approved` etiketini SON push'tan sonra
 *   eklemesine kadar `failure` kalır; yeni push etiketi düşürür (iş akışı).
 * - Çakışmalar yalnızca RAPORLANIR (etiket + yorum); hiçbir şey otomatik birleştirilmez.
 */
import { pathToFileURL } from "node:url";

export const STATUS_CONTEXT = "pr policy";
export const APPROVAL_LABEL = "risk-approved";
export const RISK_LABELS = { high: "risk:high", low: "risk:low" };
export const CONFLICT_LABEL = "merge-conflict";
const POLICY_MARKER = "<!-- pr-policy -->";
const CONFLICT_MARKER = "<!-- pr-policy:conflict -->";

/** Yol kuralları: biri eşleşirse PR yüksek risklidir. Sıra rapordaki sıradır. */
export const PATH_RULES = [
  {
    id: "migration",
    label: "Şema / migration",
    re: /^(packages\/db\/(migrations|src\/schema|scripts)\/|docs\/schema\.sql$)/,
  },
  {
    id: "auth",
    label: "Kimlik doğrulama / yetkilendirme / RLS",
    re: /(^|\/)(auth|authz|session|sessions|permissions?|rbac|rls|admin|yonetim)(\/|[._-])|^apps\/web\/(middleware|proxy)\.ts$/i,
  },
  {
    id: "production-config",
    label: "Üretim yapılandırması / CI / dağıtım",
    re: /^(\.github\/|infra\/|scripts\/pr-policy|\.trivyignore$|\.dockerignore$|CLAUDE\.md$)|(^|\/)(Dockerfile|next\.config\.[cm]?[jt]s|vercel\.(json|ts)|compose[^/]*\.ya?ml|\.env[^/]*)$/,
  },
  {
    id: "dependencies",
    label: "Bağımlılıklar",
    re: /(^|\/)(package\.json|pnpm-lock\.yaml|pyproject\.toml|requirements[^/]*\.txt|uv\.lock)$/,
  },
  {
    id: "payment",
    label: "Ödeme / gelir / attribution",
    re: /(payment|payout|billing|invoice|commission|affiliate|attribution|tracking-links)/i,
  },
  {
    id: "data-deletion",
    label: "Veri silme / saklama",
    re: /(delete|purge|retention|cleanup|erase|anonymi[sz]e|kvkk)/i,
  },
  {
    id: "catalog-publish",
    label: "Ürün yayınlama / kritik katalog",
    re: /(publish|catalog|price[-_]point|similarity|offer)/i,
  },
];

/** Eklenen satırlarda yıkıcı SQL. */
const DESTRUCTIVE_SQL =
  /\b(DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|POLICY|TRIGGER|FUNCTION)|TRUNCATE\b|DELETE\s+FROM|ALTER\s+TABLE\s+\S+\s+DISABLE\s+ROW\s+LEVEL)/i;

export const LIMITS = { files: 60, lines: 1500, apiFiles: 3000 };

/**
 * @param {{filename: string, previous_filename?: string, additions?: number,
 *          deletions?: number, patch?: string}[]} files
 * @returns {{level: "high"|"low", reasons: {id: string, label: string, files: string[]}[]}}
 */
export function classify(files) {
  const reasons = [];
  const add = (id, label, file) => {
    let r = reasons.find((x) => x.id === id);
    if (!r) {
      r = { id, label, files: [] };
      reasons.push(r);
    }
    if (file && !r.files.includes(file)) r.files.push(file);
  };
  if (files.length === 0 || files.length >= LIMITS.apiFiles) {
    add("unknown", "Dosya listesi alınamadı ya da çok büyük (belirsizlikte yüksek risk)");
  }
  for (const f of files) {
    for (const name of [f.filename, f.previous_filename].filter(Boolean)) {
      // Salt dokümantasyon yolları (docs/schema.sql hariç) yalnızca içerik kuralına tabidir.
      const docOnly = /^docs\/.*\.md$|^[^/]+\.md$/.test(name) && name !== "CLAUDE.md";
      if (!docOnly) {
        for (const rule of PATH_RULES) if (rule.re.test(name)) add(rule.id, rule.label, name);
      }
    }
    const added = (f.patch ?? "")
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    if (
      /\.(sql|ts|tsx|mjs|js|py)$/.test(f.filename) &&
      added.some((l) => DESTRUCTIVE_SQL.test(l))
    ) {
      add("destructive-sql", "Yıkıcı SQL (DROP / TRUNCATE / DELETE FROM)", f.filename);
    }
  }
  const lines = files.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  if (files.length > LIMITS.files || lines > LIMITS.lines) {
    add("large", `Büyük değişiklik (${files.length} dosya, ${lines} satır)`);
  }
  return { level: reasons.length > 0 ? "high" : "low", reasons };
}

/**
 * PR gövdesindeki bağımlılık satırları: `Depends on #12`, `Bağımlı: #12, #13`, `Requires #12`.
 * @param {string | null | undefined} body
 * @returns {number[]}
 */
export function parseDependencies(body) {
  const out = new Set();
  for (const line of (body ?? "").split(/\r?\n/)) {
    if (!/^\s*(?:[-*]\s*)?(?:\*\*)?(depends on|bağımlı(?:lık)?|requires)(?=[\s:*]|$)/iu.test(line))
      continue;
    for (const m of line.matchAll(/#(\d+)\b/g)) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Onay geçerli mi: etiket var, son `labeled` olayını ekleyen bot değil, yazma yetkisi var,
 * (tanımlıysa) onaylayıcı listesinde.
 * @param {{labelPresent: boolean, actor?: {login: string, type: string} | null,
 *          permission?: string | null, approvers?: string[]}} a
 */
export function approvalValid({ labelPresent, actor, permission, approvers = [] }) {
  if (!labelPresent || !actor) return false;
  if (actor.type !== "User" || /\[bot\]$/.test(actor.login)) return false;
  if (!["admin", "maintain", "write"].includes(permission ?? "")) return false;
  if (approvers.length > 0 && !approvers.includes(actor.login.toLowerCase())) return false;
  return true;
}

/**
 * Durum kararı (saf). Bağımlılık açık / birleşmeden kapanmış -> failure; yüksek risk onaysız -> failure.
 * @param {{risk: ReturnType<typeof classify>, deps: {number: number, merged: boolean, state: string}[],
 *          approved: boolean}} a
 */
export function decide({ risk, deps, approved }) {
  const blocking = deps.filter((d) => !d.merged);
  if (blocking.length > 0) {
    const list = blocking.map(
      (d) => `#${d.number}${d.state === "closed" ? " (birleşmeden kapandı)" : ""}`,
    );
    return { state: "failure", description: `Bağımlılık birleşmedi: ${list.join(", ")}` };
  }
  if (risk.level === "high" && !approved) {
    return {
      state: "failure",
      description: `Yüksek risk (${risk.reasons.map((r) => r.id).join(", ")}): insan onayı gerekli (${APPROVAL_LABEL})`,
    };
  }
  if (risk.level === "high") {
    return { state: "success", description: "Yüksek risk, insan onaylı" };
  }
  return {
    state: "success",
    description: "Düşük risk: zorunlu kontrollerden sonra otomatik birleşebilir",
  };
}

// ---------------------------------------------------------------------------- GitHub API

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const REPO = process.env.GITHUB_REPOSITORY ?? "";

// PR_POLICY_DRY_RUN=1: yalnız okur; yazma isteklerini yazdırır (yerel simülasyon).
const DRY_RUN = process.env.PR_POLICY_DRY_RUN === "1";

async function gh(method, path, body) {
  if (DRY_RUN && method !== "GET") {
    console.log(`[dry-run] ${method} ${path} ${body ? JSON.stringify(body).slice(0, 300) : ""}`);
    return method === "POST" && path.endsWith("/labels") ? null : {};
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === "DELETE") return null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function paginate(path, max = 30) {
  const all = [];
  for (let page = 1; page <= max; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const items = await gh("GET", `${path}${sep}per_page=100&page=${page}`);
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

async function ensureLabel(name, color, description) {
  try {
    await gh("POST", `/repos/${REPO}/labels`, { name, color, description });
  } catch (e) {
    if (!String(e.message).includes("422")) throw e; // zaten var
  }
}

async function setLabels(number, current, add, remove) {
  for (const name of remove) {
    if (current.includes(name)) {
      await gh("DELETE", `/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(name)}`);
    }
  }
  const missing = add.filter((n) => !current.includes(n));
  if (missing.length > 0)
    await gh("POST", `/repos/${REPO}/issues/${number}/labels`, { labels: missing });
}

async function upsertComment(number, marker, body) {
  const comments = await paginate(`/repos/${REPO}/issues/${number}/comments`, 10);
  const mine = comments.find((c) => c.body?.startsWith(marker) && c.user?.type === "Bot");
  const full = `${marker}\n${body}`;
  if (mine) {
    if (mine.body !== full)
      await gh("PATCH", `/repos/${REPO}/issues/comments/${mine.id}`, { body: full });
  } else {
    await gh("POST", `/repos/${REPO}/issues/${number}/comments`, { body: full });
  }
}

async function approvalFor(number, labels) {
  const labelPresent = labels.includes(APPROVAL_LABEL);
  if (!labelPresent) return false;
  const events = await paginate(`/repos/${REPO}/issues/${number}/events`, 10);
  const last = events
    .filter((e) => e.event === "labeled" && e.label?.name === APPROVAL_LABEL)
    .at(-1);
  const actor = last?.actor ?? null;
  let permission = null;
  if (actor && actor.type === "User") {
    permission = (await gh("GET", `/repos/${REPO}/collaborators/${actor.login}/permission`))
      .permission;
  }
  const approvers = (process.env.RISK_APPROVERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return approvalValid({ labelPresent, actor, permission, approvers });
}

function report(pr, risk, deps, decision) {
  const lines = [
    `### PR politikası: **${decision.state === "success" ? "geçti" : "beklemede"}**`,
    "",
    `- Risk: **${risk.level === "high" ? "yüksek" : "düşük"}**`,
  ];
  for (const r of risk.reasons) {
    const shown = r.files.slice(0, 5).map((f) => `\`${f}\``);
    const more = r.files.length > 5 ? ` +${r.files.length - 5}` : "";
    lines.push(`  - ${r.label}${shown.length ? `: ${shown.join(", ")}${more}` : ""}`);
  }
  if (deps.length > 0) {
    lines.push(
      `- Bağımlılıklar: ${deps.map((d) => `#${d.number} ${d.merged ? "✓" : "✗"}`).join(", ")}`,
    );
  }
  if (pr.base.ref !== pr.base.repo.default_branch) {
    lines.push(
      `- Taban dal \`${pr.base.ref}\`: zincirli PR; taban birleşince GitHub hedefi değiştirir.`,
    );
  }
  lines.push(`- Durum: ${decision.description}`, "");
  if (risk.level === "high") {
    lines.push(
      `Yüksek riskli PR otomatik birleşmez. Yazma yetkili bir kişi değişikliği inceleyip \`${APPROVAL_LABEL}\` etiketini eklemelidir; yeni push etiketi düşürür. Ayrıntı: docs/decisions/0137.`,
    );
  } else {
    lines.push("Düşük risk: zorunlu kontroller geçince auto-merge / merge queue ile birleşebilir.");
  }
  return lines.join("\n");
}

/**
 * @param {number} number
 * @param {{statusSha?: string, sideEffects?: boolean}} [opts] merge queue: durum grup commit'ine
 *   yazılır, etiket/yorum yazılmaz.
 */
export async function evaluate(number, { statusSha, sideEffects = true } = {}) {
  const pr = await gh("GET", `/repos/${REPO}/pulls/${number}`);
  if (pr.state !== "open" && !statusSha) return null;
  const files = await paginate(`/repos/${REPO}/pulls/${number}/files`, 30);
  const risk = classify(files);
  const deps = [];
  for (const n of parseDependencies(pr.body)) {
    if (n === number) continue;
    try {
      const d = await gh("GET", `/repos/${REPO}/pulls/${n}`);
      deps.push({ number: n, merged: Boolean(d.merged_at), state: d.state });
    } catch {
      deps.push({ number: n, merged: false, state: "missing" });
    }
  }
  const labels = pr.labels.map((l) => l.name);
  const approved = risk.level === "high" ? await approvalFor(number, labels) : false;
  const decision = decide({ risk, deps, approved });

  await gh("POST", `/repos/${REPO}/statuses/${statusSha ?? pr.head.sha}`, {
    state: decision.state,
    context: STATUS_CONTEXT,
    description: decision.description.slice(0, 140),
    target_url: process.env.RUN_URL || undefined,
  });
  console.log(
    `#${number} ${(statusSha ?? pr.head.sha).slice(0, 12)} risk=${risk.level} -> ${decision.state}: ${decision.description}`,
  );
  if (!sideEffects) return { risk, deps, decision };
  await setLabels(
    number,
    labels,
    [RISK_LABELS[risk.level]],
    Object.values(RISK_LABELS).filter((l) => l !== RISK_LABELS[risk.level]),
  );
  const text = report(pr, risk, deps, decision);
  await upsertComment(number, POLICY_MARKER, text);
  return { risk, deps, decision, text };
}

/**
 * Merge queue grubu: `gh-readonly-queue/<taban>/pr-<n>-<sha>` -> aynı karar, grup commit'ine.
 * Kuyruktaki her PR kendi grubunda yeniden denetlenir (ör. bağımlılığı hâlâ birleşmemişse düşer).
 */
export async function mergeGroup(sha, headRef) {
  const m = /\/pr-(\d+)-[0-9a-f]{40}$/.exec(headRef ?? "");
  if (!m || !/^[0-9a-f]{40}$/.test(sha ?? ""))
    throw new Error(`merge group ref tanınmadı: ${headRef}`);
  return evaluate(Number(m[1]), { statusSha: sha, sideEffects: false });
}

export async function dependents(number) {
  const open = await paginate(`/repos/${REPO}/pulls?state=open`, 10);
  for (const pr of open) {
    if (parseDependencies(pr.body).includes(number)) await evaluate(pr.number);
  }
}

async function mergeableOf(number) {
  for (let i = 0; i < 4; i++) {
    const pr = await gh("GET", `/repos/${REPO}/pulls/${number}`);
    if (pr.mergeable !== null) return pr;
    await new Promise((r) => setTimeout(r, 5000)); // GitHub arka planda hesaplıyor
  }
  return null;
}

export async function sweep() {
  await ensureLabel(
    CONFLICT_LABEL,
    "b60205",
    "main ile çakışma: elle çözülmeli (docs/decisions/0137)",
  );
  const open = await paginate(`/repos/${REPO}/pulls?state=open`, 10);
  const conflicts = [];
  for (const { number } of open) {
    const pr = await mergeableOf(number);
    if (!pr) continue;
    const labels = pr.labels.map((l) => l.name);
    if (pr.mergeable === false) {
      conflicts.push(number);
      if (!labels.includes(CONFLICT_LABEL)) {
        await setLabels(number, labels, [CONFLICT_LABEL], []);
        await upsertComment(
          number,
          CONFLICT_MARKER,
          `\`${pr.base.ref}\` ile çakışma var. Otomatik çözülmez: dalı yerelde \`git fetch origin && git merge origin/${pr.base.ref}\` (ya da rebase) ile güncelleyip çakışmayı inceleyerek çözün ve push edin. Çakışma giderilince bu etiket kendiliğinden kalkar.`,
        );
      }
    } else if (labels.includes(CONFLICT_LABEL)) {
      await setLabels(number, labels, [], [CONFLICT_LABEL]);
    }
    await evaluate(number);
  }
  console.log(
    `açık PR: ${open.length}, çakışmalı: ${conflicts.map((n) => `#${n}`).join(", ") || "yok"}`,
  );
}

async function main() {
  const [cmd, arg, arg2] = process.argv.slice(2);
  if (!process.env.GITHUB_TOKEN || !REPO)
    throw new Error("GITHUB_TOKEN ve GITHUB_REPOSITORY gerekli");
  await ensureLabel(RISK_LABELS.high, "d93f0b", "PR politikası: yüksek risk, insan onayı gerekli");
  await ensureLabel(RISK_LABELS.low, "0e8a16", "PR politikası: düşük risk");
  await ensureLabel(
    APPROVAL_LABEL,
    "5319e7",
    "Yüksek riskli PR insan tarafından incelendi (yeni push düşürür)",
  );
  const n = Number(arg);
  if (cmd === "evaluate" && n > 0) await evaluate(n);
  else if (cmd === "dependents" && n > 0) await dependents(n);
  else if (cmd === "merge-group") await mergeGroup(arg, arg2);
  else if (cmd === "sweep") await sweep();
  else {
    throw new Error(
      "kullanım: pr-policy.mjs evaluate <pr> | dependents <pr> | merge-group <sha> <ref> | sweep",
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
