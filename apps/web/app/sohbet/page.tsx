import { notFound } from "next/navigation";

/**
 * `/sohbet` kök adresi yoktur (karar 0204): sohbet ve arama turu ana sayfada (`/?s=`, `/?q=`).
 * `/sohbet/link`, `/sohbet/misafir` ve `/sohbet/gorsel/[id]` ayrı yüzeyler olarak kalır.
 */
export default function RemovedSohbetRoot() {
  notFound();
}
