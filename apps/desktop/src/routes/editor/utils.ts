export function formatTime(secs: number) {
  const minutes = Math.floor(secs / 60);
  const seconds = Math.round(secs % 60);

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
