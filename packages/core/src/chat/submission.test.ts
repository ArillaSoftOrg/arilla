import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CHAT_UPLOAD_MAX_BYTES, cleanSubmissionText, prepareChatImage } from "./submission.ts";

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

describe("prepareChatImage: çözmeden ÖNCE kullanıcı başı sınır (AI denetimi A12)", () => {
  function spyUpload(bytes: Buffer, type: string) {
    const calls = { arrayBuffer: 0 };
    return {
      calls,
      file: {
        type,
        size: bytes.byteLength,
        async arrayBuffer() {
          calls.arrayBuffer++;
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      },
    };
  }

  it("sınır dolduysa dosya okunmaz ve çözülmez (CPU/bellek harcanmaz)", async () => {
    const { calls, file } = spyUpload(await jpeg(), "image/jpeg");
    const result = await prepareChatImage(file, {
      userId: 7,
      consume: async () => ({ allowed: false, window: "hour" }),
    });
    expect(result).toEqual({ ok: false, status: "rate_limited" });
    expect(calls.arrayBuffer).toBe(0);
  });

  it("geçersiz tür ya da boyut sayaca hiç dokunmaz (ucuz kontroller önce)", async () => {
    let consumed = 0;
    const consume = async () => {
      consumed++;
      return { allowed: true } as const;
    };
    const bad = spyUpload(Buffer.from("x"), "application/pdf");
    expect(await prepareChatImage(bad.file, { userId: 7, consume })).toEqual({
      ok: false,
      status: "invalid_type",
    });
    const big = {
      type: "image/png",
      size: CHAT_UPLOAD_MAX_BYTES + 1,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
    expect(await prepareChatImage(big, { userId: 7, consume })).toEqual({
      ok: false,
      status: "too_large",
    });
    expect(consumed).toBe(0);
  });

  it("sınır içindeyse görsel işlenir ve sayaç kullanıcı başına bir kez harcanır", async () => {
    const seen: string[] = [];
    const { file } = spyUpload(await jpeg(), "image/jpeg");
    const result = await prepareChatImage(file, {
      userId: 7,
      consume: async (input) => {
        seen.push(`${input.pool}:${input.subject}`);
        return { allowed: true };
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["chat_message:img:7"]);
  });

  it("sayaç erişilemezse kullanıcı engellenmez (açık kalır)", async () => {
    const { file } = spyUpload(await jpeg(), "image/jpeg");
    const result = await prepareChatImage(file, {
      userId: 7,
      consume: async () => {
        throw new Error("redis yok");
      },
    });
    expect(result.ok).toBe(true);
  });

  it("userId verilmezse (eski çağrı biçimi) sayaç kullanılmaz", async () => {
    const { file } = spyUpload(await jpeg(), "image/jpeg");
    expect((await prepareChatImage(file)).ok).toBe(true);
  });
});
