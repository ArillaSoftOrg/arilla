/**
 * Is mantiginin tek yeri. `apps/web`, `apps/mcp` ve ileride `apps/api` bu
 * paketin ince istemcileridir; bir is kurali app klasorune yazilmaz.
 *
 * C1-C3'te `search`, `findAlternatives`, `compareMerchants` ve attribution
 * buradan disa aktarilacak.
 */

export { MIGRATIONS_DIR } from "@arilla/db";
export * from "./attribution/index.ts";
export * from "./product/index.ts";
export * from "./search/index.ts";
