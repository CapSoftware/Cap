import {
  createSignal,
  createMemo,
  For,
  Show,
  onMount,
  createEffect,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Button } from "@cap/ui-solid";
import { cx } from "cva";
import toast from "solid-toast";
import { fetch } from "@tauri-apps/plugin-http";
import {
  commands,
  type ProjectConfiguration,
  type AspectRatio,
} from "~/utils/tauri";
import { clientEnv } from "~/utils/env";
import { maybeProtectedHeaders } from "~/utils/web-api";
import { useEditorContext } from "./context";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";

// Available background presets
const AVAILABLE_WALLPAPERS = [
  // macOS wallpapers
  "macOS/sequoia-dark",
  "macOS/sequoia-light",
  "macOS/sonoma-clouds",
  "macOS/sonoma-dark",
  "macOS/sonoma-evening",
  "macOS/sonoma-fromabove",
  "macOS/sonoma-horizon",
  "macOS/sonoma-light",
  "macOS/sonoma-river",
  "macOS/ventura-dark",
  "macOS/ventura-semi-dark",
  "macOS/ventura",
  // Blue wallpapers
  "blue/1",
  "blue/2",
  "blue/3",
  "blue/4",
  "blue/5",
  "blue/6",
  // Purple wallpapers
  "purple/1",
  "purple/2",
  "purple/3",
  "purple/4",
  "purple/5",
  "purple/6",
  // Dark wallpapers
  "dark/1",
  "dark/2",
  "dark/3",
  "dark/4",
  "dark/5",
  "dark/6",
  // Orange wallpapers
  "orange/1",
  "orange/2",
  "orange/3",
  "orange/4",
  "orange/5",
  "orange/6",
  "orange/7",
  "orange/8",
  "orange/9",
];

const AVAILABLE_COLORS = [
  "#FF0000",
  "#FF4500",
  "#FF8C00",
  "#FFD700",
  "#FFFF00",
  "#ADFF2F",
  "#32CD32",
  "#008000",
  "#00CED1",
  "#4785FF",
  "#0000FF",
  "#4B0082",
  "#800080",
  "#A9A9A9",
  "#FFFFFF",
  "#000000",
];

const AVAILABLE_GRADIENTS = [
  { from: [15, 52, 67], to: [52, 232, 158] },
  { from: [34, 193, 195], to: [253, 187, 45] },
  { from: [29, 253, 251], to: [195, 29, 253] },
  { from: [69, 104, 220], to: [176, 106, 179] },
  { from: [106, 130, 251], to: [252, 92, 125] },
  { from: [131, 58, 180], to: [253, 29, 29] },
  { from: [249, 212, 35], to: [255, 78, 80] },
  { from: [255, 94, 0], to: [255, 42, 104] },
  { from: [255, 0, 150], to: [0, 204, 255] },
  { from: [0, 242, 96], to: [5, 117, 230] },
  { from: [238, 205, 163], to: [239, 98, 159] },
  { from: [44, 62, 80], to: [52, 152, 219] },
  { from: [168, 239, 255], to: [238, 205, 163] },
  { from: [74, 0, 224], to: [143, 0, 255] },
  { from: [252, 74, 26], to: [247, 183, 51] },
  { from: [0, 255, 255], to: [255, 20, 147] },
  { from: [255, 127, 0], to: [255, 255, 0] },
  { from: [255, 0, 255], to: [0, 255, 0] },
];

// Map of aspect ratio strings to their dimensions
const ASPECT_RATIO_MAP = {
  wide: { width: 16, height: 9 },
  vertical: { width: 9, height: 16 },
  square: { width: 1, height: 1 },
  classic: { width: 4, height: 3 },
  tall: { width: 3, height: 4 },
};

// Function to convert aspect ratio object to predefined string
function normalizeAspectRatio(aspectRatio: any): AspectRatio | null {
  if (!aspectRatio) return null;

  // If it's already a string and valid, return it
  if (typeof aspectRatio === "string" && aspectRatio in ASPECT_RATIO_MAP) {
    return aspectRatio as AspectRatio;
  }

  // If it's an object with width and height, try to match it to a predefined ratio
  if (
    aspectRatio &&
    typeof aspectRatio === "object" &&
    "width" in aspectRatio &&
    "height" in aspectRatio
  ) {
    const ratio = aspectRatio.width / aspectRatio.height;

    // Check each predefined aspect ratio
    for (const [key, dimensions] of Object.entries(ASPECT_RATIO_MAP)) {
      const predefinedRatio = dimensions.width / dimensions.height;
      // Allow small tolerance for floating point comparison
      if (Math.abs(ratio - predefinedRatio) < 0.01) {
        return key as AspectRatio;
      }
    }
  }

  // If no match found, return null (auto)
  return null;
}

