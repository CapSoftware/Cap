import { createContextProvider } from "@solid-primitives/context";
import { createEffect, createResource } from "solid-js";

import { events, commands } from "~/utils/tauri";
import { createPresets } from "~/utils/createPresets";
import { createImageDataWS, createLazySignal } from "~/utils/socket";

export const OUTPUT_SIZE = {
  width: 1920,
  height: 1080,
};

export type FrameData = { width: number; height: number; data: ImageData };

export const [EditorInstanceContextProvider, useEditorInstanceContext] =
  createContextProvider((props: { videoId: string }) => {
    const [latestFrame, setLatestFrame] = createLazySignal<ImageData>();

    const [editorInstance] = createResource(async () => {
      const instance = await commands.createEditorInstance(props.videoId);
      if (instance.status !== "ok") throw new Error("Failed to start editor");

      const [ws, isConnected] = createImageDataWS(
        instance.data.framesSocketUrl,
        setLatestFrame
      );

      createEffect(() => {
        if (isConnected()) {
          events.renderFrameEvent.emit({
            frame_number: Math.floor(0),
          });
        }
      });

      return instance.data;
    });

    return {
      editorInstance,
      videoId: props.videoId,
      latestFrame,
      presets: createPresets(),
      prettyName: () => editorInstance()?.prettyName ?? "Cap Recording",
    };
  }, null!);
