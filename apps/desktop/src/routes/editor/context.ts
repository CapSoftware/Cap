import { createElementBounds, NullableBounds } from "@solid-primitives/bounds";
import { createContextProvider } from "@solid-primitives/context";
import { trackStore } from "@solid-primitives/deep";
import { createEventListener } from "@solid-primitives/event-listener";
import { createUndoHistory } from "@solid-primitives/history";
import { debounce } from "@solid-primitives/scheduled";
import {
  Accessor,
  batch,
  createEffect,
  createResource,
  createSignal,
  on,
} from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";

import { createPresets } from "~/utils/createPresets";
import { createImageDataWS, createLazySignal } from "~/utils/socket";
import {
  commands,
  events,
  InstantRecordingMeta,
  MultipleSegments,
  RecordingMeta,
  SingleSegment,
  StudioRecordingMeta,
  type ProjectConfiguration,
  type SerializedEditorInstance,
  type XY,
} from "~/utils/tauri";

export type CurrentDialog =
  | { type: "createPreset" }
  | { type: "renamePreset"; presetIndex: number }
  | { type: "deletePreset"; presetIndex: number }
  | { type: "crop"; position: XY<number>; size: XY<number> }
  | { type: "export" };

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);

export const FPS = 60;

export const OUTPUT_SIZE = {
  x: 1920,
  y: 1080,
};

export const BACKGROUND_THEMES = {
  macOS: "macOS",
  dark: "Dark",
  blue: "Blue",
  purple: "Purple",
  orange: "Orange",
};

export const MAX_ZOOM_IN = 3;

export const [EditorContextProvider, useEditorContext] = createContextProvider(
  (props: {
    editorInstance: Omit<SerializedEditorInstance, "meta"> & {
      meta: TransformedMeta;
    };
  }) => {
    const editorInstanceContext = useEditorInstanceContext();
    const [project, setProject] = createStore<ProjectConfiguration>(
      props.editorInstance.savedProjectConfig
    );

    createEffect(
      on(
        () => {
          trackStore(project);
        },
        debounce(() => {
          commands.setProjectConfig(project);
        }),
        { defer: true }
      )
    );

    const [selectedTab, setSelectedTab] = createSignal<
      "background" | "camera" | "transcript" | "audio" | "cursor" | "hotkeys"
    >("background");

    //Background tabs
    const [backgroundTab, setBackgroundTab] =
      createSignal<keyof typeof BACKGROUND_THEMES>("macOS");

    const [dialog, setDialog] = createSignal<DialogState>({
      open: false,
    });

    const [previewTime, setPreviewTime] = createSignal<number>();
    const [playbackTime, setPlaybackTime] = createSignal<number>(0);
    const [playing, setPlaying] = createSignal(false);

    //Export states

    const [exportProgress, setExportProgress] = createSignal<{
      totalFrames: number;
      renderedFrames: number;
    } | null>(null);

    type ExportState =
      | { type: "idle" }
      | { type: "starting" }
      | { type: "rendering" }
      | { type: "saving"; done: boolean };

    type CopyState =
      | { type: "idle" }
      | { type: "starting" }
      | { type: "rendering" }
      | { type: "copying" }
      | { type: "copied" };

    const [exportState, setExportState] = createStore<ExportState>({
      type: "idle",
    });

    const [copyState, setCopyState] = createStore<CopyState>({
      type: "idle",
    });

    const [uploadState, setUploadState] = createStore<
      | { type: "idle" }
      | { type: "starting" }
      | { type: "rendering" }
      | { type: "uploading"; progress: number }
      | { type: "link-copied" }
      | { type: "complete" }
    >({ type: "idle" });

    // This is used in ShareButton.tsx to notify the component that the metadata has changed, from ExportDialog.tsx
    // When a video is uploaded, the metadata is updated

    const [lastMetaUpdate, setLastMetaUpdate] = createSignal<{
      videoId: string;
      timestamp: number;
    } | null>(null);

    const metaUpdateStore = {
      notifyUpdate: (videoId: string) => {
        setLastMetaUpdate({ videoId, timestamp: Date.now() });
      },
      getLastUpdate: lastMetaUpdate,
    };

    createEffect(
      on(playing, () => {
        if (!playing())
          commands.setPlayheadPosition(Math.floor(playbackTime() * FPS));
      })
    );

    const [split, setSplit] = createSignal(false);

    const totalDuration = () =>
      project.timeline?.segments.reduce(
        (acc, s) => acc + (s.end - s.start) / s.timescale,
        0
      ) ?? props.editorInstance.recordingDuration;

    type State = {
      zoom: number;
      position: number;
    };

    const zoomOutLimit = () => Math.min(totalDuration(), 60 * 10);

    function updateZoom(state: State, newZoom: number, origin: number): State {
      const zoom = Math.max(Math.min(newZoom, zoomOutLimit()), MAX_ZOOM_IN);

      const visibleOrigin = origin - state.position;

      const originPercentage = Math.min(1, visibleOrigin / state.zoom);

      const newVisibleOrigin = zoom * originPercentage;
      const newPosition = origin - newVisibleOrigin;

      return {
        zoom,
        position: newPosition,
      };
    }

    const [state, setState] = createStore({
      timelineSelection: null as null | { type: "zoom"; index: number },
      timelineTransform: {
        // visible seconds
        zoom: zoomOutLimit(),
        updateZoom(z: number, origin: number) {
          const { zoom, position } = updateZoom(
            {
              zoom: state.timelineTransform.zoom,
              position: state.timelineTransform.position,
            },
            z,
            origin
          );

          const transform = state.timelineTransform;
          batch(() => {
            setState("timelineTransform", "zoom", zoom);
            if (transform.zoom !== zoom) return;
            transform.setPosition(position);
          });
        },
        // number of seconds of leftmost point
        position: 0,
        setPosition(p: number) {
          setState(
            "timelineTransform",
            "position",
            Math.min(
              Math.max(p, 0),
              Math.max(zoomOutLimit(), totalDuration()) +
                4 -
                state.timelineTransform.zoom
            )
          );
        },
      },
    });

    return {
      ...editorInstanceContext,
      editorInstance: props.editorInstance,
      dialog,
      setDialog,
      project,
      setProject,
      selectedTab,
      backgroundTab,
      exportProgress,
      setExportProgress,
      copyState,
      setCopyState,
      uploadState,
      setUploadState,
      exportState,
      setExportState,
      setBackgroundTab,
      setSelectedTab,
      metaUpdateStore,
      lastMetaUpdate,
      setLastMetaUpdate,
      history: createStoreHistory(project, setProject),
      playbackTime,
      setPlaybackTime,
      playing,
      setPlaying,
      previewTime,
      setPreviewTime,
      split,
      setSplit,
      state,
      setState,
      totalDuration,
      zoomOutLimit,
    };
  },
  // biome-ignore lint/style/noNonNullAssertion: it's ok
  null!
);

