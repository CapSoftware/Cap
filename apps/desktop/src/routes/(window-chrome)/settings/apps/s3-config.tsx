import { Button } from "@cap/ui-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSignal, onMount } from "solid-js";
import { authStore } from "~/store";
import { clientEnv } from "~/utils/env";
import { commands } from "~/utils/tauri";

interface S3Config {
  provider: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucketName: string;
  region: string;
}

export default function S3ConfigPage() {
  const [provider, setProvider] = createSignal("aws");
  const [accessKeyId, setAccessKeyId] = createSignal("");
  const [secretAccessKey, setSecretAccessKey] = createSignal("");
  const [endpoint, setEndpoint] = createSignal("https://s3.amazonaws.com");
  const [bucketName, setBucketName] = createSignal("");
  const [region, setRegion] = createSignal("us-east-1");
  const [saving, setSaving] = createSignal(false);
  const [loading, setLoading] = createSignal(true);

  onMount(async () => {
    try {
      const auth = await authStore.get();

      if (!auth) {
        console.error("User not authenticated");
        const window = getCurrentWindow();
        window.close();
        return;
      }

      const response = await fetch(
        `${clientEnv.VITE_SERVER_URL}/api/desktop/s3/config/get?origin=${window.location.origin}`,
        {
          method: "GET",
          credentials: "include",
          headers: {
            Authorization: `Bearer ${auth.token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch S3 configuration");
      }

      const data = await response.json();
      if (data.config) {
        const config = data.config as S3Config;
        setProvider(config.provider || "aws");
        setAccessKeyId(config.accessKeyId);
        setSecretAccessKey(config.secretAccessKey);
        setEndpoint(config.endpoint || "https://s3.amazonaws.com");
        setBucketName(config.bucketName);
        setRegion(config.region || "us-east-1");
      }
    } catch (error) {
      console.error("Failed to fetch S3 config:", error);
    } finally {
      setLoading(false);
    }
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      const auth = await authStore.get();

      if (!auth) {
        console.error("User not authenticated");
        const window = getCurrentWindow();
        window.close();
        return;
      }

      const response = await fetch(
        `${clientEnv.VITE_SERVER_URL}/api/desktop/s3/config?origin=${window.location.origin}`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.token}`,
          },
          body: JSON.stringify({
            provider: provider(),
            accessKeyId: accessKeyId(),
            secretAccessKey: secretAccessKey(),
            endpoint: endpoint(),
            bucketName: bucketName(),
            region: region(),
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to save S3 configuration");
      }

      await commands.globalMessageDialog("S3 configuration saved successfully");
    } catch (error) {
      console.error("Failed to save S3 config:", error);
      await commands.globalMessageDialog(
        "Failed to save S3 configuration. Please check your settings and try again."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="h-full flex flex-col">
      <div class="flex-1 overflow-y-auto">
        <div class="p-4 space-y-4">
          {loading() ? (
            <div class="flex items-center justify-center h-32">
              <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
            </div>
          ) : (
            <div class="space-y-4">
              <div>
                <p class="text-gray-400 text-sm">
                  It should take under 10 minutes to set up and connect your
                  storage bucket to Cap. View the{" "}
                  <a
                    href="https://cap.so/docs/s3-config"
                    target="_blank"
                    class="text-gray-500 font-semibold underline"
                  >
                    Storage Config Guide
                  </a>{" "}
                  to get started.
                </p>
              </div>

              <div>
                <label class="text-gray-500 text-sm">Storage Provider</label>
                <div class="relative">
                  <select
                    value={provider()}
                    onChange={(e) => setProvider(e.currentTarget.value)}
                    class="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white pr-10"
                  >
                    <option value="aws">AWS S3</option>
                    <option value="cloudflare">Cloudflare R2</option>
                    <option value="other">Other S3-Compatible</option>
                  </select>
                  <div class="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                    <svg
                      class="w-4 h-4 text-gray-400"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fill-rule="evenodd"
                        d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                        clip-rule="evenodd"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              <div>
                <label class="text-gray-500 text-sm">Access Key ID</label>
                <input
                  type="password"
                  value={accessKeyId()}
                  onInput={(
                    e: InputEvent & { currentTarget: HTMLInputElement }
                  ) => setAccessKeyId(e.currentTarget.value)}
                  placeholder="PL31OADSQNK"
                  class="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                />
              </div>

              <div>
                <label class="text-gray-500 text-sm">Secret Access Key</label>
                <input
                  type="password"
                  value={secretAccessKey()}
                  onInput={(
                    e: InputEvent & { currentTarget: HTMLInputElement }
                  ) => setSecretAccessKey(e.currentTarget.value)}
                  placeholder="PL31OADSQNK"
                  class="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                />
              </div>

              <div>
                <label class="text-gray-500 text-sm">Endpoint</label>
                <input
                  type="text"
                  value={endpoint()}
                  onInput={(
                    e: InputEvent & { currentTarget: HTMLInputElement }
                  ) => setEndpoint(e.currentTarget.value)}
                  placeholder="https://s3.amazonaws.com"
                  class="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                />
              </div>

              <div>
                <label class="text-gray-500 text-sm">Bucket Name</label>
                <input
                  type="text"
                  value={bucketName()}
                  onInput={(
                    e: InputEvent & { currentTarget: HTMLInputElement }
                  ) => setBucketName(e.currentTarget.value)}
                  placeholder="my-bucket"
                  class="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                />
              </div>

              <div>
                <label class="text-gray-500 text-sm">Region</label>
                <input
                  type="text"
                  value={region()}
                  onInput={(
                    e: InputEvent & { currentTarget: HTMLInputElement }
                  ) => setRegion(e.currentTarget.value)}
                  placeholder="us-east-1"
                  class="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div class="flex-shrink-0 p-4 border-t">
        <div class="flex justify-end">
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving() || loading()}
            class={saving() || loading() ? "opacity-50 cursor-not-allowed" : ""}
          >
            {saving() ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
