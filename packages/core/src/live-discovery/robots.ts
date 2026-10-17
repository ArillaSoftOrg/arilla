/**
 * robots.txt ayristirma ve kural degerlendirme (RFC 9309).
 * Her istekten once `isAllowed` sorulur; izin yoksa istek atilmaz.
 */

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsRules {
  rules: RobotsRule[];
}

/** `agentToken` icin ozel grup varsa onu, yoksa `*` grubunu kullanir. */
export function parseRobots(text: string, agentToken: string): RobotsRules {
  type Group = { agents: string[]; rules: RobotsRule[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (value === "") continue; // bos Disallow: her sey serbest, kural uretmez
      current.rules.push({ allow: key === "allow", pattern: value });
    }
  }

  const token = agentToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  return { rules: chosen.flatMap((g) => g.rules) };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

/** `pathWithQuery`: "/yol?sorgu" bicimi. En uzun eslesme kazanir; esitlikte Allow. */
export function isAllowed(robots: RobotsRules, pathWithQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const rule of robots.rules) {
    if (!patternToRegex(rule.pattern).test(pathWithQuery)) continue;
    const len = rule.pattern.length;
    if (!best || len > best.len || (len === best.len && rule.allow)) {
      best = { len, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}
