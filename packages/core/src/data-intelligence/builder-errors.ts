/** Veri zekâsı girdi hatası (geçersiz dönem, anahtar, tohum). Mesaj kullanıcıya gösterilebilir. */
export class DataIntelligenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataIntelligenceInputError";
  }
}
