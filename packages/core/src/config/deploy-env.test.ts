import { describe, expect, it } from "vitest";
import { isHttpsProductionDeploy, isProductionDeploy, isVercelRuntime } from "./deploy-env.ts";

describe("isProductionDeploy()", () => {
  it("DEPLOY_ENV=production uretimdir (Vercel degiskeni olmadan)", () => {
    expect(isProductionDeploy({ DEPLOY_ENV: "production" })).toBe(true);
    expect(isProductionDeploy({ DEPLOY_ENV: " production " })).toBe(true);
  });

  it("VERCEL_ENV=production uretimdir (mevcut Vercel davranisi)", () => {
    expect(isProductionDeploy({ VERCEL_ENV: "production" })).toBe(true);
  });

  it("bos, staging, development ve preview uretim degildir", () => {
    expect(isProductionDeploy({})).toBe(false);
    for (const value of ["", "staging", "development", "preview", "Production-ish"]) {
      expect(isProductionDeploy({ DEPLOY_ENV: value })).toBe(false);
    }
    expect(isProductionDeploy({ VERCEL_ENV: "preview" })).toBe(false);
  });

  it("DEPLOY_ENV=staging VERCEL_ENV=production'i gizlemez (Vercel kapisi kapanmaz)", () => {
    expect(isProductionDeploy({ DEPLOY_ENV: "staging", VERCEL_ENV: "production" })).toBe(true);
  });
});

describe("isVercelRuntime()", () => {
  it("yalnizca VERCEL=1", () => {
    expect(isVercelRuntime({ VERCEL: "1" })).toBe(true);
    expect(isVercelRuntime({ VERCEL: "0" })).toBe(false);
    expect(isVercelRuntime({})).toBe(false);
  });
});

describe("isHttpsProductionDeploy()", () => {
  it("Vercel'de NODE_ENV=production ise true (onceki davranis)", () => {
    expect(isHttpsProductionDeploy({ NODE_ENV: "production", VERCEL: "1" })).toBe(true);
  });

  it("VPS'te DEPLOY_ENV=production ile true", () => {
    expect(isHttpsProductionDeploy({ NODE_ENV: "production", DEPLOY_ENV: "production" })).toBe(
      true,
    );
  });

  it("yerel `next start` (http) true olmaz", () => {
    expect(isHttpsProductionDeploy({ NODE_ENV: "production" })).toBe(false);
    expect(isHttpsProductionDeploy({ NODE_ENV: "production", DEPLOY_ENV: "staging" })).toBe(false);
  });

  it("NODE_ENV=production olmadan hicbir zaman true degil", () => {
    expect(isHttpsProductionDeploy({ DEPLOY_ENV: "production", VERCEL: "1" })).toBe(false);
  });
});
