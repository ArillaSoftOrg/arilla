import {
  buildEmailPreviews,
  type EmailPreviewGroup,
  emailChannelStatus,
  getEmailSettingsForAdmin,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { Notice, PageHeader, Panel, StatusBadge } from "../admin-ui.tsx";
import { formatDateOrDash } from "../format.ts";
import { saveEmailSettingsAction } from "./actions.ts";

/**
 * E-posta ayarları (karar 0222, `email.manage`, yalnızca yönetici). Sunucu bileşeni: form onay
 * kutularıyla ve sunucu eylemiyle çalışır, istemci betiği yok. Önizleme e-posta göndermez ve
 * veritabanına dokunmaz; sandbox'lı iframe içinde örnek veriyle çizilir.
 */
const GROUP_LABELS: Record<EmailPreviewGroup, string> = {
  team: "Ekibe bildirim",
  visitor: "Ziyaretçiye onay",
  alert: "Alarm",
  account: "Hesap (her zaman açık)",
};

interface SwitchProps {
  name: string;
  checked: boolean;
  label: string;
  hint: string;
}

function SwitchRow({ name, checked, label, hint }: SwitchProps) {
  return (
    <label className={styles.switchRow}>
      <input type="checkbox" name={name} defaultChecked={checked} />
      <span className={styles.switchText}>
        <span>{label}</span>
        <span className={styles.meta}>{hint}</span>
      </span>
    </label>
  );
}

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; hata?: string; onizleme?: string }>;
}) {
  const { actor } = await requireCapability("email.manage");
  const params = await searchParams;
  const { settings, updatedAt } = await getEmailSettingsForAdmin(getDatabase(), actor);
  const channel = emailChannelStatus();
  const previews = buildEmailPreviews();
  const current = previews.find((preview) => preview.key === params.onizleme) ?? previews[0];

  return (
    <div className={styles.page}>
      <PageHeader
        title="E-posta ayarları"
        description="Formlardan gelen kayıtlar her zaman gelen kutusunda görünür. Burada bu kayıtlar ve mevcut e-postalar için e-posta gönderilip gönderilmeyeceğini seçersin. Kaydettiğin anda geçerli olur."
      />

      {params.ok ? <Notice tone="success">Ayarlar kaydedildi.</Notice> : null}
      {params.hata ? <Notice tone="error">{params.hata}</Notice> : null}

      {!channel.smtpConfigured || !channel.fromConfigured ? (
        <Notice tone="warning" title="E-posta servisi yapılandırılmamış">
          SMTP bağlantısı ya da gönderen adresi tanımlı değil; hiçbir e-posta gönderilemez. Ayarlar
          kaydedilir ama etkisi olmaz. Değişkenler dağıtım ortamından ayarlanır.
        </Notice>
      ) : (
        <Notice tone="info">
          E-posta servisi tanımlı. Seçili e-postalar, kaydettiğin anda gönderilmeye başlar.
        </Notice>
      )}
      {settings.teamNotifications && !channel.notifyConfigured ? (
        <Notice tone="warning" title="Ekip bildirim adresi yok">
          Ekibe bildirim açık ama alıcı adresi tanımlı ya da geçerli değil; bildirim gitmez.
        </Notice>
      ) : null}

      <form action={saveEmailSettingsAction} className={styles.formGrid}>
        <input type="hidden" name="form" value="email-settings" />
        <Panel
          id="ekip"
          title="Ekibe bildirim"
          description="Yeni iletişim mesajı ya da geri bildirim geldiğinde yönetici adresine kısa bir bildirim gider."
        >
          <SwitchRow
            name="teamNotifications"
            checked={settings.teamNotifications}
            label="Yeni mesaj ve geri bildirimde ekibe e-posta gönder"
            hint="Bildirimde gönderenin e-postası ve mesaj metni yer almaz: yalnızca konu, başlık ve gelen kutusu bağlantısı. Mesajı gelen kutusunda okursun."
          />
        </Panel>

        <Panel
          id="ziyaretci"
          title="Ziyaretçiye onay"
          description="Formu dolduran ve e-posta adresi bırakan kişiye “mesajını aldık” e-postası gider."
        >
          <SwitchRow
            name="visitorConfirmations"
            checked={settings.visitorConfirmations}
            label="Formu gönderen kişiye onay e-postası gönder"
            hint="Metin sabittir; kişinin yazdığı hiçbir şey e-postada tekrarlanmaz. Reklam içermez."
          />
        </Panel>

        <Panel
          id="mevcut"
          title="Mevcut e-postalar"
          description="Zaten çalışan e-postalar. Kapatınca gönderim durur, açınca kaldığı yerden sürer."
        >
          <SwitchRow
            name="priceAlerts"
            checked={settings.priceAlerts}
            label="Fiyat ve stok alarmı e-postaları"
            hint="Kapalıyken alarmlar tetiklenmez ve tüketilmez; açılınca koşulları hâlâ sağlıyorsa gönderilir."
          />
          <SwitchRow
            name="marketingEmails"
            checked={settings.marketingEmails}
            label="Pazarlama kampanyalarının toplu gönderimi"
            hint="Ek bir kapatma düğmesidir. Gönderim kapısını, üretim bayrağını ve kullanıcı izinlerini açmaz; bunlar aynen geçerlidir."
          />
          <p className={styles.muted}>
            Giriş, doğrulama ve şifre e-postaları{" "}
            <StatusBadge tone="neutral">Her zaman açık</StatusBadge> — kapatılırsa kullanıcılar
            hesaplarına giremez.
          </p>
        </Panel>

        <div>
          <button type="submit">Kaydet</button>
          <p className={styles.meta}>Son değişiklik: {formatDateOrDash(updatedAt)}</p>
        </div>
      </form>

      <Panel
        id="onizleme"
        title="E-posta önizleme"
        description="Gönderilebilecek e-postaların örnek verili görünümü. Buradan e-posta gönderilmez."
      >
        <ul className={styles.list}>
          {previews.map((preview) => (
            <li key={preview.key}>
              {preview.key === current?.key ? (
                <strong>{preview.label}</strong>
              ) : (
                <Link href={`/yonetim/eposta?onizleme=${preview.key}#onizleme`}>
                  {preview.label}
                </Link>
              )}{" "}
              <span className={styles.meta}>{GROUP_LABELS[preview.group]}</span>
            </li>
          ))}
        </ul>
        {current ? (
          <>
            <p className={styles.meta}>Konu: {current.mail.subject}</p>
            <iframe
              title="E-posta önizlemesi"
              className={styles.previewFrame}
              // Betik, form ve gezinme kapalı: içerik core'da kaçırılmış, örnek veriyle üretilmiş.
              sandbox=""
              srcDoc={current.mail.html}
            />
          </>
        ) : null}
      </Panel>
    </div>
  );
}
