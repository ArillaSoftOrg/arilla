import { describe, expect, it } from "vitest";
import {
  isLegalIdentityComplete,
  LEGAL_IDENTITY,
  type LegalIdentity,
  missingLegalIdentityFields,
} from "./legal-identity.ts";

const complete: LegalIdentity = {
  brandName: "Arilla",
  legalEntityName: "Unvan",
  legalAddress: "Adres",
  country: "Ülke",
  privacyEmail: "gizlilik@example.test",
  supportEmail: "destek@example.test",
  mersisNo: null,
  taxOfficeAndNo: null,
  tradeRegistryNo: null,
  phone: null,
};

describe("missingLegalIdentityFields", () => {
  it("zorunlu alanlar doluysa bos liste doner; istege bagli alanlar sayilmaz", () => {
    expect(missingLegalIdentityFields(complete)).toEqual([]);
    expect(isLegalIdentityComplete(complete)).toBe(true);
  });

  it("null ve yalnizca bosluk iceren degerleri eksik sayar", () => {
    expect(
      missingLegalIdentityFields({ ...complete, legalEntityName: null, legalAddress: "   " }),
    ).toEqual(["legalEntityName", "legalAddress"]);
  });

  it("repo degerleri uydurma icermez: dogrulanmamis kimlik alanlari null", () => {
    expect(LEGAL_IDENTITY.legalEntityName).toBeNull();
    expect(LEGAL_IDENTITY.legalAddress).toBeNull();
    expect(LEGAL_IDENTITY.phone).toBeNull();
    expect(isLegalIdentityComplete()).toBe(false);
    for (const value of Object.values(LEGAL_IDENTITY)) {
      if (typeof value === "string") expect(value).not.toMatch(/\{\{|TODO/);
    }
  });
});
