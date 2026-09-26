import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { PageHeader } from "../admin-ui.tsx";
import { LookupFormClient } from "./lookup-form-client.tsx";

/**
 * Kullanıcı bulma (Faz 6). Yalnızca yönetici, yalnızca tam eşleşme; liste
 * ya da gezinme yok. Rol düzenleme, hesap silme ve kimliğe bürünme YOK
 * (docs/decisions/0039). Her arama ve görüntüleme denetim kaydına yazılır.
 */
export default async function UsersPage() {
  await requireCapability("users.read");
  return (
    <div className={styles.pageNarrow}>
      <PageHeader title="Kullanıcılar">
        <p className={styles.muted}>
          Destek için tek hesap bulma. Arama ve görüntüleme denetim kaydına yazılır; aranan değer
          yazılmaz.
        </p>
      </PageHeader>
      <LookupFormClient />
    </div>
  );
}
