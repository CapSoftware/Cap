import {
  batch,
  createEffect,
  createResource,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  For,
} from "solid-js";
import { createStore } from "solid-js/store";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { exists, BaseDirectory } from "@tauri-apps/plugin-fs";
import { EditorButton, Field, Slider, Subfield, Toggle, Input } from "./ui";
import { useEditorContext } from "./context";
import { commands, events } from "~/utils/tauri";
import { invoke } from "@tauri-apps/api/core";
import toast from "solid-toast";
import { listen } from "@tauri-apps/api/event";
import { captionsStore } from "~/store/captions";
import IconCapMessageBubble from "~icons/cap/message-bubble";
import IconCapDownload from "~icons/cap/download";
import IconCapRestart from "~icons/cap/restart";
import IconCapChevronDown from "~icons/cap/chevron-down";
import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { MenuItem, MenuItemList, PopperContent } from "./ui";
import { topLeftAnimateClasses } from "./ui";

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
  { name: "large-v3", label: "Large (3GB) - Slowest, most accurate" }
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
      class={`px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors ${props.class || ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  );
}

const fontOptions: FontOption[] = [
  { label: "Arial", value: "Arial" },
  { label: "Roboto", value: "Roboto" },
  { label: "Helvetica", value: "Helvetica" },
  { label: "Montserrat", value: "Montserrat" },
  { label: "Open Sans", value: "Open Sans" },
];

// Add type definitions at the top
interface CaptionSegment {
  id: string;
  start: number;
  end: number;
  text: string;
}

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
  return `#${rgb.map(x => x.toString(16).padStart(2, '0')).join('')}`;
}

