import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * icon.svg ile ayni gecici "A" monogrami (Faz 7), iOS ana ekran ikonu icin
 * PNG. iOS koseleri kendisi yuvarlar, bu yuzden kare zemin. Renkler
 * tokens.css --ink / --paper ile ayni; ImageResponse CSS degiskeni
 * okuyamadigi icin burada tekrarlanir. Metin/font kullanilmaz - harf path.
 */
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#16181d",
      }}
    >
      <svg width="120" height="120" viewBox="0 0 32 32" aria-hidden="true">
        <path
          fill="#ffffff"
          fillRule="evenodd"
          d="M14.2 7h3.6l6.7 18h-3.7l-1.5-4.2h-6.6L11.2 25H7.5zm-.5 10.7h4.6L16 11.3z"
        />
      </svg>
    </div>,
    size,
  );
}
