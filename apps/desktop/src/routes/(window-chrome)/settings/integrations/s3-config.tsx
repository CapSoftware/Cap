import { Button } from "@cap/ui-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSignal, onMount } from "solid-js";
import { authStore } from "~/store";
import { clientEnv } from "~/utils/env";
import { commands } from "~/utils/tauri";
import { apiClient as apiClient, protectedHeaders } from "~/utils/web-api";

interface S3Config {
  provider: string;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  endpoint: string | null;
  bucketName: string | null;
  region: string | null;
}

const DEFAULT_CONFIG = {
  provider: "aws",
  accessKeyId: "",
  secretAccessKey: "",
  endpoint: "https://s3.amazonaws.com",
  bucketName: "",
  region: "us-east-1",
};

export default function S3ConfigPage() {
  const [provider, setProvider] = createSignal(DEFAULT_CONFIG.provider);
  const [accessKeyId, setAccessKeyId] = createSignal(
    DEFAULT_CONFIG.accessKeyId
  );
  const [secretAccessKey, setSecretAccessKey] = createSignal(
    DEFAULT_CONFIG.secretAccessKey
  );
  const [endpoint, setEndpoint] = createSignal(DEFAULT_CONFIG.endpoint);
  const [bucketName, setBucketName] = createSignal(DEFAULT_CONFIG.bucketName);
  const [region, setRegion] = createSignal(DEFAULT_CONFIG.region);
  const [saving, setSaving] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [deleting, setDeleting] = createSignal(false);
  const [hasConfig, setHasConfig] = createSignal(false);
  const [testing, setTesting] = createSignal(false);

  const resetForm = () => {
    setProvider(DEFAULT_CONFIG.provider);
    setAccessKeyId(DEFAULT_CONFIG.accessKeyId);
    setSecretAccessKey(DEFAULT_CONFIG.secretAccessKey);
    setEndpoint(DEFAULT_CONFIG.endpoint);
    setBucketName(DEFAULT_CONFIG.bucketName);
    setRegion(DEFAULT_CONFIG.region);
    setHasConfig(false);
  };

  const handleAuthError = async () => {
    console.error("User not authenticated");
    const window = getCurrentWindow();
    window.close();
  };

  onMount(async () => {
    try {
      const response = await apiClient.desktop.getS3Config({
        headers: await protectedHeaders(),
      });

      if (response.status !== 200) throw new Error("Failed to fetch S3 config");

      if (response.body.config) {
        const config = response.body.config;
        if (!config.accessKeyId) return;

        setProvider(config.provider || DEFAULT_CONFIG.provider);
        setAccessKeyId(config.accessKeyId || DEFAULT_CONFIG.accessKeyId);
        setSecretAccessKey(
          config.secretAccessKey || DEFAULT_CONFIG.secretAccessKey
        );
        setEndpoint(config.endpoint || DEFAULT_CONFIG.endpoint);
        setBucketName(config.bucketName || DEFAULT_CONFIG.bucketName);
        setRegion(config.region || DEFAULT_CONFIG.region);
        setHasConfig(true);
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
      const response = await apiClient.desktop.setS3Config({
        body: {
          provider: provider(),
          accessKeyId: accessKeyId(),
          secretAccessKey: secretAccessKey(),
          endpoint: endpoint(),
          bucketName: bucketName(),
          region: region(),
        },
        headers: await protectedHeaders(),
      });

      if (response.status === 200) {
        setHasConfig(true);
        await commands.globalMessageDialog(
          "S3 configuration saved successfully"
        );
      }
    } catch (error) {
      console.error("Failed to save S3 config:", error);
      await commands.globalMessageDialog(
        "Failed to save S3 configuration. Please check your settings and try again."
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const response = await apiClient.desktop.deleteS3Config({
        headers: await protectedHeaders(),
      });

      if (response.status === 200) {
        resetForm();
        await commands.globalMessageDialog(
          "S3 configuration deleted successfully"
        );
      }
    } catch (error) {
      console.error("Failed to delete S3 config:", error);
      await commands.globalMessageDialog(
        "Failed to delete S3 configuration. Please try again."
      );
    } finally {
      setDeleting(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5500); // 5.5s timeout (slightly longer than backend)

      const response = await apiClient.desktop.testS3Config({
        body: {
          provider: provider(),
          accessKeyId: accessKeyId(),
          secretAccessKey: secretAccessKey(),
          endpoint: endpoint(),
          bucketName: bucketName(),
          region: region(),
        },
        headers: await protectedHeaders(),
      });

      clearTimeout(timeoutId);

      if (response.status === 200) {
        await commands.globalMessageDialog(
          "S3 configuration test successful! Connection is working."
        );
      }
    } catch (error) {
      console.error("Failed to test S3 config:", error);
      let errorMessage =
        "Failed to connect to S3. Please check your settings and try again.";

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          errorMessage =
            "Connection test timed out after 5 seconds. Please check your endpoint URL and network connection.";
        } else if ("response" in error) {
          try {
            const errorResponse = (error as { response: Response }).response;
            const errorData = await errorResponse.json();
            if (errorData?.error) {
              errorMessage = errorData.error;
            }
          } catch (e) {
            // If we can't parse the error response, use the default message
          }
        }
      }

      await commands.globalMessageDialog(errorMessage);
    } finally {
      setTesting(false);
    }
  };

  const renderInput = (
    label: string,
    value: () => string,
    setter: (value: string) => void,
    placeholder: string,
    type: "text" | "password" = "text"
  ) => (
    <div>
      <label class="text-gray-500 text-sm">{label}</label>
      <input
        type={type}
        value={value()}
        onInput={(e: InputEvent & { currentTarget: HTMLInputElement }) =>
          setter(e.currentTarget.value)
        }
        placeholder={placeholder}
        class="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
      />
    </div>
  );

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
                    <option value="supabase">Supabase</option>
                    <option value="minio">MinIO</option>
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

              {renderInput(
                "Access Key ID",
                accessKeyId,
                setAccessKeyId,
                "PL31OADSQNK",
                "password"
              )}
              {renderInput(
                "Secret Access Key",
                secretAccessKey,
                setSecretAccessKey,
                "PL31OADSQNK",
                "password"
              )}
              {renderInput(
                "Endpoint",
                endpoint,
                setEndpoint,
                "https://s3.amazonaws.com"
              )}
              {renderInput(
                "Bucket Name",
                bucketName,
                setBucketName,
                "my-bucket"
              )}
              {renderInput("Region", region, setRegion, "us-east-1")}
            </div>
          )}
        </div>
      </div>

      <div class="flex-shrink-0 p-4 border-t">
        <div class="flex justify-between items-center">
          <div class="flex gap-2">
            {hasConfig() && (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleting() || loading() || saving() || testing()}
                class={
                  deleting() || loading() || saving() || testing()
                    ? "opacity-50 cursor-not-allowed"
                    : ""
                }
              >
                {deleting() ? "Removing..." : "Remove Config"}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={handleTest}
              disabled={
                saving() ||
                loading() ||
                deleting() ||
                testing() ||
                !accessKeyId() ||
                !secretAccessKey() ||
                !bucketName()
              }
              class={
                saving() ||
                loading() ||
                deleting() ||
                testing() ||
                !accessKeyId() ||
                !secretAccessKey() ||
                !bucketName()
                  ? "opacity-50 cursor-not-allowed"
                  : ""
              }
            >
              {testing() ? "Testing..." : "Test Connection"}
            </Button>
          </div>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving() || loading() || deleting() || testing()}
            class={
              saving() || loading() || deleting() || testing()
                ? "opacity-50 cursor-not-allowed"
                : ""
            }
          >
            {saving() ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
