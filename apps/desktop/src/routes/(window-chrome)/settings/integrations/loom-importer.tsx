import { Button } from "@cap/ui-solid";
import { createSignal, For } from "solid-js";
import { authStore } from "~/store";
import { commands } from "~/utils/tauri";

export default function LoomImporter() {
  const [videoIds, setVideoIds] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");

  const handleSignIn = async () => {
    await commands.showWindow("Login");
  };

  const handleImport = async () => {
    setLoading(true);
    setError("");
    try {
      window.open("https://www.loom.com", "_blank");
      const res = await fetch("https://www.loom.com/looms/videos", {
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
          "cache-control": "max-age=0",
          priority: "u=0, i",
          "sec-ch-ua": '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-origin",
          "sec-fetch-user": "?1",
          "upgrade-insecure-requests": "1"
        },
        referrerPolicy: "strict-origin-when-cross-origin",
        method: "GET",
        mode: "cors",
        credentials: "include"
      });
      const text = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");
      const anchors = Array.from(doc.querySelectorAll("a[href*='/looms/videos/']"));
      const ids = anchors.map(a => {
        const match = a.getAttribute("href")?.match(/\/looms\/videos\/([^/?#]+)/);
        return match ? match[1] : null;
      }).filter(Boolean) as string[];
      setVideoIds([...new Set(ids)]);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  if (!authStore.isAuthed) {
    return (
      <div class="p-4 flex flex-col gap-4">
        <div class="text-sm text-[--text-primary]">Please sign in using the web app.</div>
        <Button onClick={handleSignIn}>Sign In</Button>
      </div>
    );
  }

  return (
    <div class="p-4 flex flex-col gap-4">
      <div class="text-sm text-[--text-primary]">Please ensure you are logged into Loom.com in your browser.</div>
      <Button disabled={loading()} onClick={handleImport}>
        {loading() ? "Importing..." : "Import from Loom"}
      </Button>
      {error() && <div class="text-sm text-red-500">{error()}</div>}
      <div class="flex flex-col gap-2">
        <For each={videoIds()}>{id => 
          <div class="text-sm text-[--text-secondary] p-2 bg-[--gray-100] rounded-lg">{id}</div>
        }</For>
      </div>
    </div>
  );
} 