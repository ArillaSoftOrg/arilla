import { describe, expect, it } from "vitest";
import { DEFAULT_CLARIFICATION_REGISTRY } from "../clarification/rules.ts";
import type { ClarificationRegistry } from "../clarification/types.ts";
import {
  interpreterContractHash,
  QUERY_INTERPRETATION_MAX_PER_RUN,
  runQueryInterpretationBatch,
} from "./query-interpretation.ts";

describe("sozlesme ozeti", () => {
  it("deterministik, 64 haneli onaltilik", () => {
    const a = interpreterContractHash(DEFAULT_CLARIFICATION_REGISTRY);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(interpreterContractHash(DEFAULT_CLARIFICATION_REGISTRY)).toBe(a);
  });

  it("taksonomi etiketi degisince degisir", () => {
    const base = DEFAULT_CLARIFICATION_REGISTRY;
    const [first, ...rest] = base.domains;
    if (!first) throw new Error("taksonomi bos");
    const [facet, ...otherFacets] = first.facets;
    if (!facet) throw new Error("faset yok");
    const changed: ClarificationRegistry = {
      ...base,
      domains: [
        {
          ...first,
          facets: [{ ...facet, question: `${facet.question} (degisti)` }, ...otherFacets],
        },
        ...rest,
      ],
    };
    expect(interpreterContractHash(changed)).not.toBe(interpreterContractHash(base));
  });
});

describe("toplu is - istemci yok", () => {
  it("anahtar yoksa saglayici ve veritabani hic kullanilmaz", async () => {
    const untouchable = new Proxy(
      {},
      {
        get() {
          throw new Error("veritabani kullanilmamali");
        },
      },
    );
    // biome-ignore lint/suspicious/noExplicitAny: kasitli dokunulmaz sahte
    const result = await runQueryInterpretationBatch(untouchable as any, null);
    expect(result.status).toBe("skipped");
    expect(result.skippedReason).toBe("missing_api_key");
    expect(result.attempted).toBe(0);
    expect(result.providerCalls).toBe(0);
  });

  it("kosu basina tavan 20", () => {
    expect(QUERY_INTERPRETATION_MAX_PER_RUN).toBe(20);
  });
});
