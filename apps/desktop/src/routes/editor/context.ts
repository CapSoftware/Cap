import { createContextProvider } from "@solid-primitives/context";
import { createEffect, createSignal, on } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { debounce } from "@solid-primitives/scheduled";
import { createUndoHistory } from "@solid-primitives/history";
import { captureStoreUpdates, trackStore } from "@solid-primitives/deep";
import { createEventListener } from "@solid-primitives/event-listener";

import {
  type SerializedEditorInstance,
  type ProjectConfiguration,
  commands,
  type XY,
} from "../../utils/tauri";
import { useEditorInstanceContext } from "./editorInstanceContext";
import { DEFAULT_PROJECT_CONFIG } from "./projectConfig";
import type { PresetsStore } from "../createPresets";
import { createElementBounds } from "@solid-primitives/bounds";

export type CurrentDialog =
  | { type: "createPreset" }
  | { type: "renamePreset"; presetIndex: number }
  | { type: "deletePreset"; presetIndex: number }
  | { type: "crop"; position: XY<number>; size: XY<number> };

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);

export const [EditorContextProvider, useEditorContext] = createContextProvider(
  (props: {
    editorInstance: SerializedEditorInstance;
    presets: PresetsStore;
  }) => {
    const editorInstanceContext = useEditorInstanceContext();
    const [project, setProject] = createStore<ProjectConfiguration>(
      props.editorInstance.savedProjectConfig ??
        props.presets.presets[props.presets.default ?? 0]?.config ??
        DEFAULT_PROJECT_CONFIG
    );

    createEffect(
      on(
        () => {
          trackStore(project);
        },
        debounce(() => {
          commands.saveProjectConfig(editorInstanceContext.videoId, project);
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
    };
  },
  // biome-ignore lint/style/noNonNullAssertion: it's ok
  null!
);

function createStoreHistory<T extends Static>(
  ...[state, setState]: ReturnType<typeof createStore<T>>
) {
  const getDelta = captureStoreUpdates(state);

  const [pauseCount, setPauseCount] = createSignal(0);

  let clonedState: any;
  const history = createUndoHistory(() => {
    if (pauseCount() > 0) return;

    const delta = getDelta();
    if (!delta.length) return;

    for (const { path, value } of delta) {
      if (path.length === 0) {
        clonedState = structuredClone(unwrap(value));
      } else {
        let target = { ...clonedState };
        for (const key of path.slice(0, -1)) {
          target[key] = Array.isArray(target[key])
            ? [...target[key]]
            : { ...target[key] };
          target = target[key];
        }
        target[path[path.length - 1]!] = structuredClone(unwrap(value));
        clonedState = target;
      }
    }

    const snapshot = clonedState;
    return () => setState(reconcile(snapshot));
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
