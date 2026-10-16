/**
 * Dagitim ortami tespiti (docs/decisions/0109). Uretim kapilari (https zorunlu,
 * TLS Redis, pazarlama gonderimi, internet arama onayi, guvenlik basliklari)
 * bugune kadar yalnizca Vercel'in verdigi `VERCEL_ENV`/`VERCEL` degiskenlerine
 * bagliydi. Kendi sunucumuzda bu degiskenler yoktur; kapilar sessizce
 * kapanmasin diye ortam acikca `DEPLOY_ENV` ile bildirilir.
 *
 * - `DEPLOY_ENV=production`: VPS uretimi. Vercel degiskenlerinden bagimsiz.
 * - `VERCEL_ENV=production`: Vercel uretimi. Davranis aynen korunur.
 * - Digerleri (bos, `staging`, `development`, `preview`): uretim DEGIL.
 *
 * Saf fonksiyonlar; ortam testte parametre olarak verilir. `VERCEL`/`VERCEL_ENV`
 * okumalari Vercel'den ciktiktan sonra (karar 0109, faz 8) buradan silinir.
 */

export interface DeployEnv {
  readonly DEPLOY_ENV?: string | undefined;
  readonly VERCEL?: string | undefined;
  readonly VERCEL_ENV?: string | undefined;
  readonly [name: string]: string | undefined;
}

/** Uretim dagitimi mi: `DEPLOY_ENV=production` ya da `VERCEL_ENV=production`. */
export function isProductionDeploy(env: DeployEnv = process.env): boolean {
  return env.DEPLOY_ENV?.trim() === "production" || env.VERCEL_ENV?.trim() === "production";
}

/** Vercel uzerinde mi calisiyor (`VERCEL=1`). */
export function isVercelRuntime(env: DeployEnv = process.env): boolean {
  return env.VERCEL === "1";
}

/**
 * HTTPS ile servis edilen uretim mi (HSTS, `upgrade-insecure-requests`).
 * `next start`'i yerelde http uzerinden calistirmak (NODE_ENV=production,
 * DEPLOY_ENV/VERCEL yok) bunu tetiklemez.
 */
export function isHttpsProductionDeploy(env: DeployEnv = process.env): boolean {
  if (env.NODE_ENV !== "production") return false;
  return isVercelRuntime(env) || isProductionDeploy(env);
}
