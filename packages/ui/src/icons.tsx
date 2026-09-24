import type { ReactNode } from "react";

export interface IconProps {
  className?: string;
  /** Piksel boyutu (genislik = yukseklik). Verilmezse ikonun varsayilani. */
  size?: number;
}

/**
 * CLAUDE.md: font/ikon ucuncu taraf CDN'den cekilmez - satir-ici SVG.
 * `currentColor` kullanir, tasiyici elementin `color`'undan miras alir.
 * Hepsi dekoratiftir (`aria-hidden`); erisilebilir isim tasiyici
 * dugmede/baglantida (`aria-label` veya gorunur metin) durur.
 */
function Svg({
  className,
  size,
  defaultSize,
  children,
}: IconProps & { defaultSize: number; children: ReactNode }) {
  const px = size ?? defaultSize;
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={px}
      height={px}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props} defaultSize={20}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/** Fotograf/gorsel yukleme aksiyonu icin - cok soyut bir "+" yerine
 * taninabilir bir resim cercevesi motifi. */
export function ImageIcon(props: IconProps) {
  return (
    <Svg {...props} defaultSize={20}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m4 17 5-5 3 3 4-4 4 4" />
    </Svg>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Svg {...props} defaultSize={18}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Svg>
  );
}

/** "Metinle ara" adimi icin - buyutec motifi. */
export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props} defaultSize={22}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m20 20-4.35-4.35" />
    </Svg>
  );
}

/** "Baglantiyla bul" adimi icin - zincir halkasi motifi. */
export function LinkIcon(props: IconProps) {
  return (
    <Svg {...props} defaultSize={22}>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 6.5 12.5 5a3.5 3.5 0 0 1 5 5L16 11.5" />
      <path d="M13 17.5 11.5 19a3.5 3.5 0 0 1-5-5L8 12.5" />
    </Svg>
  );
}

/** Kapatma (modal, panel, temizle). */
export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props} defaultSize={20}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

/** Satir sonu / "Tumunu gor" yonlendirmesi. */
export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg {...props} defaultSize={18}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  );
}

/** Yeni sekmede/magazada acilan dis baglanti. */
export function ExternalLinkIcon(props: IconProps) {
  return (
    <Svg {...props} defaultSize={16}>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Svg>
  );
}
