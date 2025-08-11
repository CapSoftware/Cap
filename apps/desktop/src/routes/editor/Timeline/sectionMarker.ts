import { SegmentRecordings, TimelineSegment } from "~/utils/tauri";

export type SectionMarker = { type: "reset" } | { type: "time"; time: number };

export function getSectionMarker(
  {
    segments,
    i,
    position,
  }: {
    segments: TimelineSegment[];
    i: number;
    position: "left" | "right";
  },
  recordings: SegmentRecordings[]
):
  | ({ type: "dual" } & (
      | { left: SectionMarker; right: null }
      | { left: null; right: SectionMarker }
      | { left: SectionMarker; right: SectionMarker }
    ))
  | { type: "single"; value: SectionMarker }
  | null {
  if (i === 0 && position === "left") {
    return segments[0].start === 0
      ? null
      : {
          type: "dual",
          right: { type: "time", time: segments[0].start },
          left: null,
        };
  }

  if (i === segments.length - 1 && position === "right") {
    const diff =
      recordings[segments[i].recordingSegment ?? 0].display.duration -
      segments[i].end;
    return diff > 0
      ? { type: "dual", left: { type: "time", time: diff }, right: null }
      : null;
  }

  if (position === "left") {
    const prevSegment = segments[i - 1];
    const prevSegmentRecordingDuration =
      recordings[prevSegment.recordingSegment ?? 0].display.duration;
    const nextSegment = segments[i];
    if (prevSegment.recordingSegment === nextSegment.recordingSegment) {
      const timeDiff = nextSegment.start - prevSegment.end;
      return {
        type: "single",
        value:
          timeDiff === 0 ? { type: "reset" } : { type: "time", time: timeDiff },
      };
    } else {
      const leftTime = prevSegmentRecordingDuration - prevSegment.end;
      const rightTime = nextSegment.start;

      const left = leftTime === 0 ? null : { type: "time", time: leftTime };
      const right = rightTime === 0 ? null : { type: "time", time: rightTime };

      if (left === null && right === null) return null;

      return { type: "dual", left, right } as any;
    }
  }

  return null;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("getSectionMarker", () => {
    it("playground", () => {
      const actual = getSectionMarker(
        {
          i: 1,
          position: "left",
          segments: [
            {
              recordingSegment: 0,
              timescale: 1,
              start: 0,
              end: 15.791211,
            },
            {
              recordingSegment: 1,
              timescale: 1,
              start: 0,
              end: 15.572943,
            },
          ],
        },
        [
          {
            display: {
              duration: 0.1,
              width: 2560,
              height: 1440,
              fps: 18,
              start_time: 0.23584246635437012,
            },
            camera: {
              duration: 15.791211,
              width: 1920,
              height: 1440,
              fps: 24,
              start_time: 0.117255542,
            },
            mic: {
              duration: 15.778333,
              sample_rate: 48000,
              channels: 1,
              start_time: 0.18319392204284668,
            },
            system_audio: {
              duration: 15.673,
              sample_rate: 48000,
              channels: 2,
              start_time: 0.25273895263671875,
            },
          },
          {
            display: {
              duration: 0.083333,
              width: 2560,
              height: 1440,
              fps: 12,
              start_time: 56.754987716674805,
            },
            camera: {
              duration: 15.582943,
              width: 1920,
              height: 1440,
              fps: 24,
              start_time: 56.615435542,
            },
            mic: {
              duration: 15.565,
              sample_rate: 48000,
              channels: 1,
              start_time: 56.69483804702759,
            },
            system_audio: {
              duration: 15.473,
              sample_rate: 48000,
              channels: 2,
              start_time: 56.75214147567749,
            },
          },
        ]
      );

      expect(actual).toEqual({
        type: "dual",
        left: { time: -15.691211000000001, type: "time" },
        right: null,
      });
    });
  });
}
