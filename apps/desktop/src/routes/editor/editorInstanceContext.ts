import { createContextProvider } from "@solid-primitives/context";
import { createResource, createSignal } from "solid-js";

import { events, commands } from "~/utils/tauri";
import { DEFAULT_PROJECT_CONFIG } from "./projectConfig";
import { createPresets } from "~/utils/createPresets";

export const OUTPUT_SIZE = {
  width: 1920,
  height: 1080,
};

export type FrameData = { width: number; height: number; data: ImageData };

export const [EditorInstanceContextProvider, useEditorInstanceContext] =
  createContextProvider((props: { videoId: string }) => {
    let res: ((frame: FrameData) => void) | undefined;

    const [currentFrame, currentFrameActions] = createResource(
      () =>
        new Promise<FrameData>((r) => {
          res = r;
        })
    );

    const [editorInstance] = createResource(async () => {
      const instance = await commands.createEditorInstance(props.videoId);
      if (instance.status !== "ok") throw new Error("Failed to start editor");

      const ws = new WebSocket(instance.data.framesSocketUrl);
      ws.onopen = () => {
        events.renderFrameEvent.emit({
          frame_number: Math.floor(0),
          project: instance.data.savedProjectConfig ?? DEFAULT_PROJECT_CONFIG,
        });
      };
      ws.binaryType = "arraybuffer";
      ws.onmessage = (event) => {
        const buffer = event.data as ArrayBuffer;
        const clamped = new Uint8ClampedArray(buffer);

        const widthArr = clamped.slice(clamped.length - 4);
        const heightArr = clamped.slice(clamped.length - 8, clamped.length - 4);

        const width =
          widthArr[0] +
          (widthArr[1] << 8) +
          (widthArr[2] << 16) +
          (widthArr[3] << 24);
        const height =
          heightArr[0] +
          (heightArr[1] << 8) +
          (heightArr[2] << 16) +
          (heightArr[3] << 24);

        const imageData = new ImageData(
          clamped.slice(0, clamped.length - 8),
          width,
          height
        );

        if (res) {
          res({ data: imageData, width, height });
          res = undefined;
        } else {
          currentFrameActions.mutate({ data: imageData, width, height });
        }
      };

      return instance.data;
    });

    return {
      editorInstance,
      videoId: props.videoId,
      currentFrame,
      presets: createPresets(),
    };
  }, null!);
