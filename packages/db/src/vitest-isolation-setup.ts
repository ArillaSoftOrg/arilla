/** vitest `setupFiles`: süreçteki bağlantı değişkenleri yerel değilse hiçbir test başlamaz. */
import { assertIsolatedTestEnv } from "./test-isolation.ts";

assertIsolatedTestEnv();
