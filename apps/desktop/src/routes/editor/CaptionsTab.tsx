import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { createElementSize } from "@solid-primitives/resize-observer";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { batch, createEffect, createSignal, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import toast from "solid-toast";
import { Toggle } from "~/components/Toggle";
import { captionsStore } from "~/store/captions";
import { applySegmentUpdates } from "~/utils/captionWords";
import type { CaptionSegment, CaptionSettings } from "~/utils/tauri";
import { commands, events } from "~/utils/tauri";
import { FPS, OUTPUT_SIZE, useEditorContext } from "./context";
import {
  Field,
  Input,
  MenuItem,
  MenuItemList,
  PopperContent,
  Slider,
  Subfield,
  topLeftAnimateClasses,
} from "./ui";

interface ModelOption {
  name: string;
  label: string;
}

interface LanguageOption {
  code: string;
  label: string;
}

interface FontOption {
  value: string;
  label: string;
}

const MODEL_OPTIONS: ModelOption[] = [
  { name: "small", label: "Small (466MB) - Balanced speed/accuracy" },
  { name: "medium", label: "Medium (1.5GB) - Slower, more accurate" },
];

const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "en", label: "English" },
  { code: "auto", label: "Auto Detect" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "ru", label: "Russian" },
  { code: "tr", label: "Turkish" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
];

const DEFAULT_MODEL = "small";
const MODEL_FOLDER = "transcription_models";

