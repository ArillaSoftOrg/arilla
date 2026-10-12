import Image from "next/image";
import styles from "./coming-soon.module.css";

type MascotPose = "welcome" | "research" | "compare" | "social";

const POSE_IMAGES: Record<
  MascotPose,
  { src: string; width: number; height: number; mobileSrc?: string }
> = {
  welcome: { src: "/mascot/guide/robot-welcome.png", width: 1254, height: 1254 },
  research: { src: "/mascot/guide/robot-research.png", width: 1254, height: 1254 },
  compare: { src: "/mascot/guide/robot-compare.png", width: 1254, height: 1254 },
  social: {
    src: "/mascot/guide/robot-social-point-v2.png",
    mobileSrc: "/mascot/guide/robot-social.png",
    width: 1536,
    height: 1024,
  },
};

export function MascotGuide({ pose, priority = false }: { pose: MascotPose; priority?: boolean }) {
  const image = POSE_IMAGES[pose];
  const imageProps = {
    alt: "",
    width: image.width,
    height: image.height,
    sizes: "(min-width: 1024px) 440px, (min-width: 640px) 360px, 220px",
    loading: priority ? ("eager" as const) : ("lazy" as const),
    fetchPriority: priority ? ("high" as const) : undefined,
  };

  return (
    <div className={styles.mascotGuide} data-mascot-guide="" data-pose={pose} aria-hidden="true">
      <picture>
        {image.mobileSrc ? <source media="(max-width: 639px)" srcSet={image.mobileSrc} /> : null}
        <Image {...imageProps} src={image.src} className={styles.guideImage} unoptimized />
      </picture>
    </div>
  );
}
