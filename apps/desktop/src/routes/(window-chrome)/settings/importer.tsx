import { Button } from "@cap/ui-solid";
import { open } from "@tauri-apps/plugin-dialog";
import { createSignal, Show } from "solid-js";
import toast from "solid-toast";
import { commands } from "~/utils/tauri";

export default function ImporterSettings() {
  const [isImporting, setIsImporting] = createSignal(false);
  const [progress, setProgress] = createSignal<string>("");

  const handleImport = async (filePath: string) => {
    try {
      setIsImporting(true);
      setProgress("Processing video file...");

      const projectPath = await commands.importVideoFile(filePath);

      toast.success("Video imported successfully!");
      setProgress("");
    } catch (error) {
      console.error("Import error:", error);
      toast.error(`Failed to import video: ${error}`);
      setProgress("");
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileSelect = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Video",
            extensions: ["mp4", "mov", "webm", "m4v"],
          },
        ],
      });

      if (selected) {
        await handleImport(selected as string);
      }
    } catch (error) {
      console.error("File selection error:", error);
      toast.error("Failed to select file");
    }
  };

  return (
    <div class="flex flex-col w-full h-full">
      <div class="flex-1 custom-scroll">
        <div class="p-4 space-y-4">
          <div class="mb-6">
            <h2 class="text-gray-12 text-lg font-medium mb-2">Import Videos</h2>
            <p class="text-gray-11 text-sm">
              Import existing video files into Cap to edit them with the Cap
              Editor. Most common video formats are supported including .mp4,
              .mov, .webm and .m4v.
            </p>
          </div>

          <div class="flex flex-col items-center justify-center space-y-4 p-12 border-2 border-dashed border-gray-300 rounded-lg">
            <svg
              class="w-12 h-12 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>

            <div class="text-center">
              <p class="text-gray-12 font-medium mb-1">
                {isImporting() ? progress() : "Select a video file to import"}
              </p>
            </div>

            <Show when={!isImporting()}>
              <Button variant="primary" size="md" onClick={handleFileSelect}>
                Select Video File
              </Button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