export type FrameData = { width: number; height: number; data: ImageData };

function transformMeta(instance: SerializedEditorInstance) {
  if ("fps" in instance.meta) {
    throw new Error("Instant mode recordings cannot be edited");
  }

  let meta;

  if ("segments" in instance.meta) {
    meta = {
      ...instance.meta,
      type: "multiple",
    } as unknown as MultipleSegments & { type: "multiple" };
  } else {
    meta = {
      ...instance.meta,
      type: "single",
    } as unknown as SingleSegment & { type: "single" };
  }

  return { ...meta, prettyName: instance.meta.pretty_name };
}

export type TransformedMeta = ReturnType<typeof transformMeta>;

export const [EditorInstanceContextProvider, useEditorInstanceContext] =
  createContextProvider((props: { path: string }) => {
    const [latestFrame, setLatestFrame] = createLazySignal<{
      width: number;
      data: ImageData;
    }>();

    const [editorInstance] = createResource(async () => {
      const instance = await commands.createEditorInstance();

      const [_ws, isConnected] = createImageDataWS(
        instance.framesSocketUrl,
        setLatestFrame
      );

      createEffect(() => {
        if (isConnected()) {
          events.renderFrameEvent.emit({
            frame_number: Math.floor(0),
            fps: FPS,
            resolution_base: OUTPUT_SIZE,
          });
        }
      });

      return {
        ...instance,
        meta: transformMeta(instance),
      };
    });

    return {
      editorInstance,
      path: props.path,
      latestFrame,
      presets: createPresets(),
      prettyName: () => editorInstance()?.meta.prettyName ?? "Cap Recording",
    };
  }, null!);

function createStoreHistory<T extends Static>(
  ...[state, setState]: ReturnType<typeof createStore<T>>
) {
  // not working properly yet
  // const getDelta = captureStoreUpdates(state);

  const [pauseCount, setPauseCount] = createSignal(0);

  const history = createUndoHistory(() => {
    if (pauseCount() > 0) return;

    trackStore(state);

    const copy = structuredClone(unwrap(state));

    return () => setState(reconcile(copy));
  });

  createEventListener(window, "keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;

    switch (e.code) {
      case "KeyZ": {
        if (e.shiftKey) history.redo();
        else history.undo();
        break;
      }
      case "KeyY": {
        history.redo();
        break;
      }
      default: {
        return;
      }
    }

    e.preventDefault();
    e.stopPropagation();
  });

  return Object.assign(history, {
    pause() {
      setPauseCount(pauseCount() + 1);

      return () => {
        setPauseCount(pauseCount() - 1);
      };
    },
    isPaused: () => pauseCount() > 0,
  });
}

type Static<T = unknown> =
  | {
      [K in number | string]: T;
    }
  | T[];

export const [TimelineContextProvider, useTimelineContext] =
  createContextProvider(
    (props: {
      duration: number;
      secsPerPixel: number;
      timelineBounds: Readonly<NullableBounds>;
    }) => {
      return {
        duration: () => props.duration,
        secsPerPixel: () => props.secsPerPixel,
        timelineBounds: props.timelineBounds,
      };
    },
    null!
  );

export const [TrackContextProvider, useTrackContext] = createContextProvider(
  (props: { ref: Accessor<Element | undefined> }) => {
    const { state } = useEditorContext();

    const [trackState, setTrackState] = createStore({
      draggingSegment: false,
    });
    const bounds = createElementBounds(() => props.ref());

    const secsPerPixel = () =>
      state.timelineTransform.zoom / (bounds.width ?? 1);

    return {
      secsPerPixel,
      trackBounds: bounds,
      trackState,
      setTrackState,
    };
  },
  null!
);

export const [SegmentContextProvider, useSegmentContext] =
  createContextProvider((props: { width: Accessor<number> }) => {
    return props;
  }, null!);