export function CaptionsTab() {
  const { project, setProject, editorInstance, playbackTime } = useEditorContext();
  
  // Add model selection state
  const [selectedModel, setSelectedModel] = createSignal(DEFAULT_MODEL);
  const [selectedLanguage, setSelectedLanguage] = createSignal("auto");
  const [downloadedModels, setDownloadedModels] = createSignal<string[]>([]);
  
  // States for captions
  const [modelExists, setModelExists] = createSignal(false);
  const [isDownloading, setIsDownloading] = createSignal(false);
  const [downloadProgress, setDownloadProgress] = createSignal(0);
  const [downloadingModel, setDownloadingModel] = createSignal<string | null>(null);
  const [isGenerating, setIsGenerating] = createSignal(false);
  const [hasAudio, setHasAudio] = createSignal(false);
  const [modelPath, setModelPath] = createSignal("");
  
  // Define the captions configuration type to match our needs
  type CaptionsSettings = {
    enabled: boolean;
    font: string;
    size: number;
    color: string;
    background_color: string;
    background_opacity: number;
    position: string; // "top", "bottom", "middle"
    bold: boolean;
    italic: boolean;
    outline: boolean;
    outline_color: string;
    export_with_subtitles: boolean;
  };
  
  // Caption styling settings
  const [captionSettings, setCaptionSettings] = createStore<CaptionsSettings>({
    enabled: false,
    font: "Arial",
    size: 24,
    color: "#FFFFFF",
    background_color: "#000000",
    background_opacity: 80,
    position: "bottom", // "top", "bottom", "middle"
    bold: true,
    italic: false,
    outline: true,
    outline_color: "#000000",
    export_with_subtitles: true,
  });
  
  const [captions, setCaptions] = createStore<{
    segments: Array<CaptionSegment>;
  }>({
    segments: [],
  });

  // Function to check if a model is downloaded
  const checkModelExists = async (modelName: string) => {
    const appDataDirPath = await appLocalDataDir();
    const modelsPath = await join(appDataDirPath, MODEL_FOLDER);
    const modelPath = await join(modelsPath, `${modelName}.bin`);
    return await commands.checkModelExists(modelPath);
  };

  // Check downloaded models on mount
  onMount(async () => {
    try {
      const appDataDirPath = await appLocalDataDir();
      const modelsPath = await join(appDataDirPath, MODEL_FOLDER);
      
      // Check which models are downloaded
      const downloaded = await Promise.all(
        MODEL_OPTIONS.map(async (model) => {
          const exists = await checkModelExists(model.name);
          return exists ? model.name : null;
        })
      );
      
      setDownloadedModels(downloaded.filter((name): name is string => name !== null));
      
      // Set initial selected model to first downloaded one or default
      const initialModel = downloaded.find((name) => name !== null) || DEFAULT_MODEL;
      setSelectedModel(initialModel);
      setModelExists(await checkModelExists(initialModel));

      // Check if the video has audio
      if (editorInstance && editorInstance.recordings) {
        const hasAudioTrack = editorInstance.recordings.segments.some(
          (segment) => segment.audio !== null
        );
        setHasAudio(hasAudioTrack);
      }
      
      // Load captions data
      if (editorInstance && editorInstance.path) {
        try {
          // Clean the video ID by removing .cap extension and getting the last part of the path
          const videoId = editorInstance.path.split('/').pop()?.replace('.cap', '') || '';
          const captionsData = await commands.loadCaptions(videoId);
          
          if (captionsData && (captionsData as CaptionsResponse).segments) {
            setCaptions({ segments: (captionsData as CaptionsResponse).segments });
            setCaptionSettings("enabled", true);
          } else {
            try {
              const localCaptionsData = JSON.parse(localStorage.getItem(`captions-${videoId}`) || '{}');
              if (localCaptionsData.segments && Array.isArray(localCaptionsData.segments)) {
                setCaptions({ segments: localCaptionsData.segments });
              }
              if (localCaptionsData.settings) {
                setCaptionSettings(localCaptionsData.settings);
              }
            } catch (e) {
              console.error("Error loading saved captions from localStorage:", e);
            }
          }
        } catch (e) {
          console.error("Error loading saved captions:", e);
        }
      }

      // Restore download state if there was an ongoing download
      const downloadState = localStorage.getItem('modelDownloadState');
      if (downloadState) {
        const { model, progress } = JSON.parse(downloadState);
        if (model && progress < 100) {
          setDownloadingModel(model);
          setDownloadProgress(progress);
          setIsDownloading(true);
        } else {
          localStorage.removeItem('modelDownloadState');
        }
      }
    } catch (error) {
      console.error("Error checking models:", error);
    }
  });

  // Save download state when it changes
  createEffect(() => {
    if (isDownloading() && downloadingModel()) {
      localStorage.setItem('modelDownloadState', JSON.stringify({
        model: downloadingModel(),
        progress: downloadProgress()
      }));
    } else {
      localStorage.removeItem('modelDownloadState');
    }
  });

  // Function to download the model
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
      setDownloadedModels(prev => [...prev, modelToDownload]);
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
  
  // Function to generate captions
  const generateCaptions = async () => {
    try {
      if (!editorInstance || !editorInstance.recordings) {
        toast.error("No video available to transcribe");
        return;
      }
      
      setIsGenerating(true);
      
      // Get the first segment with audio
      const firstSegment = editorInstance.recordings.segments[0];
      if (!firstSegment || (!firstSegment.audio && !firstSegment.system_audio)) {
        toast.error("No audio recording found");
        return;
      }

      // Use either microphone audio or system audio, preferring microphone audio
      const audioPath = firstSegment.audio ? 
        `${editorInstance.path}/content/segments/segment-0/audio-input.ogg` :
        `${editorInstance.path}/content/segments/segment-0/system_audio.ogg`;
      
      try {
        // Construct the model path
        const appDataDirPath = await appLocalDataDir();
        const modelsPath = await join(appDataDirPath, MODEL_FOLDER);
        const modelPath = await join(modelsPath, `${selectedModel()}.bin`);
        
        // Use commands to transcribe audio
        const transcriptionResult = await commands.transcribeAudio(audioPath, modelPath, selectedLanguage());
        
        // Update captions in the store
        captionsStore.updateSegments(transcriptionResult.segments);
        captionsStore.updateSettings({ enabled: true });
        
        // Save the captions
        if (editorInstance.path) {
          // Clean the video ID by removing .cap extension and getting the last part of the path
          const videoId = editorInstance.path.split('/').pop()?.replace('.cap', '') || '';
          await captionsStore.saveCaptions(videoId);
        }
        
        toast.success("Captions generated successfully!");
      } catch (error: any) {
        if (error.toString().includes("No audio stream found")) {
          toast.error("This video does not contain any audio to transcribe");
        } else {
          console.error("Error generating captions:", error);
          toast.error("Failed to generate captions");
        }
      }
    } catch (error) {
      console.error("Error in caption generation process:", error);
      toast.error("Failed to generate captions");
    } finally {
      setIsGenerating(false);
    }
  };
  
  // Function to delete a caption segment
  const deleteSegment = (id: string) => {
    const newSegments = captionsStore.state.segments.filter(segment => segment.id !== id);
    captionsStore.updateSegments(newSegments);
  };
  
  // Function to update a caption segment
  const updateSegment = (id: string, updates: Partial<{start: number, end: number, text: string}>) => {
    const newSegments = captionsStore.state.segments.map(segment => 
      segment.id === id ? { ...segment, ...updates } : segment
    );
    captionsStore.updateSegments(newSegments);
  };
  
  // Function to add a new caption segment
  const addSegment = (time: number) => {
    const id = `segment-${Date.now()}`;
    const newSegments = [
      ...captionsStore.state.segments,
      { 
        id, 
        start: time, 
        end: time + 2, // Default 2 seconds duration
        text: "New caption" 
      }
    ];
    captionsStore.updateSegments(newSegments);
  };

  // Add effect to save settings to localStorage when they change
  createEffect(() => {
    if (editorInstance && editorInstance.path) {
      const saveData = {
        segments: captions.segments,
        settings: captionSettings
      };
      localStorage.setItem(`captions-${editorInstance.path}`, JSON.stringify(saveData));
    }
  });

  return (
    <div class="flex flex-col gap-6">
      <Field name="Captions" icon={<IconCapMessageBubble />}>
        <div class="flex flex-col gap-4">
          <Subfield name="Enable Captions">
            <Toggle
              checked={captionsStore.state.settings.enabled}
              onChange={(checked) => captionsStore.updateSettings({ enabled: checked })}
            />
          </Subfield>

          <Show when={captionsStore.state.settings.enabled}>
            <div class="flex flex-col gap-4">
              {/* Model Selection and Download Section */}
              <div class="space-y-4">
                <div class="space-y-2">
                  <label class="text-xs text-gray-500">Current Model</label>
                  <KSelect<string>
                    options={MODEL_OPTIONS.filter(m => downloadedModels().includes(m.name)).map(m => m.name)}
                    value={selectedModel()}
                    onChange={(value: string | null) => {
                      if (value) {
                        setSelectedModel(value);
                        setModelExists(downloadedModels().includes(value));
                      }
                    }}
                    itemComponent={(props) => (
                      <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
                        <KSelect.ItemLabel class="flex-1">
                          {MODEL_OPTIONS.find(m => m.name === props.item.rawValue)?.label}
                        </KSelect.ItemLabel>
                      </MenuItem>
                    )}
                  >
                    <KSelect.Trigger class="flex flex-row items-center h-9 px-3 gap-2 border rounded-lg border-gray-200 w-full text-gray-700 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors">
                      <KSelect.Value class="flex-1 text-left truncate">
                        {(state) => {
                          const model = MODEL_OPTIONS.find(m => m.name === state.selectedOption());
                          return <span>{model?.label || "Select a model"}</span>;
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

                <div class="space-y-2 mt-4">
                  <label class="text-xs text-gray-500">Download New Model</label>
                  <KSelect<string>
                    options={MODEL_OPTIONS.map(m => m.name)}
                    value={selectedModel()}
                    onChange={(value: string | null) => {
                      if (value) setSelectedModel(value);
                    }}
                    disabled={isDownloading()}
                    itemComponent={(props) => (
                      <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
                        <KSelect.ItemLabel class="flex-1">
                          {MODEL_OPTIONS.find(m => m.name === props.item.rawValue)?.label}
                          {downloadedModels().includes(props.item.rawValue) ? ' (Downloaded)' : ''}
                        </KSelect.ItemLabel>
                      </MenuItem>
                    )}
                  >
                    <KSelect.Trigger class="flex flex-row items-center h-9 px-3 gap-2 border rounded-lg border-gray-200 w-full text-gray-700 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors">
                      <KSelect.Value class="flex-1 text-left truncate">
                        {(state) => {
                          const model = MODEL_OPTIONS.find(m => m.name === state.selectedOption());
                          return <span>{model?.label || "Select a model"}</span>;
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
                      disabled={isDownloading() || downloadedModels().includes(selectedModel())}
                    >
                      Download {MODEL_OPTIONS.find(m => m.name === selectedModel())?.label}
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
                      Downloading {MODEL_OPTIONS.find(m => m.name === downloadingModel())?.label}: {Math.round(downloadProgress())}%
                    </p>
                  </div>
                </Show>
              </div>

              {/* Language Selection */}
              <Subfield name="Language">
                <KSelect<string>
                  options={LANGUAGE_OPTIONS.map(l => l.code)}
                  value={selectedLanguage()}
                  onChange={(value: string | null) => {
                    if (value) setSelectedLanguage(value);
                  }}
                  itemComponent={(props) => (
                    <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
                      <KSelect.ItemLabel class="flex-1">
                        {LANGUAGE_OPTIONS.find(l => l.code === props.item.rawValue)?.label}
                      </KSelect.ItemLabel>
                    </MenuItem>
                  )}
                >
                  <KSelect.Trigger class="flex flex-row items-center h-9 px-3 gap-2 border rounded-lg border-gray-200 w-full text-gray-700 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors">
                    <KSelect.Value class="flex-1 text-left truncate">
                      {(state) => {
                        const language = LANGUAGE_OPTIONS.find(l => l.code === state.selectedOption());
                        return <span>{language?.label || "Select a language"}</span>;
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
                  // leftIcon={<IconCapRestart class="w-4 h-4" />}
                  onClick={generateCaptions}
                  disabled={isGenerating()}
                >
                  {isGenerating() ? 'Generating...' : 'Generate Captions'}
                </Button>
              </Show>

              {/* Caption Settings */}
              <Show when={captionsStore.state.segments.length > 0}>
                <div class="flex flex-col gap-4">
                  {/* Export Settings Section - Moved to top */}
                  <div class="mb-6 bg-blue-50 rounded-lg p-4 border border-blue-100">
                    <h3 class="text-sm font-medium text-blue-800 mb-2 flex items-center gap-2">
                      <IconCapDownload class="w-4 h-4" />
                      Export Settings
                    </h3>
                    <Subfield name="Include Subtitles">
                      <Toggle
                        checked={captionsStore.state.settings.export_with_subtitles ?? true}
                        onChange={(checked) => captionsStore.updateSettings({ export_with_subtitles: checked })}
                      />
                    </Subfield>
                  </div>

                  <div class="space-y-6">
                    {/* Caption Style Section */}
                    <div class="bg-white rounded-lg p-4 border border-gray-200">
                      <h3 class="text-sm font-medium text-gray-800 mb-4 flex items-center gap-2">
                        <IconCapMessageBubble class="w-4 h-4" />
                        Caption Style
                      </h3>

                      <div class="space-y-4">
                        <Subfield name="Font">
                          <KSelect<string>
                            options={fontOptions.map(f => f.value)}
                            value={captionsStore.state.settings.font}
                            onChange={(value: string | null) => {
                              if (value) captionsStore.updateSettings({ font: value });
                            }}
                            itemComponent={(props) => (
                              <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
                                <KSelect.ItemLabel class="flex-1">
                                  {fontOptions.find(f => f.value === props.item.rawValue)?.label}
                                </KSelect.ItemLabel>
                              </MenuItem>
                            )}
                          >
                            <KSelect.Trigger class="flex flex-row items-center h-9 px-3 gap-2 border rounded-lg border-gray-200 w-full text-gray-700 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors">
                              <KSelect.Value class="flex-1 text-left truncate">
                                {(state) => {
                                  const font = fontOptions.find(f => f.value === state.selectedOption());
                                  return <span>{font?.label}</span>;
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

                        <div class="grid grid-cols-2 gap-4">
                          <div class="space-y-4">
                            <Subfield name="Size">
                              <div class="flex flex-col gap-2">
                                <input
                                  type="range"
                                  class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                  min={12}
                                  max={48}
                                  step={1}
                                  value={captionsStore.state.settings.size}
                                  onChange={(e) => captionsStore.updateSettings({ size: parseInt(e.target.value) })}
                                />
                                <div class="text-xs text-gray-500 text-right">{captionsStore.state.settings.size}px</div>
                              </div>
                            </Subfield>

                            <Subfield name="Text Color">
                              <div class="flex items-center gap-2">
                                <input
                                  type="color"
                                  class="w-8 h-8 rounded border border-gray-200"
                                  value={captionsStore.state.settings.color}
                                  onChange={(e) => captionsStore.updateSettings({ color: e.currentTarget.value })}
                                />
                                <span class="text-xs text-gray-500 uppercase">{captionsStore.state.settings.color}</span>
                              </div>
                            </Subfield>
                          </div>

                          <div class="space-y-4">
                            <Subfield name="Position">
                              <KSelect<string>
                                options={["top", "middle", "bottom"]}
                                value={captionsStore.state.settings.position}
                                onChange={(value: string | null) => {
                                  if (value) captionsStore.updateSettings({ position: value });
                                }}
                                itemComponent={(props) => (
                                  <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
                                    <KSelect.ItemLabel class="flex-1 capitalize">
                                      {props.item.rawValue}
                                    </KSelect.ItemLabel>
                                  </MenuItem>
                                )}
                              >
                                <KSelect.Trigger class="flex flex-row items-center h-9 px-3 gap-2 border rounded-lg border-gray-200 w-full text-gray-700 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors">
                                  <KSelect.Value class="flex-1 text-left truncate capitalize">
                                    {(state) => <span>{state.selectedOption() as string}</span>}
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
                                      class="w-full"
                                      as={KSelect.Listbox}
                                    />
                                  </PopperContent>
                                </KSelect.Portal>
                              </KSelect>
                            </Subfield>

                            {/* Text Style Options */}
                            <div class="grid grid-cols-2 gap-2">
                              <Subfield name="Bold">
                                <Toggle
                                  checked={captionsStore.state.settings.bold}
                                  onChange={(checked) => captionsStore.updateSettings({ bold: checked })}
                                />
                              </Subfield>

                              <Subfield name="Italic">
                                <Toggle
                                  checked={captionsStore.state.settings.italic}
                                  onChange={(checked) => captionsStore.updateSettings({ italic: checked })}
                                />
                              </Subfield>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Background Settings Section */}
                    <div class="bg-white rounded-lg p-4 border border-gray-200">
                      <h3 class="text-sm font-medium text-gray-800 mb-4">Background</h3>
                      
                      <div class="space-y-4">
                        <Subfield name="Color">
                          <div class="flex items-center gap-2">
                            <input
                              type="color"
                              class="w-8 h-8 rounded border border-gray-200"
                              value={captionsStore.state.settings.background_color}
                              onChange={(e) => captionsStore.updateSettings({ background_color: e.currentTarget.value })}
                            />
                            <span class="text-xs text-gray-500 uppercase">{captionsStore.state.settings.background_color}</span>
                          </div>
                        </Subfield>

                        <Subfield name="Opacity">
                          <div class="flex flex-col gap-2">
                            <input
                              type="range"
                              class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                              min={0}
                              max={100}
                              step={1}
                              value={captionsStore.state.settings.background_opacity}
                              onChange={(e) => captionsStore.updateSettings({ background_opacity: parseInt(e.target.value) })}
                            />
                            <div class="text-xs text-gray-500 text-right">{captionsStore.state.settings.background_opacity}%</div>
                          </div>
                        </Subfield>
                      </div>
                    </div>

                    {/* Outline Settings Section */}
                    <div class="bg-white rounded-lg p-4 border border-gray-200">
                      <h3 class="text-sm font-medium text-gray-800 mb-4">Outline</h3>
                      
                      <div class="space-y-4">
                        <Subfield name="Enable Outline">
                          <Toggle
                            checked={captionsStore.state.settings.outline}
                            onChange={(checked) => captionsStore.updateSettings({ outline: checked })}
                          />
                        </Subfield>

                        <Show when={captionsStore.state.settings.outline}>
                          <Subfield name="Color">
                            <div class="flex items-center gap-2">
                              <input
                                type="color"
                                class="w-8 h-8 rounded border border-gray-200"
                                value={captionsStore.state.settings.outline_color}
                                onChange={(e) => captionsStore.updateSettings({ outline_color: e.currentTarget.value })}
                              />
                              <span class="text-xs text-gray-500 uppercase">{captionsStore.state.settings.outline_color}</span>
                            </div>
                          </Subfield>
                        </Show>
                      </div>
                    </div>
                  </div>

                  {/* Add Caption Segments Section */}
                  <div class="space-y-4 mt-4">
                    <div class="flex items-center justify-between">
                      <h3 class="text-sm font-medium text-gray-800 mb-2 flex items-center gap-2">
                        <IconCapMessageBubble class="w-4 h-4" />
                        Caption Segments
                      </h3>
                      <Button
                        onClick={() => addSegment(playbackTime())}
                      >
                        Add at Current Time
                      </Button>
                    </div>
                    
                    <div class="max-h-[300px] overflow-y-auto space-y-3 pr-2">
                      {captionsStore.state.segments.length === 0 ? (
                        <p class="text-sm text-gray-500">No caption segments found.</p>
                      ) : (
                        captionsStore.state.segments.map((segment) => (
                          <div class="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
                            <div class="flex items-center justify-between">
                              <div class="flex space-x-4">
                                <div class="space-y-1">
                                  <label class="text-xs text-gray-500">Start</label>
                                  <Input
                                    type="number"
                                    class="w-24"
                                    value={segment.start.toFixed(1)}
                                    step="0.1"
                                    min={0}
                                    onChange={(e) => updateSegment(segment.id, { start: parseFloat(e.target.value) })}
                                  />
                                </div>
                                <div class="space-y-1">
                                  <label class="text-xs text-gray-500">End</label>
                                  <Input
                                    type="number"
                                    class="w-24"
                                    value={segment.end.toFixed(1)}
                                    step="0.1"
                                    min={segment.start}
                                    onChange={(e) => updateSegment(segment.id, { end: parseFloat(e.target.value) })}
                                  />
                                </div>
                              </div>
                              <Button
                                variant="white"
                                class="text-gray-400 hover:text-red-500 transition-colors p-1"
                                onClick={() => deleteSegment(segment.id)}
                              >
                                <IconDelete />
                              </Button>
                            </div>
                            <div class="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 transition-colors">
                              <textarea
                                class="w-full resize-none outline-none"
                                value={segment.text}
                                rows={2}
                                onChange={(e) => updateSegment(segment.id, { text: e.target.value })}
                              />
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Field>
    </div>
  );
}

function IconDelete() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/>
    </svg>
  );
}
