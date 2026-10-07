import { redirect } from "next/navigation";

/** `/sohbet` tek başına bir sayfa değildir; sohbetler ana sayfadaki kutudan başlar. */
export default function SohbetIndexPage(): never {
  redirect("/");
}
