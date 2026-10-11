export type MascotStop = { x: number; y: number; size: number; scroll: number };
type MascotPose = Omit<MascotStop, "scroll"> & { rotation: number };

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const mix = (start: number, end: number, progress: number) => start + (end - start) * progress;

/** Hold at each scene; use the middle of the scroll interval for the hop. */
export function mascotPoseAt(stops: readonly MascotStop[], scroll: number): MascotPose {
  const first = stops[0];
  if (!first) return { x: 0, y: 0, size: 0, rotation: 0 };
  const nextIndex = stops.findIndex((stop) => stop.scroll > scroll);
  const from = stops[Math.max(0, nextIndex - 1)] ?? first;
  const last = stops[stops.length - 1] ?? first;
  if (nextIndex < 0) return { ...last, rotation: 0 };
  const to = stops[nextIndex] ?? from;
  const interval = Math.max(1, to.scroll - from.scroll);
  const phase = clamp(((scroll - from.scroll) / interval - 0.16) / 0.68);
  const eased = phase * phase * (3 - 2 * phase);
  const arc = Math.sin(Math.PI * phase);
  return {
    x: mix(from.x, to.x, eased),
    y: mix(from.y, to.y, eased) - arc * Math.min(64, from.size * 0.16),
    size: mix(from.size, to.size, eased),
    rotation: Math.sin(2 * Math.PI * phase) * 5,
  };
}
