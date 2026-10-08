import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  CHAT_UPLOAD_MAX_BYTES,
  cleanSubmissionText,
  prepareChatImage,
  startConversationFromSubmission,
} from "./submission.ts";

function upload(bytes: Buffer, type: string, size = bytes.byteLength) {
  return {
    type,
    size,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

async function jpeg(width = 1200, height = 800): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } })
    .jpeg()
    .toBuffer();
}

describe("cleanSubmissionText", () => {
  it("kırpar ve 500 karaktere sınırlar; metin olmayanı boş sayar", () => {
    expect(cleanSubmissionText("  siyah ayakkabı  ")).toBe("siyah ayakkabı");
    expect(cleanSubmissionText("a".repeat(900))).toHaveLength(500);
    expect(cleanSubmissionText(null)).toBe("");
    expect(cleanSubmissionText(42)).toBe("");
  });
});

describe("prepareChatImage", () => {
  it("geçerli görseli ≤512 px, EXIF'siz çıktıya çevirir", async () => {
    const source = await jpeg();
    const result = await prepareChatImage(upload(source, "image/jpeg"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.max(result.attachment.width, result.attachment.height)).toBeLessThanOrEqual(512);
    const meta = await sharp(result.attachment.bytes).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("EXIF/GPS içeren kaynak çıktıya taşınmaz", async () => {
    const withExif = await sharp(await jpeg())
      .withExif({ IFD0: { Copyright: "gizli" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const result = await prepareChatImage(upload(withExif, "image/jpeg"));
    expect(result.ok).toBe(true);
    if (result.ok) expect((await sharp(result.attachment.bytes).metadata()).exif).toBeUndefined();
  });

  it("desteklenmeyen biçim: invalid_type", async () => {
    const result = await prepareChatImage(upload(Buffer.from("GIF89a"), "image/gif"));
    expect(result).toEqual({ ok: false, status: "invalid_type" });
  });

  it("çok büyük dosya: too_large (içerik okunmaz)", async () => {
    let read = false;
    const big = {
      type: "image/jpeg",
      size: CHAT_UPLOAD_MAX_BYTES + 1,
      async arrayBuffer() {
        read = true;
        return new ArrayBuffer(0);
      },
    };
    expect(await prepareChatImage(big)).toEqual({ ok: false, status: "too_large" });
    expect(read).toBe(false);
  });

  it("boş ya da dosya olmayan girdi: invalid_input", async () => {
    expect(await prepareChatImage(upload(Buffer.alloc(0), "image/jpeg"))).toEqual({
      ok: false,
      status: "invalid_input",
    });
    expect(await prepareChatImage("foto")).toEqual({ ok: false, status: "invalid_input" });
    expect(await prepareChatImage(null)).toEqual({ ok: false, status: "invalid_input" });
  });

  it("bozuk görsel: unprocessable", async () => {
    const result = await prepareChatImage(upload(Buffer.from("bu bir resim degil"), "image/jpeg"));
    expect(result).toEqual({ ok: false, status: "unprocessable" });
  });
});

describe("startConversationFromSubmission: veritabanına gitmeden reddedilenler", () => {
  // db'ye dokunulursa test patlar: reddedilen girdiler hiçbir sorgu çalıştırmamalı.
  const db = new Proxy({}, { get: () => () => Promise.reject(new Error("db kullanılmamalı")) });

  it("metin de görsel de yoksa invalid_input", async () => {
    const result = await startConversationFromSubmission(db as never, { userId: 1, text: "  " });
    expect(result).toEqual({ status: "invalid_input" });
  });

  it("görsel reddedilirse sohbet oluşturulmaz (metin olsa bile)", async () => {
    const result = await startConversationFromSubmission(db as never, {
      userId: 1,
      text: "siyah ayakkabı",
      image: upload(Buffer.from("x"), "application/pdf"),
    });
    expect(result).toEqual({ status: "invalid_type" });
  });
});
