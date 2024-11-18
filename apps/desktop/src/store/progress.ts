import { createStore } from "solid-js/store";

export type ProgressState =
  | {
      type: "idle";
    }
  | {
      type: "copying";
      progress: number;
      message: string;
      mediaPath?: string;
      stage: "rendering" | undefined;
      renderProgress?: number;
      totalFrames?: number;
    }
  | {
      type: "saving";
      progress: number;
      message: string;
      mediaPath?: string;
      stage: "rendering" | undefined;
      renderProgress?: number;
      totalFrames?: number;
    }
  | {
      type: "uploading";
      renderProgress: number;
      uploadProgress: number;
      message: string;
      mediaPath?: string;
      stage: "rendering" | "uploading";
      totalFrames?: number;
    };

const [progressState, setProgressState] = createStore<ProgressState>({
  type: "idle",
});

export { progressState, setProgressState }; 