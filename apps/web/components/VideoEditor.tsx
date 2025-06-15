"use client";

import { useRef, useState } from "react";
import { Button } from "@cap/ui";
import {
  getVideoReplacePresignedUrl,
  restartVideoTranscription,
} from "@/actions/videos/replace";
import * as MediaParser from "@remotion/media-parser";
import * as WebCodecs from "@remotion/webcodecs";

interface Segment {
  start: number;
  end: number;
  speed: number;
}

export function VideoEditor({
  videoId,
  playlistUrl,
}: {
  videoId: string;
  playlistUrl: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const initSegments = () => {
    const video = videoRef.current;
    if (!video) return;
    const d = video.duration;
    setSegments([{ start: 0, end: d, speed: 1 }]);
  };

  const splitAtCurrent = () => {
    const video = videoRef.current;
    if (!video) return;
    const time = video.currentTime;
    setSegments((prev) => {
      for (let i = 0; i < prev.length; i++) {
        const seg = prev[i];
        if (time > seg.start && time < seg.end) {
          const first = { start: seg.start, end: time, speed: seg.speed };
          const second = { start: time, end: seg.end, speed: seg.speed };
          return [...prev.slice(0, i), first, second, ...prev.slice(i + 1)];
        }
      }
      return prev;
    });
  };

  const removeSegment = (idx: number) => {
    setSegments((prev) => prev.filter((_, i) => i !== idx));
  };

  const changeSpeed = (idx: number, speed: number) => {
    setSegments((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, speed } : s))
    );
  };

  const generateEditedVideo = async () => {
    const controller = MediaParser.mediaParserController
      ? MediaParser.mediaParserController()
      : undefined;
    const clips: Blob[] = [];

    for (const seg of segments) {
      // WebCodecs API used for trimming and speeding segments
      const result = await WebCodecs.convertMedia({
        src: playlistUrl,
        startInSeconds: seg.start,
        endInSeconds: seg.end,
        playbackRate: seg.speed,
        controller: controller as any,
      } as any);
      const blob = await (result as any).save();
      clips.push(blob);
    }

    // Combine all edited clips back into one video
    const stitched = await (WebCodecs as any).concatVideos({ videos: clips });
    const finalBlob = await (stitched as any).save();
    return finalBlob as Blob;
  };

  const saveChanges = async () => {
    setProcessing(true);
    try {
      const blob = await generateEditedVideo();
      const presigned = await getVideoReplacePresignedUrl(videoId, {
        duration: Math.round(videoRef.current?.duration || 0),
      });
      const form = new FormData();
      Object.entries(presigned.fields).forEach(([k, v]) =>
        form.append(k, v as string)
      );
      form.append("file", blob);

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", presigned.url);
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error("upload failed"));
        xhr.onerror = () => reject(new Error("upload failed"));
        xhr.send(form);
      });

      setPreviewUrl(URL.createObjectURL(blob));
      await restartVideoTranscription(videoId);
      alert("Video saved and uploaded");
    } catch (err) {
      console.error(err);
      alert("Failed to save video");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-4">
      <video
        ref={videoRef}
        src={playlistUrl}
        controls
        onLoadedMetadata={initSegments}
        className="w-full rounded"
      />
      <div className="space-y-2">
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center space-x-2">
            <span>
              {seg.start.toFixed(2)}s - {seg.end.toFixed(2)}s
            </span>
            <input
              type="number"
              min={0.25}
              max={3}
              step={0.25}
              value={seg.speed}
              onChange={(e) => changeSpeed(i, parseFloat(e.target.value))}
              className="w-20 border rounded px-1"
            />
            <Button variant="white" onClick={() => removeSegment(i)}>
              Delete
            </Button>
          </div>
        ))}
      </div>
      <div className="space-x-2">
        <Button variant="white" onClick={splitAtCurrent}>
          Split at Current Time
        </Button>
        <Button variant="primary" onClick={saveChanges} disabled={processing}>
          {processing ? "Saving..." : "Save"}
        </Button>
      </div>
      {previewUrl && (
        <div>
          <p className="font-medium">Preview</p>
          <video src={previewUrl} controls className="w-full rounded" />
        </div>
      )}
    </div>
  );
}
