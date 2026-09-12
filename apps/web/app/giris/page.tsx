import { LoginFormClient } from "./login-form-client.tsx";

interface GirisSearchParams {
  error?: string;
}

const ERROR_COPY: Record<string, string> = {
  // docs/copy.md `auth.token_expired` / `auth.token_used`
  expired: "Bu bağlantının süresi dolmuş. Yeni bir tane isteyebilirsin.",
  used: "Bu bağlantı zaten kullanılmış.",
};

/** docs/routes.md `/giris`: e-posta bağlantısı isteme. `/giris/dogrula` başarısızlıkları buraya `?error=` ile döner. */
export default async function GirisPage({
  searchParams,
}: {
  searchParams: Promise<GirisSearchParams>;
}) {
  const { error } = await searchParams;
  const errorText = error ? ERROR_COPY[error] : undefined;

  return (
    <main style={{ padding: 24, display: "grid", gap: 16, maxWidth: 360 }}>
      <h1 style={{ margin: 0 }}>Giriş yap</h1>
      {errorText ? <p style={{ margin: 0, color: "var(--ink-muted)" }}>{errorText}</p> : null}
      <LoginFormClient />
    </main>
  );
}
