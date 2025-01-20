// @refresh reload
import { createContextProvider } from "@solid-primitives/context";
import { trackStore } from "@solid-primitives/deep";
import { createEventListener } from "@solid-primitives/event-listener";
import { createUndoHistory } from "@solid-primitives/history";
import { debounce } from "@solid-primitives/scheduled";
import {
  Accessor,
  createEffect,
  createResource,
  createSignal,
  on,
} from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { createElementBounds } from "@solid-primitives/bounds";

import type { PresetsStore } from "../../store";
import {
  type ProjectConfiguration,
  type SerializedEditorInstance,
  type XY,
  commands,
  events,
} from "~/utils/tauri";
import { DEFAULT_PROJECT_CONFIG } from "./projectConfig";
import { createImageDataWS, createLazySignal } from "~/utils/socket";
import { createPresets } from "~/utils/createPresets";

export type CurrentDialog =
  | { type: "createPreset" }
  | { type: "renamePreset"; presetIndex: number }
  | { type: "deletePreset"; presetIndex: number }
  | { type: "crop"; position: XY<number>; size: XY<number> };

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);

export const FPS = 30;

export const OUTPUT_SIZE = {
  x: 1920,
  y: 1080,
};

export const [EditorContextProvider, useEditorContext] = createContextProvider(
  (props: {
    editorInstance: SerializedEditorInstance;
    presets: PresetsStore;
  }) => {
    const editorInstanceContext = useEditorInstanceContext();
    const [project, setProject] = createStore<ProjectConfiguration>(
      props.editorInstance.savedProjectConfig ??
        (() => {
          const config =
            props.presets.presets[props.presets.default ?? 0]?.config;
          if (!config) return;
          // @ts-ignore
          config.timeline = undefined;
          return config;
        })() ??
        DEFAULT_PROJECT_CONFIG
    );

    createEffect(
      on(
        () => {
          trackStore(project);
        },
        debounce(() => {
          commands.setProjectConfig(editorInstanceContext.videoId, project);
        }),
        { defer: true }
      )
    );

    const [selectedTab, setSelectedTab] = createSignal<
      "background" | "camera" | "transcript" | "audio" | "cursor" | "hotkeys"
    >("background");

    const [dialog, setDialog] = createSignal<DialogState>({
      open: false,
    });

    const [previewTime, setPreviewTime] = createSignal<number>();
    const [playbackTime, setPlaybackTime] = createSignal<number>(0);
    const [playing, setPlaying] = createSignal(false);

    const [split, setSplit] = createSignal(false);

    const [state, setState] = createStore({
      timelineSelection: null as null | { type: "zoom"; index: number },
    });

    return {
      ...editorInstanceContext,
      editorInstance: props.editorInstance,
      dialog,
      setDialog,
      project,
      setProject,
      selectedTab,
      setSelectedTab,
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
    };
  },
  // biome-ignore lint/style/noNonNullAssertion: it's ok
  null!
);

export type FrameData = { width: number; height: number; data: ImageData };

export const [EditorInstanceContextProvider, useEditorInstanceContext] =
  createContextProvider((props: { videoId: string }) => {
    const [latestFrame, setLatestFrame] = createLazySignal<{
      width: number;
      data: ImageData;
    }>();

    const [editorInstance] = createResource(async () => {
      const instance = await commands.createEditorInstance(props.videoId);

      const [ws, isConnected] = createImageDataWS(
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

    return {
      editorInstance,
      videoId: props.videoId,
      latestFrame,
      presets: createPresets(),
      prettyName: () => editorInstance()?.prettyName ?? "Cap Recording",
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
  });
}

type Static<T = unknown> =
  | {
      [K in number | string]: T;
    }
  | T[];

export const [TimelineContextProvider, useTimelineContext] =
  createContextProvider((props: { duration: number }) => {
    return {
      duration: () => props.duration,
    };
  }, null!);

export const [TrackContextProvider, useTrackContext] = createContextProvider(
  (props: {
    ref: Accessor<Element | undefined>;
    isFreeForm: Accessor<boolean>;
  }) => {
    const [trackState, setTrackState] = createStore({
      draggingHandle: false,
    });
    const bounds = createElementBounds(() => props.ref());

    return {
      trackBounds: bounds,
      isFreeForm: () => props.isFreeForm(),
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
