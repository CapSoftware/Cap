import { createSignal } from "solid-js";
import { commands } from "~/utils/tauri";
import { Button } from "@cap/ui-solid";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

export default function ImportVideo() {
  const [isImporting, setIsImporting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [isDragging, setIsDragging] = createSignal(false);

  const handleFileDrop = async (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) {
      const filePath = (file as any).path;
      if (filePath) {
        await importVideo(filePath);
      }
    }
  };

  const handleFileSelect = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Video",
            extensions: ["mp4"],
          },
        ],
      });

      console.log("Selected file:", selected);

      if (!selected) {
        console.log("No file selected");
        return;
      }

      if (typeof selected === "string") {
        await importVideo(selected);
      } else {
        console.error("Invalid file selection type:", typeof selected);
        setError("Invalid file selection. Please try again.");
      }
    } catch (err) {
      console.error("Error opening dialog:", err);
      setError("Failed to open file dialog. Please try again.");
    }
  };

  const importVideo = async (path: string) => {
    setIsImporting(true);
    setError(null);

    try {
      console.log("Importing video from path:", path);
      const response = await commands.importVideoToProject(path);

      console.log("Project ID received:", response);

      // Extract the project ID from the response
      const projectId = response.data;

      if (typeof projectId !== "string") {
        throw new Error("Invalid project ID received");
      }

      // Open the editor using the existing command
      await commands.openEditor(projectId);

      // Close the current window
      const currentWindow = await getCurrentWindow();
      await currentWindow.close();
    } catch (err) {
      console.error("Import error:", err);
      setError(
        `Failed to import video: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      setIsImporting(false);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  return (
    <div class="w-full h-full bg-gray-50 p-8">
      <div
        class={`flex flex-col items-center justify-center h-full rounded-xl border-2 border-dashed transition-colors duration-200 ${
          isDragging()
            ? "border-blue-500 bg-blue-50"
            : "border-gray-300 hover:border-gray-400"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => {
          handleFileDrop(e);
          setIsDragging(false);
        }}
      >
        <div class="text-center max-w-md mx-auto p-8">
          <div class="mb-6">
            <svg
              class={`mx-auto w-16 h-16 ${
                isDragging() ? "text-blue-500" : "text-gray-400"
              }`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>
          <h2 class="text-xl font-semibold mb-2 text-gray-900">
            Drop your MP4 video here
          </h2>
          <p class="text-gray-600 mb-6">or</p>
          <Button
            variant="primary"
            onClick={handleFileSelect}
            disabled={isImporting()}
            class="w-full max-w-xs mx-auto"
          >
            {isImporting() ? "Importing..." : "Select Video"}
          </Button>
          {error() && (
            <p class="text-red-500 mt-4 text-sm font-medium">{error()}</p>
          )}
        </div>
      </div>
    </div>
  );
}
