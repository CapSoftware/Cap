import { Suspense } from "solid-js";
import { Editor } from "./Editor";

export default function () {
  return (
    <Suspense
      fallback={
        <div class="w-screen h-screen flex items-center justify-center bg-gray-50 animate-in fade-in">
          <div class="flex flex-col items-center gap-4">
            <div class="animate-spin rounded-full h-8 w-8 border-2 border-gray-300 border-t-blue-400" />
            <span class="text-gray-500">Loading editor...</span>
          </div>
        </div>
      }
    >
      <Editor />
    </Suspense>
  );
}
