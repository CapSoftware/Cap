import { createElementBounds, NullableBounds } from "@solid-primitives/bounds";
import { createContextProvider } from "@solid-primitives/context";
import { trackStore } from "@solid-primitives/deep";
import { createEventListener } from "@solid-primitives/event-listener";
import { createUndoHistory } from "@solid-primitives/history";
import { debounce } from "@solid-primitives/scheduled";
import { createQuery, skipToken } from "@tanstack/solid-query";
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
  FramesRendered,
  MultipleSegments,
  RecordingMeta,
  SingleSegment,
  type ProjectConfiguration,
  type SerializedEditorInstance,
  type XY,
} from "~/utils/tauri";
import { createProgressBar } from "./utils";

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

export const MAX_ZOOM_IN = 3;

export type RenderState =
  | { type: "starting" }
  | { type: "rendering"; progress: FramesRendered };

export const [EditorContextProvider, useEditorContext] = createContextProvider(
  (props: {
    meta: TransformedMeta;
    editorInstance: SerializedEditorInstance;
    refetchMeta(): Promise<void>;
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

    const [dialog, setDialog] = createSignal<DialogState>({
      open: false,
    });

    const [exportState, setExportState] = createStore<
      | { type: "idle" }
      | (
          | ({ action: "copy" } & (
              | RenderState
              | { type: "copying" }
              | { type: "done" }
            ))
          | ({ action: "save" } & (
              | RenderState
              | { type: "copying" }
              | { type: "done" }
            ))
          | ({ action: "upload" } & (
              | RenderState
              | { type: "uploading"; progress: number }
              | { type: "done" }
            ))
        )
    >({ type: "idle" });

    createProgressBar(() =>
      exportState?.type === "rendering"
        ? (exportState.progress.renderedCount /
            exportState.progress.totalFrames) *
          100
        : undefined
    );

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
      on(
        () => editorState.playing,
        (active) => {
          if (!active)
            commands.setPlayheadPosition(
              Math.floor(editorState.playbackTime * FPS)
            );
        }
      )
    );

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

    const [editorState, setEditorState] = createStore({
      previewTime: null as number | null,
      playbackTime: 0,
      playing: false,
      timeline: {
        interactMode: "seek" as "seek" | "split",
        selection: null as null | { type: "zoom"; index: number },
        transform: {
          // visible seconds
          zoom: zoomOutLimit(),
          updateZoom(z: number, origin: number) {
            const { zoom, position } = updateZoom(
              {
                zoom: editorState.timeline.transform.zoom,
                position: editorState.timeline.transform.position,
              },
              z,
              origin
            );

            const transform = editorState.timeline.transform;
            batch(() => {
              setEditorState("timeline", "transform", "zoom", zoom);
              if (transform.zoom !== zoom) return;
              transform.setPosition(position);
            });
          },
          // number of seconds of leftmost point
          position: 0,
          setPosition(p: number) {
            setEditorState(
              "timeline",
              "transform",
              "position",
              Math.min(
                Math.max(p, 0),
                Math.max(zoomOutLimit(), totalDuration()) +
                  4 -
                  editorState.timeline.transform.zoom
              )
            );
          },
        },
      },
    });

    return {
      ...editorInstanceContext,
      get meta() {
        return props.meta;
      },
      refetchMeta: () => props.refetchMeta(),
      editorInstance: props.editorInstance,
      dialog,
      setDialog,
      project,
      setProject,
      metaUpdateStore,
      lastMetaUpdate,
      setLastMetaUpdate,
      projectHistory: createStoreHistory(project, setProject),
      editorState,
      setEditorState,
      totalDuration,
      zoomOutLimit,
      exportState,
      setExportState,
    };
  },
  // biome-ignore lint/style/noNonNullAssertion: it's ok
  null!
);

export type FrameData = { width: number; height: number; data: ImageData };

function transformMeta({ pretty_name, ...rawMeta }: RecordingMeta) {
  if ("fps" in rawMeta) {
    throw new Error("Instant mode recordings cannot be edited");
  }

  let meta;

  if ("segments" in rawMeta) {
    meta = {
      ...rawMeta,
      type: "multiple",
    } as unknown as MultipleSegments & { type: "multiple" };
  } else {
    meta = {
      ...rawMeta,
      type: "single",
    } as unknown as SingleSegment & { type: "single" };
  }

  return {
    ...rawMeta,
    ...meta,
    prettyName: pretty_name,
    hasCamera: (() => {
      if (meta.type === "single") return !!meta.camera;
      return !!meta.segments[0].camera;
    })(),
    hasSystemAudio: (() => {
      if (meta.type === "single") return false;
      return !!meta.segments[0].system_audio;
    })(),
    hasMicrophone: (() => {
      if (meta.type === "single") return !!meta.audio;
      return !!meta.segments[0].mic;
    })(),
  };
}

export type TransformedMeta = ReturnType<typeof transformMeta>;

export const [EditorInstanceContextProvider, useEditorInstanceContext] =
  createContextProvider(() => {
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

      return instance;
    });

    const metaQuery = createQuery(() => ({
      queryKey: ["editor", "meta"],
      queryFn: editorInstance()
        ? () => commands.getEditorMeta().then(transformMeta)
        : skipToken,
    }));

    return {
      editorInstance,
      latestFrame,
      presets: createPresets(),
      metaQuery,
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
    const { editorState } = useEditorContext();

    const [trackState, setTrackState] = createStore({
      draggingSegment: false,
    });
    const bounds = createElementBounds(() => props.ref());

    const secsPerPixel = () =>
      editorState.timeline.transform.zoom / (bounds.width ?? 1);

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
