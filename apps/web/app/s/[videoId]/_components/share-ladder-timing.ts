// Longer than the slowest MP4 first frame measured (Safari at 1.6 Mbps,
// 8.7 s). At 2.5 s a 1.6 Mbps line switched before the MP4's own first frame
// and HLS then took longer to start, so the first frame got slower. Weak
// lines are left to the stall rule once a frame is on screen.
export const FIRST_FRAME_SWITCH_MS = 10_000;

export type ShareLadderStart = "framed" | "rescue";