function FlatButton(props: {
  class?: string;
  onClick?: () => void;
  disabled?: boolean;
  children: any;
}) {
  return (
    <button
      class={`px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors ${
        props.class || ""
      }`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  );
}

const fontOptions = [
  { value: "System Sans-Serif", label: "System Sans-Serif" },
  { value: "System Serif", label: "System Serif" },
  { value: "System Monospace", label: "System Monospace" },
];
const CAPTION_STYLE_KEYS: ReadonlyArray<keyof CaptionSettings> = [
  "enabled",
  "font",
  "size",
  "backgroundOpacity",
  "position",
];

interface CaptionsResponse {
  segments: CaptionSegment[];
}

export function CaptionsTab() {
  const { project, setProject, editorInstance, editorState } =
    useEditorContext();

  let scrollContainerRef: HTMLDivElement | undefined;
  const [scrollState, setScrollState] = createStore({
    lastScrollTop: 0,
    isScrolling: false,
  });

  const size = createElementSize(() => scrollContainerRef);

  const [captionSettings, setCaptionSettings] = createStore(
    project?.captions?.settings || {
      enabled: false,
      font: "Arial",
      size: 24,
      color: "#FFFFFF",
      backgroundColor: "#000000",
      backgroundOpacity: 80,
      position: "bottom",
      bold: true,
      italic: false,
      outline: false,
      outlineColor: "#000000",
      exportWithSubtitles: false,
    }
  );
  createEffect(() => {
    if (project?.captions?.settings) {
      setCaptionSettings(project.captions.settings);
      captionsStore.updateSettings(project.captions.settings);
    }
  });

  const updateCaptionSetting = <K extends keyof CaptionSettings>(
    key: K,
    value: CaptionSettings[K],
  ) => {
    if (!project?.captions) return;

    if (scrollContainerRef) {
      setScrollState("lastScrollTop", scrollContainerRef.scrollTop);
    }

    setCaptionSettings(key, () => value);

    captionsStore.updateSettings({ [key]: value } as Pick<CaptionSettings, K>);

    setProject("captions", "settings", (prev) => ({
      ...(prev ?? {}),
      [key]: value,
    }));

    if (CAPTION_STYLE_KEYS.includes(key)) {
      events.renderFrameEvent.emit({
        frame_number: Math.floor(editorState.playbackTime * FPS),
        fps: FPS,
        resolution_base: OUTPUT_SIZE,
      });
    }
  };

  createEffect(() => {
    const _ = size.height;

    if (scrollContainerRef && scrollState.lastScrollTop > 0) {
      requestAnimationFrame(() => {
        scrollContainerRef!.scrollTop = scrollState.lastScrollTop;
      });
    }
  });

  const [selectedModel, setSelectedModel] = createSignal(
    localStorage.getItem("selectedTranscriptionModel") || DEFAULT_MODEL
  );
  const [selectedLanguage, setSelectedLanguage] = createSignal(
    localStorage.getItem("selectedTranscriptionLanguage") || "en"
  );
  const [downloadedModels, setDownloadedModels] = createSignal<string[]>([]);

  const [modelExists, setModelExists] = createSignal(false);
  const [isDownloading, setIsDownloading] = createSignal(false);
  const [downloadProgress, setDownloadProgress] = createSignal(0);
  const [downloadingModel, setDownloadingModel] = createSignal<string | null>(
    null
  );
  const [isGenerating, setIsGenerating] = createSignal(false);
  const [hasAudio, setHasAudio] = createSignal(false);
  const [modelPath, setModelPath] = createSignal("");
  const [currentCaption, setCurrentCaption] = createSignal<string | null>(null);

  createEffect(() => {
    if (!project || !editorInstance) return;

    if (!project.captions) {
      setProject("captions", {
        segments: [],
        settings: {
          enabled: false,
          font: "Arial",
          size: 24,
          color: "#FFFFFF",
          backgroundColor: "#000000",
          backgroundOpacity: 80,
          position: "bottom",
          bold: true,
          italic: false,
          outline: false,
          outlineColor: "#000000",
          exportWithSubtitles: false,
        },
      });
    }
  });

  onMount(async () => {
    try {
      const appDataDirPath = await appLocalDataDir();
      const modelsPath = await join(appDataDirPath, MODEL_FOLDER);

      if (!(await exists(modelsPath))) {
        await commands.createDir(modelsPath, true);
      }

      const models = await Promise.all(
        MODEL_OPTIONS.map(async (model) => {
          const downloaded = await checkModelExists(model.name);
          return { name: model.name, downloaded };
        })
      );

      const availableModels = models
        .filter((m) => m.downloaded)
        .map((m) => m.name);
      setDownloadedModels(availableModels);

      const savedModel = localStorage.getItem("selectedTranscriptionModel");
      if (savedModel && availableModels.includes(savedModel)) {
        setSelectedModel(savedModel);
      } else if (availableModels.includes(DEFAULT_MODEL)) {
        setSelectedModel(DEFAULT_MODEL);
      } else if (availableModels.length > 0) {
        setSelectedModel(availableModels[0]);
        localStorage.setItem("selectedTranscriptionModel", availableModels[0]);
      }

      if (selectedModel()) {
        setModelExists(await checkModelExists(selectedModel()));
      }

      if (editorInstance && editorInstance.recordings) {
        const hasAudioTrack = editorInstance.recordings.segments.some(
          (segment) => segment.mic !== null || segment.system_audio !== null
        );
        setHasAudio(hasAudioTrack);
      }

      const downloadState = localStorage.getItem("modelDownloadState");
      if (downloadState) {
        const { model, progress } = JSON.parse(downloadState);
        if (model && progress < 100) {
          setDownloadingModel(model);
          setDownloadProgress(progress);
          setIsDownloading(true);
        } else {
          localStorage.removeItem("modelDownloadState");
        }
      }
    } catch (error) {
      console.error("Error checking models:", error);
    }
  });

  createEffect(() => {
    if (isDownloading() && downloadingModel()) {
      localStorage.setItem(
        "modelDownloadState",
        JSON.stringify({
          model: downloadingModel(),
          progress: downloadProgress(),
        })
      );
    } else {
      localStorage.removeItem("modelDownloadState");
    }
  });

  createEffect(() => {
    if (!project?.captions?.segments || editorState.playbackTime === undefined)
      return;

    const time = editorState.playbackTime;
    const segments = project.captions.segments;

    const findSegment = (
      time: number,
      segments: CaptionSegment[]
    ): CaptionSegment | undefined => {
      let left = 0;
      let right = segments.length - 1;

      while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const segment = segments[mid];

        if (time >= segment.start && time < segment.end) {
          return segment;
        }

        if (time < segment.start) {
          right = mid - 1;
        } else {
          left = mid + 1;
        }
      }

      return undefined;
    };

    const currentSegment = findSegment(time, segments);

    if (currentSegment?.text !== currentCaption()) {
      setCurrentCaption(currentSegment?.text || null);
    }
  });

  const checkModelExists = async (modelName: string) => {
    const appDataDirPath = await appLocalDataDir();
    const modelsPath = await join(appDataDirPath, MODEL_FOLDER);
    const modelPath = await join(modelsPath, `${modelName}.bin`);
    setModelPath(modelPath);
    return await commands.checkModelExists(modelPath);
  };

  const downloadModel = async () => {
    try {
      const modelToDownload = selectedModel();
      setIsDownloading(true);
      setDownloadProgress(0);
      setDownloadingModel(modelToDownload);

      const appDataDirPath = await appLocalDataDir();
      const modelsPath = await join(appDataDirPath, MODEL_FOLDER);
      const modelPath = await join(modelsPath, `${modelToDownload}.bin`);

      try {
        await commands.createDir(modelsPath, true);
      } catch (err) {
        console.error("Error creating directory:", err);
      }

      const unlisten = await events.downloadProgress.listen((event) => {
        setDownloadProgress(event.payload.progress);
      });

      await commands.downloadWhisperModel(modelToDownload, modelPath);

      unlisten();

      setDownloadedModels((prev) => [...prev, modelToDownload]);
      setModelExists(true);
      toast.success("Transcription model downloaded successfully!");
    } catch (error) {
      console.error("Error downloading model:", error);
      toast.error("Failed to download transcription model");
    } finally {
      setIsDownloading(false);
      setDownloadingModel(null);
    }
  };

  const generateCaptions = async () => {
    if (!editorInstance) {
      toast.error("Editor instance not found");
      return;
    }

    setIsGenerating(true);

    try {
      const videoPath = editorInstance.path;
      const lang = selectedLanguage();
      const currentModelPath = await join(
        await appLocalDataDir(),
        MODEL_FOLDER,
        `${selectedModel()}.bin`
      );

      const result = await commands.transcribeAudio(
        videoPath,
        currentModelPath,
        lang
      );

      if (result && result.segments.length > 0) {
        setProject(
          "captions",
          "segments",
          result.segments.map((segment) =>
            applySegmentUpdates(segment, {}),
          ),
        );
        updateCaptionSetting("enabled", true);
        toast.success("Captions generated successfully!");
      } else {
        toast.error(
          "No captions were generated. The audio might be too quiet or unclear."
        );
      }
    } catch (error) {
      console.error("Error generating captions:", error);
      let errorMessage = "Unknown error occurred";

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === "string") {
        errorMessage = error;
      }

      if (errorMessage.includes("No audio stream found")) {
        errorMessage = "No audio found in the video file";
      } else if (errorMessage.includes("Model file not found")) {
        errorMessage = "Caption model not found. Please download it first";
      } else if (errorMessage.includes("Failed to load Whisper model")) {
        errorMessage =
          "Failed to load the caption model. Try downloading it again";
      }

      toast.error("Failed to generate captions: " + errorMessage);
    } finally {
      setIsGenerating(false);
    }
  };

  const deleteSegment = (id: string) => {
    if (!project?.captions?.segments) return;

    setProject(
      "captions",
      "segments",
      project.captions.segments.filter((segment) => segment.id !== id)
    );
  };

  const updateSegment = (
    id: string,
    updates: Partial<{ start: number; end: number; text: string }>
  ) => {
    if (!project?.captions?.segments) return;

    setProject(
      "captions",
      "segments",
      project.captions.segments.map((segment) =>
        segment.id === id ? applySegmentUpdates(segment, updates) : segment
      )
    );
  };


  return (
    <div class="flex flex-col h-full">
      <div
        class="p-[0.75rem] text-[0.875rem] h-full transition-[height] duration-200"
        ref={(el) => (scrollContainerRef = el)}
        onScroll={() => {
          if (!scrollState.isScrolling && scrollContainerRef) {
            setScrollState("isScrolling", true);
            setScrollState("lastScrollTop", scrollContainerRef.scrollTop);

            setTimeout(() => {
              setScrollState("isScrolling", false);
            }, 150);
          }
        }}
      >
        <Field name="Captions" icon={<IconCapMessageBubble />}>
          <div class="flex flex-col gap-4">
            <Subfield name="Enable Captions">
              <Toggle
                checked={captionSettings.enabled}
                onChange={(checked) => updateCaptionSetting("enabled", checked)}
              />
            </Subfield>

            <Show when={captionSettings.enabled}>
              <div class="space-y-6 transition-all duration-200">
                <div class="space-y-4">
                  <div class="space-y-2">
                    <label class="text-xs text-gray-500">Current Model</label>
                    <KSelect<string>
                      options={MODEL_OPTIONS.filter((m) =>
                        downloadedModels().includes(m.name)
                      ).map((m) => m.name)}
                      value={selectedModel()}
                      onChange={(value: string | null) => {
                        if (value) {
                          batch(() => {
                            setSelectedModel(value);
                            localStorage.setItem(
                              "selectedTranscriptionModel",
                              value
                            );
                            setModelExists(downloadedModels().includes(value));
                          });
                        }
                      }}
                      itemComponent={(props) => (
                        <MenuItem<typeof KSelect.Item>
                          as={KSelect.Item}
                          item={props.item}
                        >
                          <KSelect.ItemLabel class="flex-1">
                            {
                              MODEL_OPTIONS.find(
                                (m) => m.name === props.item.rawValue
                              )?.label
                            }
                          </KSelect.ItemLabel>
                        </MenuItem>
                      )}
                    >
                      <KSelect.Trigger class="flex flex-row items-center h-9 px-3 gap-2 border rounded-lg border-gray-200 w-full text-gray-700 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors">
                        <KSelect.Value<string> class="flex-1 text-left truncate">
                          {(state) => {
                            const model = MODEL_OPTIONS.find(
                              (m) => m.name === state.selectedOption()
                            );
                            return (
                              <span>{model?.label || "Select a model"}</span>
                            );
                          }}
                        </KSelect.Value>
                        <KSelect.Icon>
                          <IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180" />
                        </KSelect.Icon>
                      </KSelect.Trigger>
                      <KSelect.Portal>
                        <PopperContent<typeof KSelect.Content>
                          as={KSelect.Content}
                          class={topLeftAnimateClasses}
                        >
                          <MenuItemList<typeof KSelect.Listbox>
                            class="max-h-48 overflow-y-auto"
                            as={KSelect.Listbox}
                          />
                        </PopperContent>
                      </KSelect.Portal>
                    </KSelect>
                  </div>

                  <div class="space-y-2">
                    <label class="text-xs text-gray-500">
                      Download New Model
                    </label>
                    <KSelect<string>
                      options={MODEL_OPTIONS.map((m) => m.name)}
                      value={selectedModel()}
                      onChange={(value: string | null) => {
                        if (value) {
                          setSelectedModel(value);
                          localStorage.setItem(
                            "selectedTranscriptionModel",
                            value
                          );
                        }
                      }}
                      disabled={isDownloading()}
                      itemComponent={(props) => (
                        <MenuItem<typeof KSelect.Item>
                          as={KSelect.Item}
                          item={props.item}
                        >
                          <KSelect.ItemLabel class="flex-1">
                            {
                              MODEL_OPTIONS.find(
                                (m) => m.name === props.item.rawValue
                              )?.label
                            }
                            {downloadedModels().includes(props.item.rawValue)
                              ? " (Downloaded)"
                              : ""}
                          </KSelect.ItemLabel>
                        </MenuItem>
                      )}
                    >
                      <KSelect.Trigger class="flex flex-row items-center h-9 px-3 gap-2 border rounded-lg border-gray-200 w-full text-gray-700 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors">
                        <KSelect.Value<string> class="flex-1 text-left truncate">
                          {(state) => {
                            const model = MODEL_OPTIONS.find(
                              (m) => m.name === state.selectedOption()
                            );
                            return (
                              <span>{model?.label || "Select a model"}</span>
                            );
                          }}
                        </KSelect.Value>
                        <KSelect.Icon>
                          <IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180" />
                        </KSelect.Icon>
                      </KSelect.Trigger>
                      <KSelect.Portal>
                        <PopperContent<typeof KSelect.Content>
                          as={KSelect.Content}
                          class={topLeftAnimateClasses}
                        >
                          <MenuItemList<typeof KSelect.Listbox>
                            class="max-h-48 overflow-y-auto"
                            as={KSelect.Listbox}
                          />
                        </PopperContent>
                      </KSelect.Portal>
                    </KSelect>
                  </div>

                  <Show
                    when={isDownloading()}
                    fallback={
                      <Button
                        class="w-full"
                        onClick={downloadModel}
                        disabled={
                          isDownloading() ||
                          downloadedModels().includes(selectedModel())
                        }
                      >
                        Download{" "}
                        {
                          MODEL_OPTIONS.find((m) => m.name === selectedModel())
                            ?.label
                        }
                      </Button>
                    }
                  >
                    <div class="space-y-2">
                      <div class="w-full bg-gray-100 rounded-full h-2">
                        <div
                          class="bg-blue-500 h-2 rounded-full transition-all duration-300"
                          style={{ width: `${downloadProgress()}%` }}
                        />
                      </div>
                      <p class="text-xs text-center text-gray-500">
                        Downloading{" "}
                        {
                          MODEL_OPTIONS.find(
                            (m) => m.name === downloadingModel()
                          )?.label
                        }
                        : {Math.round(downloadProgress())}%
                      </p>
                    </div>
                  </Show>
                </div>

                <Subfield name="Language">
                  <KSelect<string>
                    options={LANGUAGE_OPTIONS.map((l) => l.code)}
                    value={selectedLanguage()}
                    onChange={(value: string | null) => {
                      if (value) {
                        setSelectedLanguage(value);
                        localStorage.setItem(
                          "selectedTranscriptionLanguage",
                          value
                        );
                      }
                    }}
                    itemComponent={(props) => (
                      <MenuItem<typeof KSelect.Item>
                        as={KSelect.Item}
                        item={props.item}
                      >
                        <KSelect.ItemLabel class="flex-1">
                          {
                            LANGUAGE_OPTIONS.find(
                              (l) => l.code === props.item.rawValue
                            )?.label
                          }
                        </KSelect.ItemLabel>
                      </MenuItem>
                    )}
                  >
                    <KSelect.Trigger class="flex flex-row items-center h-9 px-3 gap-2 border rounded-lg border-gray-200 w-full text-gray-700 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors">
                      <KSelect.Value<string> class="flex-1 text-left truncate">
                        {(state) => {
                          const language = LANGUAGE_OPTIONS.find(
                            (l) => l.code === state.selectedOption()
                          );
                          return (
                            <span>
                              {language?.label || "Select a language"}
                            </span>
                          );
                        }}
                      </KSelect.Value>
                      <KSelect.Icon>
                        <IconCapChevronDown class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180" />
                      </KSelect.Icon>
                    </KSelect.Trigger>
                    <KSelect.Portal>
                      <PopperContent<typeof KSelect.Content>
                        as={KSelect.Content}
                        class={topLeftAnimateClasses}
                      >
                        <MenuItemList<typeof KSelect.Listbox>
                          class="max-h-48 overflow-y-auto"
                          as={KSelect.Listbox}
                        />
                      </PopperContent>
                    </KSelect.Portal>
                  </KSelect>
                </Subfield>

                <Show when={hasAudio()}>
                  <Button
                    onClick={generateCaptions}
                    disabled={isGenerating()}
                    class="w-full"
                  >
                    {isGenerating() ? "Generating..." : "Generate Captions"}
                  </Button>
                </Show>

                <Field name="Font Settings" icon={<IconCapMessageBubble />}>
                  <div class="space-y-3">
                    <div class="flex flex-col gap-2">
                      <span class="text-gray-500 text-sm">Font Family</span>
                      <KSelect<string>
                        options={fontOptions.map((f) => f.value)}
                        value={captionSettings.font}
                        onChange={(value) => {
                          if (value === null) return;
                          updateCaptionSetting("font", value);
                        }}
                        itemComponent={(props) => (
                          <MenuItem<typeof KSelect.Item>
                            as={KSelect.Item}
                            item={props.item}
                          >
                            <KSelect.ItemLabel class="flex-1">
                              {
                                fontOptions.find(
                                  (f) => f.value === props.item.rawValue
                                )?.label
                              }
                            </KSelect.ItemLabel>
                          </MenuItem>
                        )}
                      >
                        <KSelect.Trigger class="w-full flex items-center justify-between rounded-lg shadow px-3 py-2 bg-white border border-gray-300">
                          <KSelect.Value<string>>
                            {(state) =>
                              fontOptions.find(
                                (f) => f.value === state.selectedOption()
                              )?.label
                            }
                          </KSelect.Value>
                          <KSelect.Icon>
                            <IconCapChevronDown />
                          </KSelect.Icon>
                        </KSelect.Trigger>
                        <KSelect.Portal>
                          <PopperContent<typeof KSelect.Content>
                            as={KSelect.Content}
                            class={topLeftAnimateClasses}
                          >
                            <MenuItemList<typeof KSelect.Listbox>
                              class="max-h-48 overflow-y-auto"
                              as={KSelect.Listbox}
                            />
                          </PopperContent>
                        </KSelect.Portal>
                      </KSelect>
                    </div>

                    <div class="flex flex-col gap-2">
                      <span class="text-gray-500 text-sm">Size</span>
                      <Slider
                        value={[captionSettings.size || 24]}
                        onChange={(v) => updateCaptionSetting("size", v[0])}
                        minValue={12}
                        maxValue={48}
                        step={1}
                      />
                    </div>
                  </div>
                </Field>

                <Field
                  name="Background Settings"
                  icon={<IconCapMessageBubble />}
                >
                  <div class="space-y-3">
                    <div class="flex flex-col gap-2">
                      <span class="text-gray-500 text-sm">
                        Background Opacity
                      </span>
                      <Slider
                        value={[captionSettings.backgroundOpacity || 80]}
                        onChange={(v) =>
                          updateCaptionSetting("backgroundOpacity", v[0])
                        }
                        minValue={0}
                        maxValue={100}
                        step={1}
                      />
                    </div>
                  </div>
                </Field>

                <Field name="Position" icon={<IconCapMessageBubble />}>
                  <KSelect<string>
                    options={["top", "bottom"]}
                    value={captionSettings.position || "bottom"}
                    onChange={(value) => {
                      if (value === null) return;
                      updateCaptionSetting("position", value);
                    }}
                    itemComponent={(props) => (
                      <MenuItem<typeof KSelect.Item>
                        as={KSelect.Item}
                        item={props.item}
                      >
                        <KSelect.ItemLabel class="flex-1 capitalize">
                          {props.item.rawValue}
                        </KSelect.ItemLabel>
                      </MenuItem>
                    )}
                  >
                    <KSelect.Trigger class="w-full flex items-center justify-between rounded-lg shadow px-3 py-2 bg-white border border-gray-300">
                      <KSelect.Value<string>>
                        {(state) => (
                          <span class="capitalize">
                            {state.selectedOption()}
                          </span>
                        )}
                      </KSelect.Value>
                      <KSelect.Icon>
                        <IconCapChevronDown />
                      </KSelect.Icon>
                    </KSelect.Trigger>
                    <KSelect.Portal>
                      <PopperContent<typeof KSelect.Content>
                        as={KSelect.Content}
                        class={topLeftAnimateClasses}
                      >
                        <MenuItemList<typeof KSelect.Listbox>
                          as={KSelect.Listbox}
                        />
                      </PopperContent>
                    </KSelect.Portal>
                  </KSelect>
                </Field>

                <Field name="Export Options" icon={<IconCapMessageBubble />}>
                  <Subfield name="Export with Subtitles">
                    <Toggle
                      checked={captionSettings.exportWithSubtitles}
                      onChange={(checked) =>
                        updateCaptionSetting("exportWithSubtitles", checked)
                      }
                    />
                  </Subfield>
                </Field>

                <Show when={project.captions?.segments.length}>
                  <Field
                    name="Caption Segments"
                    icon={<IconCapMessageBubble />}
                  >
                    <div class="space-y-4">
                      <div class="max-h-[300px] overflow-y-auto space-y-3 pr-2">
                        {project.captions?.segments.length === 0 ? (
                          <p class="text-sm text-gray-500">
                            No caption segments found.
                          </p>
                        ) : (
                          project.captions?.segments.map((segment) => (
                            <div class="bg-gray-50 dark:bg-gray-100 border border-gray-200 rounded-lg p-4 space-y-4">
                              <div class="flex flex-col space-y-4">
                                <div class="flex space-x-4">
                                  <div class="flex-1">
                                    <label class="text-xs text-gray-400 dark:text-gray-500">
                                      Start Time
                                    </label>
                                    <Input
                                      type="number"
                                      class="w-full"
                                      value={segment.start.toFixed(1)}
                                      step="0.1"
                                      min={0}
                                      onChange={(e) =>
                                        updateSegment(segment.id, {
                                          start: parseFloat(e.target.value),
                                        })
                                      }
                                    />
                                  </div>
                                  <div class="flex-1">
                                    <label class="text-xs text-gray-400 dark:text-gray-500">
                                      End Time
                                    </label>
                                    <Input
                                      type="number"
                                      class="w-full"
                                      value={segment.end.toFixed(1)}
                                      step="0.1"
                                      min={segment.start}
                                      onChange={(e) =>
                                        updateSegment(segment.id, {
                                          end: parseFloat(e.target.value),
                                        })
                                      }
                                    />
                                  </div>
                                </div>

                                <div class="space-y-2">
                                  <label class="text-xs text-gray-400 dark:text-gray-500">
                                    Caption Text
                                  </label>
                                  <div class="w-full px-3 py-2 bg-white dark:bg-gray-50 border border-gray-200 rounded-lg text-sm focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 transition-colors">
                                    <textarea
                                      class="w-full resize-none outline-none bg-transparent text-[--text-primary]"
                                      value={segment.text}
                                      rows={2}
                                      onChange={(e) =>
                                        updateSegment(segment.id, {
                                          text: e.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                </div>

                                <div class="flex justify-end">
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => deleteSegment(segment.id)}
                                    class="text-gray-50 dark:text-gray-500 inline-flex items-center gap-1.5"
                                  >
                                    <IconDelete />
                                    Delete
                                  </Button>
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </Field>
                </Show>
              </div>
            </Show>
          </div>
        </Field>
      </div>
    </div>
  );
}

function IconDelete() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class="size-4"
    >
      <path
        d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
        fill="currentColor"
      />
    </svg>
  );
}

