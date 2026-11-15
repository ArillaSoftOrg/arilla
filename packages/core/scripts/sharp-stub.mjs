// search-probe resim islemez. `sharp` yerel (native) bir modul: web imajinda /app/tools altindan
// cozulemedigi icin paket acilista dusuyordu ("Could not load the sharp module"). Probe paketi
// `--alias:sharp=./scripts/sharp-stub.mjs` ile bu saplamayi kullanir; cagrilirsa net hata verir.
export default function sharp() {
  throw new Error("sharp is not available in search-probe");
}
