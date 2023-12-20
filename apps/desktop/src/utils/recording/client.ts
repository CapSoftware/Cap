import {
  register,
  MediaRecorder as ExtendableMediaRecorder,
  IMediaRecorder,
} from "extendable-media-recorder";
import { ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { connect } from "extendable-media-recorder-wav-encoder";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { useDidMountEffect } from "@/utils/hooks/useDidMount";
import { writeBinaryFile, createDir } from "@tauri-apps/api/fs";
import { appDataDir } from "@tauri-apps/api/path";

export type ReactMediaRecorderRenderProps = {
  error: string;
  muteAudio: () => void;
  unMuteAudio: () => void;
  startRecording: () => void;
  pauseRecording: () => void;
  resumeRecording: () => void;
  stopRecording: () => void;
  mediaBlobUrl: undefined | string;
  status: StatusMessages;
  isAudioMuted: boolean;
  previewStream: MediaStream | null;
  previewAudioStream: MediaStream | null;
  clearBlobUrl: () => void;
};

export type ReactMediaRecorderHookProps = {
  audio?: boolean | MediaTrackConstraints;
  video?: boolean | MediaTrackConstraints;
  screen?: boolean;
  onStop?: (blobUrl: string, blob: Blob) => void;
  onStart?: () => void;
  blobPropertyBag?: BlobPropertyBag;
  mediaRecorderOptions?: MediaRecorderOptions | undefined;
  customMediaStream?: MediaStream | null;
  stopStreamsOnStop?: boolean;
  askPermissionOnMount?: boolean;
};
export type ReactMediaRecorderProps = ReactMediaRecorderHookProps & {
  render: (props: ReactMediaRecorderRenderProps) => ReactElement;
};

export type StatusMessages =
  | "media_aborted"
  | "permission_denied"
  | "no_specified_media_found"
  | "media_in_use"
  | "invalid_media_constraints"
  | "no_constraints"
  | "recorder_error"
  | "idle"
  | "acquiring_media"
  | "delayed_start"
  | "recording"
  | "stopping"
  | "stopped"
  | "paused";

export enum RecorderErrors {
  AbortError = "media_aborted",
  NotAllowedError = "permission_denied",
  NotFoundError = "no_specified_media_found",
  NotReadableError = "media_in_use",
  OverconstrainedError = "invalid_media_constraints",
  TypeError = "no_constraints",
  NONE = "",
  NO_RECORDER = "recorder_error",
}

export function useReactMediaRecorder({
  audio = true,
  video = false,
  onStop = () => null,
  onStart = () => null,
  blobPropertyBag,
  screen = false,
  mediaRecorderOptions = undefined,
  customMediaStream = null,
  stopStreamsOnStop = true,
  askPermissionOnMount = false,
}: ReactMediaRecorderHookProps): ReactMediaRecorderRenderProps {
  const mediaRecorder = useRef<IMediaRecorder | null>(null);
  const mediaChunks = useRef<Blob[]>([]);
  const mediaStream = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<StatusMessages>("idle");
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(false);
  const [mediaBlobUrl, setMediaBlobUrl] = useState<string | undefined>(
    undefined
  );
  const [error, setError] = useState<keyof typeof RecorderErrors>("NONE");

  const { selectedVideoDevice, selectedAudioDevice } = useMediaDevices();

  // We don't have a unmount / unregister for this so we need to use `useDidMountEffect`
  useDidMountEffect(() => {
    const setup = async () => {
      await register(await connect());
    };
    setup();
  }, []);

  const getMediaStream = useCallback(async () => {
    setStatus("acquiring_media");
    const videoDeviceId = selectedVideoDevice
      ? selectedVideoDevice.deviceId
      : undefined;
    const audioDeviceId = selectedAudioDevice
      ? selectedAudioDevice.deviceId
      : undefined;
    const requiredMedia: MediaStreamConstraints = {
      audio:
        typeof audio === "boolean"
          ? !!audio
            ? { deviceId: audioDeviceId }
            : false
          : audio,
      video:
        typeof video === "boolean"
          ? !!video
            ? { deviceId: videoDeviceId }
            : false
          : video,
    };

    try {
      if (customMediaStream) {
        mediaStream.current = customMediaStream;
      } else if (screen) {
        const stream = (await window.navigator.mediaDevices.getDisplayMedia({
          video: true,
        })) as MediaStream;
        stream.getVideoTracks()[0].addEventListener("ended", () => {
          stopRecording();
        });
        if (audio) {
          const audioStream = await window.navigator.mediaDevices.getUserMedia({
            audio,
          });

          audioStream
            .getAudioTracks()
            .forEach((audioTrack) => stream.addTrack(audioTrack));
        }
        mediaStream.current = stream;
      } else {
        const stream = await window.navigator.mediaDevices.getUserMedia(
          requiredMedia
        );
        mediaStream.current = stream;
      }
      setStatus("idle");
    } catch (error: any) {
      setError(error.name);
      setStatus("idle");
    }
  }, [audio, video, screen]);

  useEffect(() => {
    if (selectedVideoDevice || selectedAudioDevice || !customMediaStream) {
      getMediaStream();
    }
  }, [selectedVideoDevice, selectedAudioDevice]);

  useEffect(() => {
    if (!window.MediaRecorder) {
      throw new Error("Unsupported Browser");
    }

    if (screen) {
      if (!window.navigator.mediaDevices.getDisplayMedia) {
        throw new Error("This browser doesn't support screen capturing");
      }
    }

    const checkConstraints = (mediaType: MediaTrackConstraints) => {
      const supportedMediaConstraints =
        navigator.mediaDevices.getSupportedConstraints();
      const unSupportedConstraints = Object.keys(mediaType).filter(
        (constraint) =>
          !(supportedMediaConstraints as { [key: string]: any })[constraint]
      );

      if (unSupportedConstraints.length > 0) {
        console.error(
          `The constraints ${unSupportedConstraints.join(
            ","
          )} doesn't support on this browser. Please check your ReactMediaRecorder component.`
        );
      }
    };

    if (typeof audio === "object") {
      checkConstraints(audio);
    }
    if (typeof video === "object") {
      checkConstraints(video);
    }

    if (mediaRecorderOptions && mediaRecorderOptions.mimeType) {
      if (!MediaRecorder.isTypeSupported(mediaRecorderOptions.mimeType)) {
        console.error(
          `The specified MIME type you supplied for MediaRecorder doesn't support this browser`
        );
      }
    }

    if (!mediaStream.current && askPermissionOnMount) {
      getMediaStream();
    }

    return () => {
      if (mediaStream.current) {
        const tracks = mediaStream.current.getTracks();
        tracks.forEach((track) => track.clone().stop());
      }
    };
  }, [
    audio,
    screen,
    video,
    getMediaStream,
    mediaRecorderOptions,
    askPermissionOnMount,
  ]);

  // Media Recorder Handlers

  const startRecording = async () => {
    setError("NONE");
    if (!mediaStream.current) {
      await getMediaStream();
    }
    if (mediaStream.current) {
      const isStreamEnded = mediaStream.current
        .getTracks()
        .some((track) => track.readyState === "ended");
      if (isStreamEnded) {
        await getMediaStream();
      }

      // User blocked the permissions (getMediaStream errored out)
      if (!mediaStream.current.active) {
        return;
      }
      mediaRecorder.current = new ExtendableMediaRecorder(
        mediaStream.current,
        mediaRecorderOptions || undefined
      );
      mediaRecorder.current.ondataavailable = onRecordingActive;
      mediaRecorder.current.onstop = onRecordingStop;
      mediaRecorder.current.onstart = onRecordingStart;
      mediaRecorder.current.onerror = () => {
        setError("NO_RECORDER");
        setStatus("idle");
      };
      mediaRecorder.current.start();
      setStatus("recording");
    }
  };

  const onRecordingActive = ({ data }: BlobEvent) => {
    mediaChunks.current.push(data);
  };

  const onRecordingStart = () => {
    onStart();
  };

  const onRecordingStop = async () => {
    console.log("onRecordingStop started");
    const [chunk] = mediaChunks.current;
    const blobProperty: BlobPropertyBag = Object.assign(
      { type: chunk.type },
      blobPropertyBag || { type: "video/mp4" }
    );
    const blob = new Blob(mediaChunks.current, blobProperty);
    const buffer = await blob.arrayBuffer();
    const data = new Uint8Array(buffer);

    try {
      // Get the app's data directory path
      const dir = await appDataDir();
      const filePath = await recordingFileLocation();

      console.log("Saving recording to:", filePath);

      // Ensure the directory exists
      await createDir(dir, { recursive: true });

      // Write the file
      await writeBinaryFile(filePath, data);
      console.log("Recording saved successfully to:", filePath);

      // Generate a Blob URL for preview or download
      const url = URL.createObjectURL(blob);
      setStatus("stopped");
      setMediaBlobUrl(url);
      onStop(url, blob);
    } catch (error) {
      console.error("Failed to save recording:", error);
    }
  };

  const muteAudio = (mute: boolean) => {
    setIsAudioMuted(mute);
    if (mediaStream.current) {
      mediaStream.current
        .getAudioTracks()
        .forEach((audioTrack) => (audioTrack.enabled = !mute));
    }
  };

  const pauseRecording = () => {
    if (mediaRecorder.current && mediaRecorder.current.state === "recording") {
      setStatus("paused");
      mediaRecorder.current.pause();
    }
  };
  const resumeRecording = () => {
    if (mediaRecorder.current && mediaRecorder.current.state === "paused") {
      setStatus("recording");
      mediaRecorder.current.resume();
    }
  };

  const stopRecording = () => {
    if (mediaRecorder.current) {
      if (mediaRecorder.current.state !== "inactive") {
        setStatus("stopping");
        mediaRecorder.current.stop();
        if (stopStreamsOnStop) {
          mediaStream.current &&
            mediaStream.current.getTracks().forEach((track) => track.stop());
        }
        mediaChunks.current = [];
      }
    }
  };

  return {
    error: RecorderErrors[error],
    muteAudio: () => muteAudio(true),
    unMuteAudio: () => muteAudio(false),
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    mediaBlobUrl,
    status,
    isAudioMuted,
    previewStream: mediaStream.current
      ? new MediaStream(mediaStream.current.getVideoTracks())
      : null,
    previewAudioStream: mediaStream.current
      ? new MediaStream(mediaStream.current.getAudioTracks())
      : null,
    clearBlobUrl: () => {
      if (mediaBlobUrl) {
        URL.revokeObjectURL(mediaBlobUrl);
      }
      setMediaBlobUrl(undefined);
      setStatus("idle");
    },
  };
}

export const recordingFileLocation = async () => {
  const dir = await appDataDir();
  const filePath = `${dir}/recording.mp4`.replace(/\/\//g, "/");

  return filePath;
};

export const ReactMediaRecorder = (props: ReactMediaRecorderProps) =>
  props.render(useReactMediaRecorder(props));
