import { Show } from "solid-js";
import { commands } from "~/utils/tauri";

export default function Import() {
  const handleSelect = async () => {
    const path = await commands.openVideoDialog();
    if (path) {
      const project = await commands.importVideo(path);
      await commands.showWindow({ Editor: { project_path: project } });
    }
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file && (file as any).path) {
      const project = await commands.importVideo((file as any).path);
      await commands.showWindow({ Editor: { project_path: project } });
    }
  };

  return (
    <div
      class="flex flex-col items-center justify-center w-screen h-screen gap-4"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      data-tauri-drag-region
    >
      <button class="px-4 py-2 rounded-md bg-blue-9 text-white" onClick={handleSelect}>
        Select Video to Import
      </button>
      <p class="text-gray-11">or drag and drop a file here</p>
    </div>
  );
}
