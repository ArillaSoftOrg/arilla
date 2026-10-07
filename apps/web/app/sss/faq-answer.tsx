import Link from "next/link";
import type { ReactNode } from "react";
import { FAQ_LINK_PATTERN } from "./faq-content.ts";

/** `[etiket](/yol)` bölümlerini site içi bağlantıya çevirir; geri kalan düz metin. */
function renderParagraph(paragraph: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of paragraph.matchAll(FAQ_LINK_PATTERN)) {
    const [whole, label, href] = match;
    const start = match.index ?? 0;
    if (start > last) nodes.push(paragraph.slice(last, start));
    nodes.push(
      <Link key={`${start}-${href}`} href={href ?? "/"}>
        {label}
      </Link>,
    );
    last = start + whole.length;
  }
  if (last < paragraph.length) nodes.push(paragraph.slice(last));
  return nodes;
}

export function FaqAnswer({ paragraphs }: { paragraphs: readonly string[] }) {
  return (
    <>
      {paragraphs.map((paragraph) => (
        <p key={paragraph.slice(0, 32)}>{renderParagraph(paragraph)}</p>
      ))}
    </>
  );
}