// Temporary type definitions until TypeScript bindings are regenerated
interface VideoContentAnalysis {
  frames: FrameAnalysis[];
  objectTimelines: ObjectTimeline[];
  sceneSegments: SceneSegment[];
}

interface FrameAnalysis {
  timestamp: number;
  objects: DetectedObject[];
  sceneDescription: string;
  dominantColors: string[];
  motionIntensity: number;
}

interface DetectedObject {
  label: string;
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  attributes: string[];
}

interface ObjectTimeline {
  label: string;
  appearances: TimeRange[];
  attributes: string[];
}

interface TimeRange {
  start: number;
  end: number;
}

interface SceneSegment {
  start: number;
  end: number;
  description: string;
  tags: string[];
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  status?: "pending" | "success" | "error";
  appliedConfig?: ProjectConfiguration;
}

interface AIAssistantState {
  isOpen: boolean;
  isExpanded: boolean;
  messages: Message[];
  input: string;
  isLoading: boolean;
  configHistory: ProjectConfiguration[];
  currentHistoryIndex: number;
  videoContent: VideoContentAnalysis | null;
  isAnalyzingVideo: boolean;
}

// Helper function for safe cloning
function safeClone<T>(obj: T): T {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (error) {
    console.error("Failed to clone object:", error);
    return obj;
  }
}

