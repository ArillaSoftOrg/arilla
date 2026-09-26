"use client";

import {
  type ConsentCategory,
  type CookieConsent,
  isConsentAllowed,
  needsConsentPrompt,
} from "@arilla/core/cookie-consent";
import {
  ConsentDialog,
  CookieBanner,
  CookieCategoryField,
  CookiePreferencesLayout,
  consentActionClassName,
  consentActionGroupClassName,
} from "@arilla/ui";
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
} from "react";
import {
  acceptAllCookiesAction,
  rejectAllCookiesAction,
  saveCookiePreferencesAction,
} from "./consent-actions.ts";
import { CONSENT_COPY, CONSENT_LINKS, COOKIE_PREFERENCES_HREF } from "./consent-copy.ts";

interface ConsentContextValue {
  consent: CookieConsent | null;
  openPreferences: () => void;
}

const ConsentContext = createContext<ConsentContextValue>({
  consent: null,
  openPreferences: () => {},
});

/**
 * Karar 0038: kok layout sunucuda okudugu tercihi verir; banner ilk HTML'de
 * render edilir (yanip sonme yok). Server action cerezi yazinca Next rotayi
 * yeniler ve `consent` yeni degerle gelir - istemci kendi kopyasini tutmaz.
 */
export function ConsentProvider({
  consent,
  children,
}: {
  consent: CookieConsent | null;
  children: ReactNode;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const openPreferences = useCallback(() => setPanelOpen(true), []);
  const value = useMemo(() => ({ consent, openPreferences }), [consent, openPreferences]);

  return (
    <ConsentContext.Provider value={value}>
      {children}
      {needsConsentPrompt(consent) ? <ConsentBannerClient onManage={openPreferences} /> : null}
      <ConsentDialog
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        title={CONSENT_COPY.panelTitle}
        description={CONSENT_COPY.panelDescription}
        closeLabel={CONSENT_COPY.close}
      >
        <CookiePreferencesClientForm consent={consent} onDone={() => setPanelOpen(false)} />
      </ConsentDialog>
    </ConsentContext.Provider>
  );
}

/**
 * Zorunlu olmayan her istemci teknolojisi (analitik, piksel, affiliate olcum
 * betigi) bu kapinin ARKASINDA mount edilir. Izin yoksa cocuklar hic render
 * edilmez; izin geri cekilince unmount olur ve yeni olay gonderilmez.
 */
export function ConsentGate({
  category,
  children,
}: {
  category: Exclude<ConsentCategory, "necessary">;
  children: ReactNode;
}) {
  const { consent } = useContext(ConsentContext);
  return isConsentAllowed(consent, category) ? children : null;
}

/** Footer'daki "Cerez Tercihleri": JS'le paneli acar, JS'siz /cerez#tercihler'e gider. */
export function CookiePreferencesLink({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const { openPreferences } = useContext(ConsentContext);
  return (
    <a
      href={COOKIE_PREFERENCES_HREF}
      className={className}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        openPreferences();
      }}
    >
      {children}
    </a>
  );
}

function ConsentBannerClient({ onManage }: { onManage: () => void }) {
  return (
    <CookieBanner
      title={CONSENT_COPY.bannerTitle}
      body={CONSENT_COPY.bannerBody}
      links={CONSENT_LINKS}
      linksLabel={CONSENT_COPY.linksLabel}
      actions={
        // Uc eylem ayni sinifta, esit agirlikta. Reddet/Kabul dogrudan server
        // action - JS'siz de calisir; Yonet JS'siz /cerez#tercihler'e duser.
        <form className={consentActionGroupClassName}>
          <button
            type="submit"
            formAction={rejectAllCookiesAction}
            className={consentActionClassName}
          >
            {CONSENT_COPY.rejectAll}
          </button>
          <a
            href={COOKIE_PREFERENCES_HREF}
            className={consentActionClassName}
            onClick={(event) => {
              event.preventDefault();
              onManage();
            }}
          >
            {CONSENT_COPY.manage}
          </a>
          <button
            type="submit"
            formAction={acceptAllCookiesAction}
            className={consentActionClassName}
          >
            {CONSENT_COPY.acceptAll}
          </button>
        </form>
      }
    />
  );
}

