import { InstagramIcon, LinkedInIcon, TikTokIcon, XIcon } from "@arilla/ui";
import type { SocialNetwork } from "./site-config.ts";

export function SocialMediaIcon({ network, size = 28 }: { network: SocialNetwork; size?: number }) {
  switch (network) {
    case "instagram":
      return <InstagramIcon size={size} />;
    case "x":
      return <XIcon size={size} />;
    case "tiktok":
      return <TikTokIcon size={size} />;
    case "linkedin":
      return <LinkedInIcon size={size} />;
  }
}
