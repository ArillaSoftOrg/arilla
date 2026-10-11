import Image from "next/image";
import styles from "./coming-soon.module.css";

/** Both pieces use the same image, so the resting silhouette stays unchanged. */
export function MascotPortrait({ first = false }: { first?: boolean }) {
  const imageProps = {
    src: "/mascot/hero/robot-idle.png",
    alt: "",
    width: 1024,
    height: 1024,
    sizes: "(min-width: 1024px) 520px, (min-width: 640px) 340px, 220px",
    loading: first ? ("eager" as const) : ("lazy" as const),
    fetchPriority: first ? ("high" as const) : undefined,
  };
  return (
    <div className={styles.mascotPortrait}>
      <Image {...imageProps} className={`${styles.mascotImage} ${styles.mascotBody}`} />
      <Image
        {...imageProps}
        className={`${styles.mascotImage} ${styles.mascotArm}`}
        data-mascot-arm=""
      />
    </div>
  );
}
