import { joinClassNames } from "./layout.ts";
import styles from "./SearchConversationNotice.module.css";

/**
 * Konusmali aramada serbest yanitin sonucunu durustce soyleyen not
 * (docs/decisions/0030): "Bunu aramaya nasıl uygulayacağımı anlayamadım."
 * Yanit hicbir zaman sessizce yutulmaz; kullaniciya ne oldugu ve ne
 * yapabilecegi soylenir.
 *
 * Erisilebilirlik: not odaklanabilir (`tabIndex={-1}`); sayfa, yanittan
 * sonra odagi buraya tasir ve ekran okuyucu metni okur. Eylemler dogal
 * `<a>`'dir, JS gerektirmez. Durum renkle degil, metin ve kenar ile anlatilir.
 */
export interface SearchConversationNoticeAction {
  label: string;
  href: string;
}

export interface SearchConversationNoticeProps {
  id: string;
  message: string;
  detail?: string;
  actions?: readonly SearchConversationNoticeAction[];
  className?: string;
}

export function SearchConversationNotice({
  id,
  message,
  detail,
  actions = [],
  className,
}: SearchConversationNoticeProps) {
  return (
    <div id={id} tabIndex={-1} className={joinClassNames(styles.notice, className)}>
      <p className={styles.message}>{message}</p>
      {detail ? <p className={styles.detail}>{detail}</p> : null}
      {actions.length > 0 ? (
        // biome-ignore lint/a11y/noRedundantRoles: list-style: none WebKit'te liste rolunu dusurur.
        <ul className={styles.actions} role="list">
          {actions.map((action) => (
            <li key={action.href} className={styles.item}>
              <a href={action.href} className={styles.action}>
                {action.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
