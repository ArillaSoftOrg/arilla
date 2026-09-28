/**
 * Proxy'nin `/yonetim/*` isteklerine yazdığı iç başlık: sunucu tarafında
 * (DAL) isteğin yolunu bilip yeniden girişte aynı sayfaya dönebilmek için.
 * İstemcinin gönderdiği aynı adlı başlık proxy'de ezilir.
 */
export const ADMIN_PATH_HEADER = "x-arilla-path";
