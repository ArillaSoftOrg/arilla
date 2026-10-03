import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { PageHeader } from "../../admin-ui.tsx";
import { FormEditorClient } from "../form-editor-client.tsx";

export default async function NewFormPage() {
  await requireCapability("forms.manage");
  return (
    <div className={styles.page}>
      <PageHeader title="Yeni form">
        <p className={styles.muted}>
          Form önce taslak olarak kaydedilir; yayınlayana kadar kimse göremez.
        </p>
      </PageHeader>
      <FormEditorClient
        mode="create"
        initial={{
          slug: "",
          title: "",
          description: "",
          audience: "public",
          kind: "survey",
          allowSkip: false,
          allowMultipleResponses: false,
          startsAt: "",
          endsAt: "",
          questions: [
            { label: "", description: "", type: "single_choice", required: false, options: "" },
          ],
        }}
      />
    </div>
  );
}
