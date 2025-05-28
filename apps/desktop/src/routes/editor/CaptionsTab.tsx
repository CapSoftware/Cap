import { batch, createEffect, createSignal, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import toast from "solid-toast";
import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { createWritableMemo } from "@solid-primitives/memo";
import { createElementSize } from "@solid-primitives/resize-observer";

import { MenuItem, MenuItemList, PopperContent } from "./ui";
import { topLeftAnimateClasses } from "./ui";
import { TextInput } from "./TextInput";
import { Toggle } from "~/components/Toggle";
import type { CaptionSettings, CaptionSegment } from "~/utils/tauri";
import { Field, Slider, Subfield, Input } from "./ui";
import { useEditorContext, FPS, OUTPUT_SIZE } from "./context";
import { commands, events } from "~/utils/tauri";

// Model information
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
  { name: "tiny", label: "Tiny (75MB) - Fastest, less accurate" },
  { name: "base", label: "Base (142MB) - Fast, decent accuracy" },
  { name: "small", label: "Small (466MB) - Balanced speed/accuracy" },
  { name: "medium", label: "Medium (1.5GB) - Slower, more accurate" },
  { name: "large-v3", label: "Large (3GB) - Slowest, most accurate" },
];

const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "auto", label: "Auto Detect" },
  { code: "en", label: "English" },
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

const DEFAULT_MODEL = "tiny";
const MODEL_FOLDER = "transcription_models";

// Custom flat button component since we can't import it
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

// Add type definitions at the top
interface CaptionsResponse {
  segments: CaptionSegment[];
}

// Color conversion types
type RGB = [number, number, number];

// Helper functions for color conversion
function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16),
      ]
    : [0, 0, 0];
}