/**
 * Panel formu. Kayit bitince panel kapanir ve odak acan ogeye doner.
 * Zorunlu olmayan kutular mevcut tercihten gelir, tercih yoksa
 * kapali (legal pack 07: ilk yuklemede false).
 */
function CookiePreferencesClientForm({
  consent,
  onDone,
}: {
  consent: CookieConsent | null;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function run(action: (formData: FormData) => Promise<void>, formData: FormData) {
    startTransition(async () => {
      await action(formData);
      onDone();
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const intent = submitter instanceof HTMLButtonElement ? submitter.value : "save";
        const formData = new FormData(event.currentTarget);
        if (intent === "reject") run(() => rejectAllCookiesAction(), formData);
        else if (intent === "accept") run(() => acceptAllCookiesAction(), formData);
        else run(saveCookiePreferencesAction, formData);
      }}
    >
      <CookiePreferencesFields
        consent={consent}
        actions={
          <>
            <button
              type="submit"
              name="intent"
              value="reject"
              className={consentActionClassName}
              disabled={pending}
            >
              {CONSENT_COPY.rejectAll}
            </button>
            <button
              type="submit"
              name="intent"
              value="save"
              className={consentActionClassName}
              disabled={pending}
            >
              {CONSENT_COPY.save}
            </button>
            <button
              type="submit"
              name="intent"
              value="accept"
              className={consentActionClassName}
              disabled={pending}
            >
              {CONSENT_COPY.acceptAll}
            </button>
          </>
        }
      />
    </form>
  );
}

/** Panel ve /cerez#tercihler ortak kategori listesi. */
export function CookiePreferencesFields({
  consent,
  actions,
  status,
}: {
  consent: CookieConsent | null;
  actions: ReactNode;
  status?: string | null;
}) {
  return (
    <CookiePreferencesLayout
      status={status ?? null}
      actions={actions}
      categories={
        <>
          <CookieCategoryField
            name="necessary"
            title={CONSENT_COPY.necessaryTitle}
            body={CONSENT_COPY.necessaryBody}
            defaultChecked
            locked
            lockedLabel={CONSENT_COPY.alwaysOn}
          />
          <CookieCategoryField
            name="functional"
            title={CONSENT_COPY.functionalTitle}
            body={CONSENT_COPY.functionalBody}
            note={CONSENT_COPY.categoryUnused}
            defaultChecked={isConsentAllowed(consent, "functional")}
          />
          <CookieCategoryField
            name="analytics"
            title={CONSENT_COPY.analyticsTitle}
            body={CONSENT_COPY.analyticsBody}
            note={CONSENT_COPY.categoryUnused}
            defaultChecked={isConsentAllowed(consent, "analytics")}
          />
          <CookieCategoryField
            name="marketing"
            title={CONSENT_COPY.marketingTitle}
            body={CONSENT_COPY.marketingBody}
            note={CONSENT_COPY.categoryUnused}
            defaultChecked={isConsentAllowed(consent, "marketing")}
          />
        </>
      }
    />
  );
}

/**
 * /cerez#tercihler: JS'siz de calisan tercih formu. Uc dugme dogrudan server
 * action'a gider; kayit sonrasi sayfa yeni tercihle yeniden render edilir.
 */
export function CookiePreferencesPageForm({ consent }: { consent: CookieConsent | null }) {
  return (
    <form action={saveCookiePreferencesAction}>
      <CookiePreferencesFields
        consent={consent}
        actions={
          <>
            <button
              type="submit"
              formAction={rejectAllCookiesAction}
              className={consentActionClassName}
            >
              {CONSENT_COPY.rejectAll}
            </button>
            <button type="submit" className={consentActionClassName}>
              {CONSENT_COPY.save}
            </button>
            <button
              type="submit"
              formAction={acceptAllCookiesAction}
              className={consentActionClassName}
            >
              {CONSENT_COPY.acceptAll}
            </button>
          </>
        }
      />
    </form>
  );
}
