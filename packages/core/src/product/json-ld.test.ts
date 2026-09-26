import { describe, expect, it } from "vitest";
import { serializeJsonLd } from "./json-ld.ts";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe("serializeJsonLd", () => {
  it("merchant başlığındaki </script> etiketi kapatamaz", () => {
    const out = serializeJsonLd({ name: "Çanta</script><script>alert(1)</script>" });
    expect(out).not.toMatch(/[<>]/);
    expect(out.toLowerCase()).not.toContain("</script");
  });

  it("& ve U+2028/U+2029 kaçırılır", () => {
    const out = serializeJsonLd({ name: `A & B${LS}C${PS}D` });
    expect(out).not.toContain("&");
    expect(out).not.toContain(LS);
    expect(out).not.toContain(PS);
  });

  it("çıktı geçerli JSON'dur ve aynı değeri verir", () => {
    const value = { name: `<b>Ürün</b> & ${LS} ışık`, offers: [{ price: "1299.90" }] };
    expect(JSON.parse(serializeJsonLd(value))).toEqual(value);
  });
});
