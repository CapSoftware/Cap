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
import type { CaptionSettings, CaptionSegment } from "~/utils/tauri";
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
          exportWithSubtitles: false
        }
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
      const models = await Promise.all(MODEL_OPTIONS.map(async (model) => {
        const downloaded = await checkModelExists(model.name);
        return { name: model.name, downloaded };
      }));
      
      // Set available models
      setDownloadedModels(models.filter(m => m.downloaded).map(m => m.name));
      
      // Check if current model exists
      if (selectedModel()) {
        setModelExists(await checkModelExists(selectedModel()));
      }
      
      // Check if the video has audio
      if (editorInstance && editorInstance.recordings) {
        const hasAudioTrack = editorInstance.recordings.segments.some(
          segment => segment.audio !== null || segment.system_audio !== null
        );
        setHasAudio(hasAudioTrack);
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
  
  // Helper function to sync settings directly with project
  const updateCaptionSetting = (key: keyof CaptionSettings, value: any) => {
    if (!project?.captions) return;
    
    setProject("captions", "settings", key, value);
  };
  
  // Effect to update current caption based on playback time
  createEffect(() => {
    if (!project?.captions?.segments || playbackTime() === undefined) return;
    
    const time = playbackTime();
    const segments = project.captions.segments;
    
    // Binary search for the correct segment
    const findSegment = (time: number, segments: CaptionSegment[]): CaptionSegment | undefined => {
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
  
  const generateCaptions = async () => {
    if (!editorInstance) return;
    
    setIsGenerating(true);
    
    try {
      const videoPath = editorInstance.path;
      const lang = selectedLanguage();
      const currentModelPath = await join(await appLocalDataDir(), MODEL_FOLDER, `${selectedModel()}.bin`);
      
      const result = await commands.transcribeAudio(videoPath, currentModelPath, lang);
      
      if (result && result.segments.length > 0) {
        // Update project with the new segments
        setProject("captions", "segments", result.segments);
        updateCaptionSetting("enabled", true);
        toast.success("Captions generated successfully!");
      } else {
        toast.error("Failed to generate captions. No segments returned.");
      }
    } catch (error) {
      console.error("Error generating captions:", error);
      toast.error("Failed to generate captions: " + (error as Error).message);
    } finally {
      setIsGenerating(false);
    }
  };
  
  // Segment operations that update project directly
  const deleteSegment = (id: string) => {
    if (!project?.captions?.segments) return;
    
    setProject("captions", "segments", 
      project.captions.segments.filter(segment => segment.id !== id)
    );
  };

  const updateSegment = (id: string, updates: Partial<{start: number, end: number, text: string}>) => {
    if (!project?.captions?.segments) return;
    
    setProject("captions", "segments",
      project.captions.segments.map(segment => 
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
        text: "New caption" 
      }
    ]);
  };

  return (
    <div class="flex flex-col gap-6 h-full overflow-y-auto">
      <Field name="Captions" icon={<IconCapMessageBubble />}>
        <div class="flex flex-col gap-4">
          <Subfield name="Enable Captions">
            <Toggle
              checked={project.captions?.settings.enabled}
              onChange={(checked) => updateCaptionSetting("enabled", checked)}
            />
          </Subfield>

          <Show when={project.captions?.settings.enabled}>
            <div class="space-y-6">
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
                      <KSelect.Value<string> class="flex-1 text-left truncate">
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
                      <KSelect.Value<string> class="flex-1 text-left truncate">
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
                    <KSelect.Value<string> class="flex-1 text-left truncate">
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
                  onClick={generateCaptions}
                  disabled={isGenerating()}
                >
                  {isGenerating() ? 'Generating...' : 'Generate Captions'}
                </Button>
              </Show>

              <Field name="Font">
                <KSelect<string>
                  options={fontOptions.map(f => f.value)}
                  value={project.captions?.settings.font || "Arial"}
                  onChange={(value) => {
                    if (value === null) return;
                    updateCaptionSetting("font", value);
                  }}
                  itemComponent={(props) => (
                    <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
                      <KSelect.ItemLabel class="flex-1">
                        {fontOptions.find(f => f.value === props.item.rawValue)?.label}
                      </KSelect.ItemLabel>
                    </MenuItem>
                  )}
                >
                  <KSelect.Trigger class="w-full flex items-center justify-between rounded-lg shadow px-3 py-2 bg-white border border-gray-300">
                    <KSelect.Value<string>>
                      {(state) => fontOptions.find(f => f.value === state.selectedOption())?.label}
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
              </Field>

              <Field name="Size">
                <Slider
                  value={[project.captions?.settings.size || 24]}
                  onChange={(v) => updateCaptionSetting("size", v[0])}
                  minValue={12}
                  maxValue={48}
                  step={1}
                />
              </Field>

              <Field name="Font Color">
                <Input
                  type="color"
                  value={project.captions?.settings.color}
                  onChange={(e) => updateCaptionSetting("color", e.target.value)}
                />
              </Field>

              <Field name="Background Color">
                <Input
                  type="color"
                  value={project.captions?.settings.backgroundColor}
                  onChange={(e) => updateCaptionSetting("backgroundColor", e.target.value)}
                />
              </Field>

              <Field name="Background Opacity">
                <Slider
                  value={[project.captions?.settings.backgroundOpacity || 80]}
                  onChange={(v) => updateCaptionSetting("backgroundOpacity", v[0])}
                  minValue={0}
                  maxValue={100}
                  step={1}
                />
              </Field>

              <Field name="Position">
                <KSelect<string>
                  options={["top", "bottom"]}
                  value={project.captions?.settings.position || "bottom"}
                  onChange={(value) => {
                    if (value === null) return;
                    updateCaptionSetting("position", value);
                  }}
                  itemComponent={(props) => (
                    <MenuItem<typeof KSelect.Item> as={KSelect.Item} item={props.item}>
                      <KSelect.ItemLabel class="flex-1 capitalize">
                        {props.item.rawValue}
                      </KSelect.ItemLabel>
                    </MenuItem>
                  )}
                >
                  <KSelect.Trigger class="w-full flex items-center justify-between rounded-lg shadow px-3 py-2 bg-white border border-gray-300">
                    <KSelect.Value<string>>
                      {(state) => (
                        <span class="capitalize">{state.selectedOption()}</span>
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

              <Field name="Style Options">
                <div class="flex flex-col gap-4">
                  <Subfield name="Bold">
                    <Toggle
                      checked={project.captions?.settings.bold}
                      onChange={(checked) => updateCaptionSetting("bold", checked)}
                    />
                  </Subfield>
                  <Subfield name="Italic">
                    <Toggle
                      checked={project.captions?.settings.italic}
                      onChange={(checked) => updateCaptionSetting("italic", checked)}
                    />
                  </Subfield>
                  <Subfield name="Outline">
                    <Toggle
                      checked={project.captions?.settings.outline}
                      onChange={(checked) => updateCaptionSetting("outline", checked)}
                    />
                  </Subfield>
                </div>
              </Field>

              <Show when={project.captions?.settings.outline}>
                <Field name="Outline Color">
                  <Input
                    type="color"
                    value={project.captions?.settings.outlineColor}
                    onChange={(e) => updateCaptionSetting("outlineColor", e.target.value)}
                  />
                </Field>
              </Show>

              <Field name="Export Options">
                <Subfield name="Export with Subtitles">
                  <Toggle
                    checked={project.captions?.settings.exportWithSubtitles}
                    onChange={(checked) => updateCaptionSetting("exportWithSubtitles", checked)}
                  />
                </Subfield>
              </Field>
              
              {/* Add Caption Segments Section */}
              <Show when={project.captions?.segments.length}>
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
                    {project.captions?.segments.length === 0 ? (
                      <p class="text-sm text-gray-500">No caption segments found.</p>
                    ) : (
                      project.captions?.segments.map((segment) => (
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
