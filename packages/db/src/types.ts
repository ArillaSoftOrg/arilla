/**
 * Tip uretimi. Her tablonun okuma ve yazma tipi Drizzle'in `$inferSelect` /
 * `$inferInsert` cikarimindan uretilir — elle yazilmaz, sema degisince
 * kendiliginden degisir.
 *
 * `New*` tipleri INSERT icindir: DEFAULT'lu ve identity kolonlar opsiyoneldir.
 */
import type * as s from "./schema/index.ts";

// --- katalog ---
export type Merchant = typeof s.merchant.$inferSelect;
export type NewMerchant = typeof s.merchant.$inferInsert;
export type Brand = typeof s.brand.$inferSelect;
export type NewBrand = typeof s.brand.$inferInsert;
export type Category = typeof s.category.$inferSelect;
export type NewCategory = typeof s.category.$inferInsert;
export type Product = typeof s.product.$inferSelect;
export type NewProduct = typeof s.product.$inferInsert;
export type ProductSlugHistory = typeof s.productSlugHistory.$inferSelect;
export type NewProductSlugHistory = typeof s.productSlugHistory.$inferInsert;
export type Offer = typeof s.offer.$inferSelect;
export type NewOffer = typeof s.offer.$inferInsert;
export type OfferVariant = typeof s.offerVariant.$inferSelect;
export type NewOfferVariant = typeof s.offerVariant.$inferInsert;
export type VariantStockEvent = typeof s.variantStockEvent.$inferSelect;
export type NewVariantStockEvent = typeof s.variantStockEvent.$inferInsert;

// --- fiyat gecmisi ---
export type PricePoint = typeof s.pricePoint.$inferSelect;
export type NewPricePoint = typeof s.pricePoint.$inferInsert;
export type ProductPriceStats = typeof s.productPriceStats.$inferSelect;
export type NewProductPriceStats = typeof s.productPriceStats.$inferInsert;

// --- anlam katmani ---
export type Embedding = typeof s.embedding.$inferSelect;
export type NewEmbedding = typeof s.embedding.$inferInsert;
export type MatchCandidate = typeof s.matchCandidate.$inferSelect;
export type NewMatchCandidate = typeof s.matchCandidate.$inferInsert;
export type SimilarityEdge = typeof s.similarityEdge.$inferSelect;
export type NewSimilarityEdge = typeof s.similarityEdge.$inferInsert;
export type GeneratedContent = typeof s.generatedContent.$inferSelect;
export type NewGeneratedContent = typeof s.generatedContent.$inferInsert;

// --- kimlik ---
export type AppUser = typeof s.appUser.$inferSelect;
export type NewAppUser = typeof s.appUser.$inferInsert;
export type AuthToken = typeof s.authToken.$inferSelect;
export type NewAuthToken = typeof s.authToken.$inferInsert;
export type Session = typeof s.session.$inferSelect;
export type NewSession = typeof s.session.$inferInsert;

// --- creator ---
export type Creator = typeof s.creator.$inferSelect;
export type NewCreator = typeof s.creator.$inferInsert;
export type CreatorAffiliateAccount = typeof s.creatorAffiliateAccount.$inferSelect;
export type NewCreatorAffiliateAccount = typeof s.creatorAffiliateAccount.$inferInsert;
export type Collection = typeof s.collection.$inferSelect;
export type NewCollection = typeof s.collection.$inferInsert;
export type CollectionItem = typeof s.collectionItem.$inferSelect;
export type NewCollectionItem = typeof s.collectionItem.$inferInsert;
export type Follow = typeof s.follow.$inferSelect;
export type NewFollow = typeof s.follow.$inferInsert;
export type SavedItem = typeof s.savedItem.$inferSelect;
export type NewSavedItem = typeof s.savedItem.$inferInsert;
export type Alert = typeof s.alert.$inferSelect;
export type NewAlert = typeof s.alert.$inferInsert;

// --- attribution ve maliyet ---
export type Click = typeof s.click.$inferSelect;
export type NewClick = typeof s.click.$inferInsert;
export type Conversion = typeof s.conversion.$inferSelect;
export type NewConversion = typeof s.conversion.$inferInsert;
export type ApiUsage = typeof s.apiUsage.$inferSelect;
export type NewApiUsage = typeof s.apiUsage.$inferInsert;
export type IngestRun = typeof s.ingestRun.$inferSelect;
export type NewIngestRun = typeof s.ingestRun.$inferInsert;

// --- arama ---
export type QueryResolution = typeof s.queryResolution.$inferSelect;
export type NewQueryResolution = typeof s.queryResolution.$inferInsert;
export type Lexicon = typeof s.lexicon.$inferSelect;
export type NewLexicon = typeof s.lexicon.$inferInsert;

// --- kesif ---
export type ProductView = typeof s.productView.$inferSelect;
export type NewProductView = typeof s.productView.$inferInsert;
export type UserSizeProfile = typeof s.userSizeProfile.$inferSelect;
export type NewUserSizeProfile = typeof s.userSizeProfile.$inferInsert;
export type UserConsent = typeof s.userConsent.$inferSelect;
export type NewUserConsent = typeof s.userConsent.$inferInsert;
export type TrendSnapshot = typeof s.trendSnapshot.$inferSelect;
export type NewTrendSnapshot = typeof s.trendSnapshot.$inferInsert;
export type PublicFind = typeof s.publicFind.$inferSelect;
export type NewPublicFind = typeof s.publicFind.$inferInsert;
export type DiscoverySlot = typeof s.discoverySlot.$inferSelect;
export type NewDiscoverySlot = typeof s.discoverySlot.$inferInsert;
