import { notFound } from "next/navigation";

/**
 * `/sohbet` kök adresi yoktur (karar 0204): sohbet ve arama turu ana sayfada (`/?s=`, `/?q=`).
 * `/sohbet/link` ve `/sohbet/gorsel/[id]` ayrı yüzeyler olarak kalır; `/sohbet/misafir` `/?q=&g=1`e yönlenir.
 */
export default function RemovedSohbetRoot() {
  notFound();
}
