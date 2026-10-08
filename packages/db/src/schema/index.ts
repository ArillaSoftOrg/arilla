/**
 * Semanin TypeScript karsiligi. Dosya basina bir migration:
 * catalog↔0002, price↔0003, semantic↔0004, auth↔0005, creator↔0006,
 * attribution↔0007, search↔0008, discovery↔0009, user-intake↔0013,
 * admin↔0027, entitlement↔0034, marketing↔0035, activity↔0036,
 * search↔0040 (`search_query_day`), ops↔0041 (`job_run`),
 * search↔0044 (`query_interpretation`).
 * feedback↔0032, forms↔0043, chat↔0054 (+0055 `chat_result_feedback`, +0057 `chat_attachment`),
 * trends↔0056 (`trend`, `trend_product`).
 * 0036'nin `session` kolonlari auth.ts'de, 0037'nin `user_consent`
 * kolonlari discovery.ts'dedir.
 *
 * Bir migration degistiginde ayni adli dosya guncellenir. Uyumu
 * `pnpm db:verify` calistirarak kanitlar — elle yazilan semanin tek riski
 * sessiz kaymadir ve o betik onu yakalar.
 */

export * from "./activity.ts";
export * from "./admin.ts";
export * from "./attribution.ts";
export * from "./auth.ts";
export * from "./catalog.ts";
export * from "./chat.ts";
export * from "./creator.ts";
export * from "./discovery.ts";
export * from "./entitlement.ts";
export * from "./feedback.ts";
export * from "./forms.ts";
export * from "./marketing.ts";
export * from "./ops.ts";
export * from "./price.ts";
export * from "./search.ts";
export * from "./semantic.ts";
export * from "./trends.ts";
export * from "./user-intake.ts";