export function AIAssistant() {
  const { project, setProject, editorInstance, meta } = useEditorContext();

  const [state, setState] = createStore<AIAssistantState>({
    isOpen: false,
    isExpanded: false,
    messages: [],
    input: "",
    isLoading: false,
    configHistory: [],
    currentHistoryIndex: -1,
    videoContent: null,
    isAnalyzingVideo: false,
  });

  let inputRef: HTMLTextAreaElement | undefined;
  let messagesEndRef: HTMLDivElement | undefined;

  // Initialize with the current config
  onMount(() => {
    setState("configHistory", [safeClone(project)]);
    setState("currentHistoryIndex", 0);
  });

  // Auto-scroll to bottom when new messages are added
  createEffect(() => {
    if (state.messages.length && messagesEndRef) {
      messagesEndRef.scrollIntoView({ behavior: "smooth" });
    }
  });

  // Auto-focus input when overlay opens
  createEffect(() => {
    if (state.isOpen && inputRef) {
      // Small delay to ensure the overlay is rendered
      setTimeout(() => inputRef?.focus(), 150);
    }
  });

  const canUndo = createMemo(() => state.currentHistoryIndex > 0);
  const canRedo = createMemo(
    () => state.currentHistoryIndex < state.configHistory.length - 1
  );

  const lastMessage = createMemo(() => {
    const messages = state.messages;
    if (messages.length === 0) return null;
    // Find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return messages[i];
      }
    }
    return null;
  });

  const addMessage = (
    role: Message["role"],
    content: string,
    appliedConfig?: ProjectConfiguration
  ) => {
    const message: Message = {
      id: crypto.randomUUID(),
      role,
      content,
      timestamp: new Date(),
      status: role === "user" ? "success" : "pending",
      appliedConfig,
    };
    setState("messages", [...state.messages, message]);
    return message.id;
  };

  const updateMessageStatus = (id: string, status: Message["status"]) => {
    setState("messages", (messages) =>
      messages.map((msg) => (msg.id === id ? { ...msg, status } : msg))
    );
  };

  const resolveWallpaperPath = async (wallpaperId: string) => {
    try {
      const resolvedPath = await resolveResource(
        `assets/backgrounds/${wallpaperId}.jpg`
      );
      return resolvedPath;
    } catch (error) {
      console.error("Failed to resolve wallpaper path:", error);
      return wallpaperId; // Fallback to ID if resolution fails
    }
  };

  const applyConfiguration = async (newConfig: ProjectConfiguration) => {
    try {
      // Normalize the aspect ratio before applying
      const normalizedConfig = {
        ...newConfig,
        aspectRatio: normalizeAspectRatio(newConfig.aspectRatio),
      };

      // Resolve wallpaper paths if they are IDs
      let resolvedConfig = normalizedConfig;
      if (
        normalizedConfig.background.source.type === "wallpaper" &&
        normalizedConfig.background.source.path &&
        AVAILABLE_WALLPAPERS.includes(normalizedConfig.background.source.path)
      ) {
        const resolvedPath = await resolveWallpaperPath(
          normalizedConfig.background.source.path
        );
        resolvedConfig = {
          ...normalizedConfig,
          background: {
            ...normalizedConfig.background,
            source: {
              ...normalizedConfig.background.source,
              path: resolvedPath,
            },
          },
        };
      }

      // Apply the resolved configuration
      setProject(resolvedConfig);

      // Save to backend
      await commands.setProjectConfig(resolvedConfig);

      // Add to history
      setState(
        "configHistory",
        produce((history) => {
          // Remove any history after current index (for redo functionality)
          history.splice(state.currentHistoryIndex + 1);
          // Add new config
          history.push(safeClone(resolvedConfig));
        })
      );
      setState("currentHistoryIndex", state.configHistory.length);

      return true;
    } catch (error) {
      console.error("Failed to apply configuration:", error);
      toast.error("Failed to apply changes");
      return false;
    }
  };

  const undo = async () => {
    if (!canUndo()) return;

    const newIndex = state.currentHistoryIndex - 1;
    const config = state.configHistory[newIndex];

    setProject(config);
    await commands.setProjectConfig(config);
    setState("currentHistoryIndex", newIndex);

    toast("Reverted to previous configuration");
  };

  const redo = async () => {
    if (!canRedo()) return;

    const newIndex = state.currentHistoryIndex + 1;
    const config = state.configHistory[newIndex];

    setProject(config);
    await commands.setProjectConfig(config);
    setState("currentHistoryIndex", newIndex);

    toast("Applied next configuration");
  };

  const analyzeVideo = async () => {
    setState("isAnalyzingVideo", true);

    try {
      // TODO: Uncomment when TypeScript bindings are regenerated
      // const content = await commands.analyzeVideoContent(
      //   editorInstance.path,
      //   2.0
      // );

      // For now, use mock data to demonstrate the UI
      const content: VideoContentAnalysis = {
        frames: [],
        objectTimelines: [],
        sceneSegments: [],
      };

      setState("videoContent", content);
      toast.success("Video analysis complete!");
    } catch (error) {
      console.error("Failed to analyze video:", error);
      toast.error("Failed to analyze video content");
    } finally {
      setState("isAnalyzingVideo", false);
    }
  };

  const handleSubmit = async (e?: Event) => {
    e?.preventDefault();

    const input = state.input.trim();
    if (!input || state.isLoading) return;

    // Add user message
    addMessage("user", input);
    setState("input", "");
    setState("isLoading", true);

    // Create assistant message
    const assistantMessageId = addMessage("assistant", "Thinking...");

    try {
      // Get auth headers if available
      const authHeaders = await maybeProtectedHeaders();

      // Build headers object
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (authHeaders.authorization) {
        headers.authorization = authHeaders.authorization;
      }

      // Call the API
      const response = await fetch(
        `${clientEnv.VITE_SERVER_URL}/api/desktop/ai-editor`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            prompt: input,
            currentConfig: project,
            editorContext: {
              hasCamera: editorInstance.recordings.segments.some(
                (s) => s.camera !== null
              ),
              hasAudio: editorInstance.recordings.segments.some(
                (s) => s.mic !== null || s.system_audio !== null
              ),
              hasCursor:
                meta().type === "multiple" &&
                !!(meta() as any).segments[0].cursor,
              duration: editorInstance.recordingDuration,
            },
            videoContent: state.videoContent,
            conversationHistory: state.messages.map((msg) => ({
              role: msg.role,
              content: msg.content,
            })),
            availableBackgrounds: {
              wallpapers: AVAILABLE_WALLPAPERS,
              colors: AVAILABLE_COLORS,
              gradients: AVAILABLE_GRADIENTS,
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      // Update assistant message with the response
      setState("messages", (messages) =>
        messages.map((msg) =>
          msg.id === assistantMessageId
            ? {
                ...msg,
                content: data.explanation || "Changes applied successfully!",
                status: "success" as const,
              }
            : msg
        )
      );

      // Apply the new configuration
      if (data.newConfig) {
        const applied = await applyConfiguration(data.newConfig);
        if (applied) {
          // Update the message to include the applied config
          setState("messages", (messages) =>
            messages.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, appliedConfig: data.newConfig }
                : msg
            )
          );
        }
      }
    } catch (error) {
      console.error("AI Assistant error:", error);
      updateMessageStatus(assistantMessageId, "error");
      setState("messages", (messages) =>
        messages.map((msg) =>
          msg.id === assistantMessageId
            ? {
                ...msg,
                content: "Sorry, I encountered an error. Please try again.",
                status: "error" as const,
              }
            : msg
        )
      );
      toast.error("Failed to process your request");
    } finally {
      setState("isLoading", false);
      inputRef?.focus();
    }
  };

  return (
    <>
      {/* AI Orb Button */}
      <button
        onClick={() => {
          setState("isOpen", !state.isOpen);
          if (!state.isOpen) {
            // Opening the overlay, focus the input after a short delay
            setTimeout(() => inputRef?.focus(), 100);
          }
        }}
        class={cx(
          "relative size-[34px] rounded-full transition-all duration-300 hover:scale-110",
          state.isOpen && "scale-110",
          state.configHistory.length > 1 && "ring-2 ring-white/20"
        )}
        style={{
          background:
            "radial-gradient(circle at 30% 30%, #d0eefc 0%, #85e4f8 35%, #3c90e6 100%)",
          "box-shadow":
            "0 0 25px rgba(133, 228, 248, 0.6), inset 0 0 20px rgba(208, 238, 252, 0.4)",
        }}
      >
        {/* Inner glow overlay */}
        <div
          class="absolute inset-0 rounded-full opacity-90"
          style={{
            background:
              "radial-gradient(circle at 40% 40%, rgba(208, 238, 252, 0.8) 0%, transparent 60%)",
          }}
        />

        {/* Center highlight */}
        <div
          class="absolute top-[15%] left-[15%] w-[30%] h-[30%] rounded-full opacity-80"
          style={{
            background:
              "radial-gradient(circle at center, rgba(255, 255, 255, 0.9) 0%, rgba(208, 238, 252, 0.6) 50%, transparent 100%)",
            filter: "blur(1px)",
          }}
        />

        {/* Animated sparkles */}
        <div class="absolute inset-0 rounded-full overflow-hidden">
          <div class="sparkle sparkle-1" />
          <div class="sparkle sparkle-2" />
          <div class="sparkle sparkle-3" />
          <div class="sparkle sparkle-4" />
          <div class="sparkle sparkle-5" />
        </div>
      </button>

      {/* AI Assistant Overlay */}
      <Show when={state.isOpen}>
        {/* Full Screen Click Handler (behind everything) */}
        <div
          class="fixed inset-0 z-[39] animate-in fade-in duration-200"
          onClick={() => setState("isOpen", false)}
        />

        {/* Timeline Darkening Backdrop */}
        <div class="fixed bottom-0 left-0 right-0 h-[120px] bg-gradient-to-t from-black/60 to-transparent pointer-events-none z-40 animate-in fade-in duration-300" />

        {/* AI Assistant Panel */}
        <div
          class={cx(
            "fixed z-50 transition-all duration-300 ease-out",
            state.isExpanded
              ? "bottom-[80px] left-1/2 -translate-x-1/2 w-[600px] max-h-[calc(100vh-180px)]"
              : "bottom-[80px] left-1/2 -translate-x-1/2 w-[400px] max-h-[300px]"
          )}
        >
          <div
            class={cx(
              "bg-gray-1 dark:bg-gray-2 rounded-2xl shadow-2xl flex flex-col overflow-hidden border-4 border-gray-3",
              "animate-in fade-in-0 slide-in-from-bottom-4 duration-300",
              "shadow-[0_0_40px_rgba(0,0,0,0.3)]"
            )}
          >
            {/* Header */}
            <div class="flex items-center justify-between p-3 border-b border-gray-3">
              <div class="flex items-center gap-2">
                <div
                  class="size-5 rounded-full relative"
                  style={{
                    background:
                      "radial-gradient(circle at 30% 30%, #d0eefc 0%, #85e4f8 35%, #3c90e6 100%)",
                    "box-shadow":
                      "0 0 15px rgba(133, 228, 248, 0.4), inset 0 0 10px rgba(208, 238, 252, 0.3)",
                  }}
                >
                  <div
                    class="absolute inset-0 rounded-full opacity-90"
                    style={{
                      background:
                        "radial-gradient(circle at 40% 40%, rgba(208, 238, 252, 0.8) 0%, transparent 60%)",
                    }}
                  />
                  <div
                    class="absolute top-[15%] left-[15%] w-[30%] h-[30%] rounded-full opacity-80"
                    style={{
                      background:
                        "radial-gradient(circle at center, rgba(255, 255, 255, 0.9) 0%, rgba(208, 238, 252, 0.6) 50%, transparent 100%)",
                      filter: "blur(0.5px)",
                    }}
                  />
                </div>
                <h3 class="text-sm font-medium">Cap AI</h3>
              </div>
              <div class="flex items-center gap-1">
                <Show when={canUndo() || canRedo()}>
                  <button
                    onClick={undo}
                    disabled={!canUndo()}
                    class="p-1.5 rounded-lg hover:bg-gray-3 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <IconCapUndo class="size-3.5" />
                  </button>
                  <button
                    onClick={redo}
                    disabled={!canRedo()}
                    class="p-1.5 rounded-lg hover:bg-gray-3 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <IconCapRedo class="size-3.5" />
                  </button>
                </Show>
                <button
                  onClick={() => setState("isExpanded", !state.isExpanded)}
                  class="p-1.5 rounded-lg hover:bg-gray-3 transition-colors"
                >
                  <Show
                    when={state.isExpanded}
                    fallback={<IconCapEnlarge class="size-3.5" />}
                  >
                    <IconCapChevronDown class="size-3.5" />
                  </Show>
                </button>
                <button
                  onClick={() => setState("isOpen", false)}
                  class="p-1.5 rounded-lg hover:bg-gray-3 transition-colors"
                >
                  <IconCapCircleX class="size-3.5" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div
              class={cx(
                "flex-1 overflow-y-auto",
                state.isExpanded ? "p-4" : "p-3"
              )}
            >
              <Show
                when={state.isExpanded}
                fallback={
                  // Compact view - only show last message
                  <Show when={lastMessage()}>
                    <div
                      class={cx(
                        "text-sm rounded-lg p-2.5",
                        lastMessage()!.status === "error"
                          ? "bg-red-5 text-red-11"
                          : "bg-gray-3 text-gray-12"
                      )}
                    >
                      <Show
                        when={
                          lastMessage()!.status === "pending" &&
                          lastMessage()!.role === "assistant"
                        }
                      >
                        <div class="flex items-center gap-2">
                          <IconLucideLoaderCircle class="w-4 h-4 animate-spin" />
                          <span>Applying changes...</span>
                        </div>
                      </Show>
                      <Show when={lastMessage()!.status !== "pending"}>
                        <p class="whitespace-pre-wrap line-clamp-3">
                          {lastMessage()!.content}
                        </p>
                      </Show>
                    </div>
                  </Show>
                }
              >
                {/* Expanded view - show all messages */}
                <div class="space-y-3">
                  <Show
                    when={state.messages.length > 0}
                    fallback={
                      <div class="text-sm text-gray-11 space-y-3">
                        <p class="font-medium">
                          How can I help you edit your video?
                        </p>
                        <Show when={!state.videoContent}>
                          <div class="bg-blue-5/20 border border-blue-7 rounded-lg p-3">
                            <p class="text-sm mb-2">
                              For content-aware editing, analyze your video
                              first:
                            </p>
                            <Button
                              onClick={analyzeVideo}
                              disabled={state.isAnalyzingVideo}
                              size="sm"
                              class="w-full"
                            >
                              <Show
                                when={state.isAnalyzingVideo}
                                fallback="Analyze Video Content"
                              >
                                <IconLucideLoaderCircle class="w-4 h-4 animate-spin mr-2" />
                                Analyzing...
                              </Show>
                            </Button>
                          </div>
                        </Show>
                        <ul class="space-y-1.5 text-xs">
                          <li>• "Make the background blue with a gradient"</li>
                          <li>• "Move the camera to the top right"</li>
                          <li>• "Add padding and rounded corners"</li>
                          <li>• "Enable captions with larger font"</li>
                        </ul>
                      </div>
                    }
                  >
                    <For each={state.messages}>
                      {(message) => (
                        <div
                          class={cx(
                            "flex gap-2",
                            message.role === "user"
                              ? "justify-end"
                              : "justify-start"
                          )}
                        >
                          <div
                            class={cx(
                              "max-w-[80%] rounded-lg px-3 py-2 text-sm",
                              message.role === "user"
                                ? "bg-blue-9 text-white"
                                : "bg-gray-3 text-gray-12",
                              message.status === "error" &&
                                "bg-red-5 text-red-11"
                            )}
                          >
                            <Show
                              when={
                                message.status === "pending" &&
                                message.role === "assistant"
                              }
                            >
                              <div class="flex items-center gap-2">
                                <IconLucideLoaderCircle class="w-4 h-4 animate-spin" />
                                <span>Applying changes...</span>
                              </div>
                            </Show>
                            <Show
                              when={
                                message.status !== "pending" ||
                                message.role === "user"
                              }
                            >
                              <p class="whitespace-pre-wrap">
                                {message.content}
                              </p>
                            </Show>
                            <Show when={message.appliedConfig}>
                              <p class="text-xs mt-1 opacity-70">
                                ✓ Changes applied
                              </p>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                    <div ref={messagesEndRef} />
                  </Show>
                </div>
              </Show>
            </div>

            {/* Input */}
            <form onSubmit={handleSubmit} class="p-3 border-t border-gray-3">
              <div class="flex gap-2 items-end">
                <textarea
                  ref={inputRef}
                  value={state.input}
                  onInput={(e) => setState("input", e.currentTarget.value)}
                  onKeyDown={(e) => {
                    // Cmd/Ctrl + Enter for new line
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      // Allow default behavior for new line
                      return;
                    }
                    // Enter to send
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  placeholder="Describe what you want to change..."
                  disabled={state.isLoading}
                  class="flex-1 px-3 py-2 bg-gray-2 dark:bg-gray-3 border border-gray-9 rounded-lg resize-none focus:outline-none text-sm min-h-[36px] max-h-[80px]"
                  rows="1"
                />
              </div>
              <div class="flex items-center justify-between mt-2">
                <p class="text-xs text-gray-11">
                  Press Enter to send,{" "}
                  {window.navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}
                  +Enter for new line
                </p>
                <Show when={state.isLoading}>
                  <div class="flex items-center gap-2 text-xs text-gray-11">
                    <IconLucideLoaderCircle class="w-3 h-3 animate-spin" />
                  </div>
                </Show>
              </div>
            </form>
          </div>
        </div>
      </Show>

      {/* Add subtle glow animation */}
      <style>{`
        .sparkle {
          position: absolute;
          background: rgba(255, 255, 255, 0.9);
          border-radius: 50%;
          animation: sparkle 2s ease-in-out infinite;
        }
        
        .sparkle-1 {
          width: 2px;
          height: 2px;
          top: 25%;
          left: 60%;
          animation-delay: 0s;
          animation-duration: 2.5s;
        }
        
        .sparkle-2 {
          width: 1.5px;
          height: 1.5px;
          top: 50%;
          left: 30%;
          animation-delay: 0.8s;
          animation-duration: 3s;
        }
        
        .sparkle-3 {
          width: 3px;
          height: 3px;
          top: 70%;
          left: 70%;
          animation-delay: 1.2s;
          animation-duration: 2.2s;
        }
        
        .sparkle-4 {
          width: 1px;
          height: 1px;
          top: 40%;
          left: 80%;
          animation-delay: 1.8s;
          animation-duration: 2.8s;
        }
        
        .sparkle-5 {
          width: 2px;
          height: 2px;
          top: 80%;
          left: 45%;
          animation-delay: 2.3s;
          animation-duration: 3.5s;
        }
        
        @keyframes sparkle {
          0%, 100% {
            opacity: 0;
            transform: scale(0.5) translateY(0px);
          }
          50% {
            opacity: 1;
            transform: scale(1) translateY(-2px);
          }
        }

        /* Ensure timeline controls remain interactive */
        .timeline-controls {
          position: relative;
          z-index: 41;
        }
      `}</style>
    </>
  );
}
