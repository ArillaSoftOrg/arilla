import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { Notice, PageHeader, Panel } from "../../admin-ui.tsx";
import { TrendFormClient } from "../trend-form-client.tsx";

/**
 * Yeni koleksiyon (karar 0149, `trends.manage`). Koleksiyon her zaman taslak oluşur;
 * ürünler ve yayın ayrıntı sayfasından yönetilir.
 */
export default async function NewTrendPage() {
  await requireCapability("trends.manage");
  return (
    <div className={styles.page}>
      <PageHeader
        title="Yeni koleksiyon"
        description="Taslak olarak oluşur; sitede görünmez. Ürünleri ekleyip yayına almak ayrıntı sayfasındadır."
        actions={<Link href="/yonetim/trendler">Trendlere dön</Link>}
      />
      <Panel id="ayrintilar" title="Ayrıntılar">
        <TrendFormClient mode="create" />
      </Panel>
      <Notice title="Kurallar">
        Adres oluşturduktan sonra değişmez. Elle seçilmiş koleksiyonun ürünlerini otomatik küratör
        değiştirmez. Yayın için en az 4 gösterilebilir (yayında, görselli, TL fiyatlı, stokta) ürün
        gerekir. Her işlem gerekçesiyle denetim kaydına yazılır.
      </Notice>
    </div>
  );
}
