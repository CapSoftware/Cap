export function formatTime(secs: number, fps?: number) {
  const minutes = Math.floor(secs / 60);
  const seconds = Math.floor(secs % 60);
  const frames = fps === undefined ? undefined : Math.floor((secs % 1) * fps);

  let str = `${minutes}:${seconds.toString().padStart(2, "0")}`;

  if (frames !== undefined) {
    str += `.${frames.toString().padStart(2, "0 ")}`;
  }

  return str;
}
