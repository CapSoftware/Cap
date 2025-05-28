import { For } from "solid-js";
import { useEditorContext } from "../context";
import { SegmentContent, SegmentRoot, TrackRoot, useSegmentContext } from "./Track";
import { useTimelineContext } from "./context";

export default function WaveformTrack() {
  const { project, micWaveforms } = useEditorContext();
  const { secsPerPixel } = useTimelineContext();

  const segments = () => project.timeline?.segments ?? [];

  return (
    <TrackRoot>
      <For each={segments()}>
        {(segment, i) => {
          const waveform = () => {
            const idx = segment.recordingSegment ?? i();
            return micWaveforms()?.[idx] ?? [];
          };

          return (
            <SegmentRoot segment={segment} innerClass="" class="border-transparent">
              <SegmentContent>
                <WaveformCanvas waveform={waveform()} segment={segment} secsPerPixel={secsPerPixel()} />
              </SegmentContent>
            </SegmentRoot>
          );
        }}
      </For>
    </TrackRoot>
  );
}

function WaveformCanvas(props: { waveform: number[]; segment: { start: number; end: number }; secsPerPixel: number }) {
  let canvas: HTMLCanvasElement | undefined;
  const { width } = useSegmentContext();

  const render = () => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = width();
    const h = canvas.height;
    canvas.width = w;
    ctx.clearRect(0, 0, w, h);

    const startIdx = Math.floor(props.segment.start * 10);
    const endIdx = Math.floor(props.segment.end * 10);
    const slice = props.waveform.slice(startIdx, endIdx);
    const step = slice.length > 0 ? w / slice.length : w;

    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < slice.length; i++) {
      const x = i * step;
      const v = slice[i];
      const y = (1 - v) * h;
      ctx.moveTo(x, h);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  render();

  return (
    <canvas
      ref={(el) => {
        canvas = el;
        render();
      }}
      class="w-full h-full"
      height={20}
    ></canvas>
  );
}