function rgbToHex(rgb: RGB): string {
  return `#${rgb.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

// Add RgbInput component at the top level
function RgbInput(props: { value: string; onChange: (value: string) => void }) {
  const [text, setText] = createWritableMemo(() => props.value);
  let prevColor = props.value;
  let colorInput!: HTMLInputElement;

  return (
    <div class="flex flex-row items-center gap-[0.75rem] relative">
      <button
        type="button"
        class="size-[3rem] rounded-[0.5rem]"
        style={{
          "background-color": text(),
        }}
        onClick={() => colorInput.click()}
      />
      <input
        ref={colorInput}
        type="color"
        class="absolute left-0 bottom-0 w-[3rem] opacity-0"
        value={text()}
        onChange={(e) => {
          setText(e.target.value);
          props.onChange(e.target.value);
        }}
      />
      <TextInput
        class="w-[5rem] p-[0.375rem] border text-gray-400 rounded-[0.5rem] bg-gray-50"
        value={text()}
        onFocus={() => {
          prevColor = props.value;
        }}
        onInput={(e) => {
          setText(e.currentTarget.value);
          props.onChange(e.currentTarget.value);
        }}
        onBlur={(e) => {
          if (!/^#[0-9A-F]{6}$/i.test(e.target.value)) {
            setText(prevColor);
            props.onChange(prevColor);
          }
        }}
      />
    </div>
  );
}

// Add scroll position preservation for the container
export function CaptionsTab() {
  const { project, setProject, editorInstance, editorState } =
    useEditorContext();

  // Scroll management
  let scrollContainerRef: HTMLDivElement | undefined;
  const [scrollState, setScrollState] = createStore({
    lastScrollTop: 0,
    isScrolling: false,
  });

  // Track container size changes
  const size = createElementSize(() => scrollContainerRef);

  // Create a local store for caption settings to avoid direct project mutations
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
      outline: true,
      outlineColor: "#000000",
      exportWithSubtitles: false,
    }
  );

  // Sync caption settings with project and update player
  createEffect(() => {
    if (!project?.captions) return;

    const settings = captionSettings;

    // Only update if there are actual changes
    if (
      JSON.stringify(settings) !== JSON.stringify(project.captions.settings)
    ) {
      batch(() => {
        // Update project settings
        setProject("captions", "settings", settings);

        // Force player refresh
        events.renderFrameEvent.emit({
          frame_number: Math.floor(editorState.playbackTime * FPS),
          fps: FPS,
          resolution_base: OUTPUT_SIZE,
        });
      });
    }
  });

  // Sync project settings to local store
  createEffect(() => {
    if (project?.captions?.settings) {
      setCaptionSettings(project.captions.settings);
    }
  });

  // Helper function to update caption settings
  const updateCaptionSetting = (key: keyof CaptionSettings, value: any) => {
    if (!project?.captions) return;

    // Store scroll position before update
    if (scrollContainerRef) {
      setScrollState("lastScrollTop", scrollContainerRef.scrollTop);
    }

    // Update local store
    setCaptionSettings({
      ...captionSettings,
      [key]: value,
    });

    // For font changes, force an immediate player update
    if (key === "font") {
      events.renderFrameEvent.emit({
        frame_number: Math.floor(editorState.playbackTime * FPS),
        fps: FPS,
        resolution_base: OUTPUT_SIZE,
      });
    }
  };

  // Restore scroll position after any content changes
  createEffect(() => {
    // Track any size changes
    const _ = size.height;

    // Restore scroll position if we have one
    if (scrollContainerRef && scrollState.lastScrollTop > 0) {
      requestAnimationFrame(() => {
        scrollContainerRef!.scrollTop = scrollState.lastScrollTop;
      });
    }
  });

  // Add model selection state
  const [selectedModel, setSelectedModel] = createSignal(DEFAULT_MODEL);
  const [selectedLanguage, setSelectedLanguage] = createSignal("auto");
  const [downloadedModels, setDownloadedModels] = createSignal<string[]>([]);

  // States for captions
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

  // Ensure captions object is initialized in project config
  createEffect(() => {
    if (!project || !editorInstance) return;

    if (!project.captions) {
      // Initialize captions with default settings
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
          outline: true,
          outlineColor: "#000000",
          exportWithSubtitles: false,
        },
      });
    }
  });

  // Check downloaded models on mount
  onMount(async () => {
    try {
      // Check for downloaded models
      const appDataDirPath = await appLocalDataDir();
      const modelsPath = await join(appDataDirPath, MODEL_FOLDER);

      // Create models directory if it doesn't exist
      if (!(await exists(modelsPath))) {
        await commands.createDir(modelsPath, true);
      }

      // Check which models are already downloaded
      const models = await Promise.all(
        MODEL_OPTIONS.map(async (model) => {
          const downloaded = await checkModelExists(model.name);
          return { name: model.name, downloaded };
        })
      );

      // Set available models
      setDownloadedModels(
        models.filter((m) => m.downloaded).map((m) => m.name)
      );

      // Check if current model exists
      if (selectedModel()) {
        setModelExists(await checkModelExists(selectedModel()));
      }

      // Check if the video has audio
      if (editorInstance && editorInstance.recordings) {
        const hasAudioTrack = editorInstance.recordings.segments.some(
          (segment) => segment.mic !== null || segment.system_audio !== null
        );
        setHasAudio(hasAudioTrack);
      }

      // Restore download state if there was an ongoing download
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

  // Save download state when it changes
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

  // Effect to update current caption based on playback time
  createEffect(() => {
    if (!project?.captions?.segments || editorState.playbackTime === undefined)
      return;

    const time = editorState.playbackTime;
    const segments = project.captions.segments;

    // Binary search for the correct segment
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

    // Find the current segment using binary search
    const currentSegment = findSegment(time, segments);

    // Only update if the caption has changed
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

      // Create the directory if it doesn't exist
      const appDataDirPath = await appLocalDataDir();
      const modelsPath = await join(appDataDirPath, MODEL_FOLDER);
      const modelPath = await join(modelsPath, `${modelToDownload}.bin`);

      try {
        await commands.createDir(modelsPath, true);
      } catch (err) {
        console.error("Error creating directory:", err);
      }

      // Set up progress listener
      const unlisten = await events.downloadProgress.listen((event) => {
        setDownloadProgress(event.payload.progress);
      });

      // Download the model
      await commands.downloadWhisperModel(modelToDownload, modelPath);

      // Clean up listener
      unlisten();

      // Update downloaded models list
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

      // Verify file existence before proceeding
      const result = await commands.transcribeAudio(
        videoPath,
        currentModelPath,
        lang
      );

      if (result && result.segments.length > 0) {
        // Update project with the new segments
        setProject("captions", "segments", result.segments);
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

      // Provide more user-friendly error messages
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

  // Segment operations that update project directly
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
        segment.id === id ? { ...segment, ...updates } : segment
      )
    );
  };

  const addSegment = (time: number) => {
    if (!project?.captions) return;

    const id = `segment-${Date.now()}`;
    setProject("captions", "segments", [
      ...project.captions.segments,
      {
        id,
        start: time,
        end: time + 2,
        text: "New caption",
      },
    ]);
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

            // Reset scrolling flag after scroll ends
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
                {/* Model Selection and Download Section */}
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
                        if (value) setSelectedModel(value);
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

                {/* Language Selection */}
                <Subfield name="Language">
                  <KSelect<string>
                    options={LANGUAGE_OPTIONS.map((l) => l.code)}
                    value={selectedLanguage()}
                    onChange={(value: string | null) => {
                      if (value) setSelectedLanguage(value);
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

                {/* Generate Captions Button */}
                <Show when={hasAudio()}>
                  <Button
                    onClick={generateCaptions}
                    disabled={isGenerating()}
                    class="w-full"
                  >
                    {isGenerating() ? "Generating..." : "Generate Captions"}
                  </Button>
                </Show>

                {/* Font Settings */}
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

                    <div class="flex flex-col gap-2">
                      <span class="text-gray-500 text-sm">Font Color</span>
                      <RgbInput
                        value={captionSettings.color || "#FFFFFF"}
                        onChange={(value) =>
                          updateCaptionSetting("color", value)
                        }
                      />
                    </div>
                  </div>
                </Field>

                {/* Background Settings */}
                <Field
                  name="Background Settings"
                  icon={<IconCapMessageBubble />}
                >
                  <div class="space-y-3">
                    <div class="flex flex-col gap-2">
                      <span class="text-gray-500 text-sm">
                        Background Color
                      </span>
                      <RgbInput
                        value={captionSettings.backgroundColor || "#000000"}
                        onChange={(value) =>
                          updateCaptionSetting("backgroundColor", value)
                        }
                      />
                    </div>

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

                {/* Position Settings */}
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

                {/* Style Options */}
                <Field name="Style Options" icon={<IconCapMessageBubble />}>
                  <div class="space-y-3">
                    <div class="flex flex-col gap-4">
                      <Subfield name="Bold">
                        <Toggle
                          checked={captionSettings.bold}
                          onChange={(checked) =>
                            updateCaptionSetting("bold", checked)
                          }
                        />
                      </Subfield>
                      <Subfield name="Italic">
                        <Toggle
                          checked={captionSettings.italic}
                          onChange={(checked) =>
                            updateCaptionSetting("italic", checked)
                          }
                        />
                      </Subfield>
                      <Subfield name="Outline">
                        <Toggle
                          checked={captionSettings.outline}
                          onChange={(checked) =>
                            updateCaptionSetting("outline", checked)
                          }
                        />
                      </Subfield>
                    </div>

                    <Show when={captionSettings.outline}>
                      <div class="flex flex-col gap-2">
                        <span class="text-gray-500 text-sm">Outline Color</span>
                        <RgbInput
                          value={captionSettings.outlineColor || "#000000"}
                          onChange={(value) =>
                            updateCaptionSetting("outlineColor", value)
                          }
                        />
                      </div>
                    </Show>
                  </div>
                </Field>

                {/* Export Options */}
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

                {/* Caption Segments Section */}
                <Show when={project.captions?.segments.length}>
                  <Field
                    name="Caption Segments"
                    icon={<IconCapMessageBubble />}
                  >
                    <div class="space-y-4">
                      <div class="flex items-center justify-between">
                        <Button
                          onClick={() => addSegment(editorState.playbackTime)}
                          class="w-full"
                        >
                          Add at Current Time
                        </Button>
                      </div>

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
