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
