import { createContextProvider } from "@solid-primitives/context";
import { createEffect, createSignal, on } from "solid-js";
import { createStore } from "solid-js/store";
import { debounce } from "@solid-primitives/scheduled";
import { deepTrack, trackStore } from "@solid-primitives/deep";

import {
  type SerializedEditorInstance,
  type ProjectConfiguration,
  commands,
} from "../../utils/tauri";
import { useEditorInstanceContext } from "./editorInstanceContext";
import { DEFAULT_PROJECT_CONFIG } from "./projectConfig";

export type CurrentDialog =
  | { type: "createPreset" }
  | { type: "renamePreset"; presetId: string }
  | { type: "deletePreset"; presetId: string }
  | { type: "crop" };

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);

export const [EditorContextProvider, useEditorContext] = createContextProvider(
  (props: { editorInstance: SerializedEditorInstance }) => {
    const editorInstanceContext = useEditorInstanceContext();
    const [state, setState] = createStore<ProjectConfiguration>(
      props.editorInstance.savedProjectConfig ?? DEFAULT_PROJECT_CONFIG
    );

    createEffect(
      on(
        () => {
          trackStore(state);
        },
        debounce(() => {
          commands.saveProjectConfig(editorInstanceContext.videoId, state);
        }, 100),
        { defer: true }
      )
    );

    const [selectedTab, setSelectedTab] = createSignal<
      "background" | "camera" | "transcript" | "audio" | "cursor" | "hotkeys"
    >("background");

    const [dialog, setDialog] = createSignal<DialogState>({
      open: false,
    });

    return {
      ...editorInstanceContext,
      editorInstance: props.editorInstance,
      dialog,
      setDialog,
      state,
      setState,
      selectedTab,
      setSelectedTab,
    };
  },
  // biome-ignore lint/style/noNonNullAssertion: it's ok
  null!
);
