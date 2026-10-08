/** `trend.slug` CHECK'iyle ayni bicim (0056): gecersiz adres DB'ye gitmeden 404. */
const TREND_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isTrendSlug(value: string): boolean {
  return value.length <= 80 && TREND_SLUG.test(value);
}
