/**
 * Konusma durumu URL'de tasinir: `?q=kask&n=a~helmet_type~full_face&n=s~use_case`.
 * Durumun kendisi degil, girdi listesi tasinir; durum `replayConversation`
 * ile deterministik olarak yeniden kurulur. Boylece:
 *
 * - `localStorage`/`sessionStorage` gerekmez (CLAUDE.md).
 * - Sunucuda oturum durumu tutulmaz; link paylasilabilir ve geri tusu calisir.
 * - URL'e kisisel veri girmez: yalnizca secenek kimlikleri ve kullanicinin
 *   zaten arama kutusuna yazdigi turden kisa metinler.
 *
 * Ilk sorgu `q` parametresinde kalir; buradaki girdiler onun ardindan gelir.
 */
import type { ClarificationInput } from "./types.ts";

export const CONVERSATION_PARAM = "n";
/** Bir konusmada tutulan en fazla adim; uzun URL ve tekrar oynatma maliyeti sinirli. */
export const MAX_ENCODED_STEPS = 8;
export const MAX_FOLLOW_UP_TEXT_LENGTH = 120;

const ID_RE = /^[a-z0-9_]+$/;
const SEPARATOR = "~";

export function encodeInput(input: ClarificationInput): string {
  switch (input.type) {
    case "answer":
      return ["a", input.questionId, input.optionId].join(SEPARATOR);
    case "skip":
      return ["s", input.questionId].join(SEPARATOR);
    case "show_results":
      return "r";
    case "text":
      return `t${SEPARATOR}${input.text.trim().slice(0, MAX_FOLLOW_UP_TEXT_LENGTH)}`;
  }
}

/** Gecersiz parca sessizce atlanir; en fazla `MAX_ENCODED_STEPS` adim okunur. */
export function decodeInputs(values: readonly string[]): ClarificationInput[] {
  const inputs: ClarificationInput[] = [];
  for (const value of values) {
    if (inputs.length >= MAX_ENCODED_STEPS) break;
    const input = decodeInput(value);
    if (input !== null) inputs.push(input);
  }
  return inputs;
}

export function decodeInput(value: string): ClarificationInput | null {
  if (value === "r") return { type: "show_results" };
  const kind = value.slice(0, 2);
  const body = value.slice(2);
  if (kind === `t${SEPARATOR}`) {
    const text = body.trim().slice(0, MAX_FOLLOW_UP_TEXT_LENGTH);
    return text ? { type: "text", text } : null;
  }
  const parts = body.split(SEPARATOR);
  if (kind === `a${SEPARATOR}` && parts.length === 2) {
    const [questionId = "", optionId = ""] = parts;
    return ID_RE.test(questionId) && ID_RE.test(optionId)
      ? { type: "answer", questionId, optionId }
      : null;
  }
  if (kind === `s${SEPARATOR}` && parts.length === 1) {
    const [questionId = ""] = parts;
    return ID_RE.test(questionId) ? { type: "skip", questionId } : null;
  }
  return null;
}

/**
 * Bir sonraki adimin linki icin parametre listesi: mevcut adimlar + yeni
 * girdi. Sinir asilirsa son adim "sonuçları göster" olur; kullanici
 * sinira takilip bos bir linke dusmez, sonuclara gider.
 */
export function appendInput(
  existing: readonly ClarificationInput[],
  next: ClarificationInput,
): string[] {
  const steps = [...existing, next];
  if (steps.length > MAX_ENCODED_STEPS) {
    return [...existing.slice(0, MAX_ENCODED_STEPS - 1), { type: "show_results" } as const].map(
      encodeInput,
    );
  }
  return steps.map(encodeInput);
}
