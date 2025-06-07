import { Button } from "@cap/ui-solid";
import { createWritableMemo } from "@solid-primitives/memo";
import { useMutation } from "@tanstack/solid-query";
import { createResource, Suspense } from "solid-js";
import { createEventBus } from "@solid-primitives/event-bus";

import { commands } from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";
import { message } from "@tauri-apps/plugin-dialog";

interface S3Config {
  provider: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucketName: string;
  region: string;
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
  const [_s3Config, { refetch }] = createResource(async () => {
    const response = await apiClient.desktop.getS3Config({
      headers: await protectedHeaders(),
    });

    if (response.status !== 200) throw new Error("Failed to fetch S3 config");

    return response.body.config;
  });

  const hasConfig = () => !!_s3Config()?.accessKeyId;

  const saveConfig = useMutation(() => ({
    mutationFn: async (config: S3Config) => {
      const response = await apiClient.desktop.setS3Config({
        body: config,
        headers: await protectedHeaders(),
      });

      if (response.status !== 200) throw new Error("Failed to save S3 config");
      return response;
    },
    onSuccess: async () => {
      await refetch();
      await commands.globalMessageDialog("S3 configuration saved successfully");
    },
  }));

  const deleteConfig = useMutation(() => ({
    mutationFn: async () => {
      const response = await apiClient.desktop.deleteS3Config({
        headers: await protectedHeaders(),
      });

      if (response.status !== 200)
        throw new Error("Failed to delete S3 config");
      return response;
    },
    onSuccess: async () => {
      await refetch();
      await commands.globalMessageDialog(
        "S3 configuration deleted successfully"
      );
    },
  }));

  const testConfig = useMutation(() => ({
    mutationFn: async (config: S3Config) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5500); // 5.5s timeout (slightly longer than backend)

      try {
        const response = await apiClient.desktop.testS3Config({
          body: config,
          headers: await protectedHeaders(),
          fetchOptions: { signal: controller.signal },
        });

        clearTimeout(timeoutId);

        if (response.status !== 200)
          throw new Error(
            `S3 connection test failed. Check your config and network connection.`
          );

        return response;
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error) {
          if (error.name === "AbortError")
            throw new Error(
              "Connection test timed out after 5 seconds. Please check your endpoint URL and network connection."
            );
        }

        throw error;
      }
    },
    onSuccess: async () => {
      await commands.globalMessageDialog(
        "S3 configuration test successful! Connection is working."
      );
    },
  }));

  const events = createEventBus<"save" | "test">();

  return (
    <div class="flex flex-col h-full">
      <div class="overflow-y-auto flex-1 p-4">
        <Suspense
          fallback={
            <div class="flex w-full h-full justify-center items-center">
              <IconCapLogo class="size-16 animate-spin" />
            </div>
          }
        >
          {(() => {
            const [s3Config, setS3Config] = createWritableMemo(
              () => _s3Config.latest ?? DEFAULT_CONFIG
            );

            const renderInput = (
              label: string,
              key: keyof ReturnType<typeof s3Config>,
              placeholder: string,
              type: "text" | "password" = "text"
            ) => (
              <div>
                <label class="text-sm text-gray-12">{label}</label>
                <input
                  type={type}
                  value={s3Config()[key] ?? ""}
                  onInput={(
                    e: InputEvent & { currentTarget: HTMLInputElement }
                  ) =>
                    setS3Config({ ...s3Config(), [key]: e.currentTarget.value })
                  }
                  placeholder={placeholder}
                  class="px-3 py-2 w-full rounded-lg bg-gray-1 border border-gray-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                />
              </div>
            );

            events.listen((v) => {
              if (v === "save") saveConfig.mutate(s3Config());
              else if (v === "test") testConfig.mutate(s3Config());
            });

            return (
              <div class="space-y-4 animate-in fade-in">
                <div>
                  <p class="text-sm text-gray-11">
                    It should take under 10 minutes to set up and connect your
                    storage bucket to Cap. View the{" "}
                    <a
                      href="https://cap.so/docs/s3-config"
                      target="_blank"
                      class="font-semibold text-gray-12 underline"
                    >
                      Storage Config Guide
                    </a>{" "}
                    to get started.
                  </p>
                </div>

                <div>
                  <label class="text-sm text-gray-12">Storage Provider</label>
                  <div class="relative">
                    <select
                      value={s3Config().provider}
                      onChange={(e) =>
                        setS3Config((c) => ({
                          ...c,
                          provider: e.currentTarget.value,
                        }))
                      }
                      class="px-3 py-2 pr-10 w-full bg-gray-1 rounded-lg border border-gray-3 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="aws">AWS S3</option>
                      <option value="cloudflare">Cloudflare R2</option>
                      <option value="supabase">Supabase</option>
                      <option value="minio">MinIO</option>
                      <option value="other">Other S3-Compatible</option>
                    </select>
                    <div class="flex absolute inset-y-0 right-0 items-center px-2 pointer-events-none">
                      <svg
                        class="w-4 h-4 text-gray-11"
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
                  "accessKeyId",
                  "PL31OADSQNK",
                  "password"
                )}
                {renderInput(
                  "Secret Access Key",
                  "secretAccessKey",
                  "PL31OADSQNK",
                  "password"
                )}
                {renderInput(
                  "Endpoint",
                  "endpoint",
                  "https://s3.amazonaws.com"
                )}
                {renderInput("Bucket Name", "bucketName", "my-bucket")}
                {renderInput("Region", "region", "us-east-1")}
              </div>
            );
          })()}
        </Suspense>
      </div>

      <div class="flex-shrink-0 p-4 border-t">
        <fieldset
          class="flex justify-between items-center"
          disabled={
            _s3Config.loading ||
            saveConfig.isPending ||
            deleteConfig.isPending ||
            testConfig.isPending
          }
        >
          <div class="flex gap-2">
            {!_s3Config.loading && hasConfig() && (
              <Button
                variant="destructive"
                onClick={() => deleteConfig.mutate()}
              >
                {deleteConfig.isPending ? "Removing..." : "Remove Config"}
              </Button>
            )}
            <Button variant="secondary" onClick={() => events.emit("test")}>
              {testConfig.isPending ? "Testing..." : "Test Connection"}
            </Button>
          </div>
          <Button variant="primary" onClick={() => events.emit("save")}>
            {saveConfig.isPending ? "Saving..." : "Save"}
          </Button>
        </fieldset>
      </div>
    </div>
  );
}
