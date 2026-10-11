/**
 * Gorselli sohbet turu 400 teshisi - sentetik gorsel, EN FAZLA 4 HTTP denemesi.
 * Kullanici gorseli, DB ve production verisi kullanilmaz. Anahtar yazdirilmaz.
 *
 *   GEMINI_API_KEY=<kendi anahtarin> pnpm gemini:image-smoke
 *
 * Senaryolar (gercek `GeminiChatInterpreter`): metin, gorsel+metin, yalniz gorsel; ayrica en kucuk
 * ham istek (sema ve system_instruction olmadan gorsel+metin). Yalniz durum ve deger yansitmayan
 * Google alanlari (status/reason/alan yolu) basilir.
 */
import sharp from "sharp";
import { GeminiChatInterpreter, type InterpretRequest } from "../src/chat/interpreter.ts";
import { clientErrorDetail, GEMINI_INTERACTIONS_URL, GeminiClient } from "../src/llm/gemini.ts";
import { GEMINI_MODEL } from "../src/llm/model.ts";

const key = process.env.GEMINI_API_KEY?.trim();
if (!key || key.length < 30) {
  process.stdout.write(
    "GEMINI_API_KEY tanimli degil ya da gecersiz gorunuyor; istek gonderilmedi.\n",
  );
  process.exit(2);
}

const jpeg = await sharp({
  create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 30, b: 30 } },
})
  .jpeg()
  .toBuffer();
const image = { mimeType: "image/jpeg" as const, dataBase64: jpeg.toString("base64") };

const base = (text: string, withImage: boolean): InterpretRequest => ({
  messages: [{ role: "user", kind: "text", text, ...(withImage ? { hasImage: true } : {}) }],
  currentIntent: null,
  pendingQuestion: null,
  clarifyCount: 0,
  input: { kind: "text", text },
  ...(withImage ? { image } : {}),
});

const interpreter = new GeminiChatInterpreter(new GeminiClient(key, { maxAttempts: 1 }));
const cases: [string, InterpretRequest][] = [
  ["yalniz metin", base("siyah spor ayakkabi", false)],
  ["gorsel + metin", base("bunun benzeri var mi", true)],
  ["yalniz gorsel", base("", true)],
];
for (const [name, request] of cases) {
  try {
    await interpreter.interpret(request);
    process.stdout.write(`${name}: OK\n`);
  } catch (error) {
    // `LlmError.message` yalniz sinif, HTTP kodu ve sabit alanlari tasir.
    process.stdout.write(`${name}: FAIL ${error instanceof Error ? error.message : "error"}\n`);
  }
}

// En kucuk ham istek: sema/system_instruction yok. Hata, istegin gorsel kismindan mi geliyor?
const raw = await fetch(GEMINI_INTERACTIONS_URL, {
  method: "POST",
  headers: { "content-type": "application/json", "x-goog-api-key": key },
  body: JSON.stringify({
    model: GEMINI_MODEL,
    input: [
      { type: "text", text: "Bu gorselde ne var? Tek kelime." },
      { type: "image", data: image.dataBase64, mime_type: image.mimeType },
    ],
    store: false,
  }),
});
const detail = raw.ok ? "" : ` ${(await clientErrorDetail(raw)) ?? ""}`;
process.stdout.write(`en kucuk ham gorsel+metin: HTTP ${raw.status}${detail}\n`);
