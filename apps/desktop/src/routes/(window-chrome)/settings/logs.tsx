import { Button } from "@cap/ui-solid";
import { createSignal } from "solid-js";
import { commands } from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";

export default function LogsTab() {
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [submitResult, setSubmitResult] = createSignal<{
    success?: boolean;
    error?: string;
  }>({});

  const sendLogs = async () => {
    setIsSubmitting(true);
    setSubmitResult({});

    try {
      const logsAndInfo = await commands.getLogsAndSystemInfo();

      const response = await apiClient.desktop.submitLogs({
        body: {
          systemInfo: logsAndInfo.system_info,
          recentLogs: logsAndInfo.recent_logs,
          appVersion: logsAndInfo.app_version,
        },
        headers: await protectedHeaders(),
      });

      if (response.status !== 200) {
        throw new Error(
          `Failed to send logs: ${response.status} - ${JSON.stringify(
            response.body
          )}`
        );
      }

      setSubmitResult({ success: true });
    } catch (error) {
      console.error("Detailed error sending logs:", error);
      if (error instanceof Error) {
        setSubmitResult({ error: `Error: ${error.message}` });
      } else {
        setSubmitResult({ error: `Unknown error: ${JSON.stringify(error)}` });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div class="flex flex-col w-full h-full">
      <div class="flex-1 custom-scroll">
        <div class="p-4 space-y-4">
          <div class="flex flex-col pb-4 border-b border-gray-2">
            <h2 class="text-lg font-medium text-gray-12">
              Send Logs to Cap Team
            </h2>
            <p class="text-sm text-gray-10">
              Send diagnostic information and logs from your recent recordings
              to help us troubleshoot issues.
            </p>
          </div>

          <div class="space-y-4">
            <div class="p-3 bg-gray-2 rounded-md">
              <p class="text-sm text-gray-11 mb-2">This will send:</p>
              <ul class="text-sm text-gray-10 space-y-1 list-disc list-inside">
                <li>System information (OS, hardware, displays)</li>
                <li>Camera and microphone device list</li>
                <li>Logs from your 3 most recent recordings</li>
                <li>Cap app version information</li>
              </ul>
            </div>

            {submitResult().error && (
              <p class="text-sm text-red-400">{submitResult().error}</p>
            )}

            {submitResult().success && (
              <p class="text-sm text-green-400">
                Logs sent successfully! Thank you for helping us improve Cap.
              </p>
            )}

            <Button
              onClick={sendLogs}
              size="md"
              disabled={isSubmitting()}
              class="bg-primary text-primary"
            >
              {isSubmitting() ? "Sending..." : "Send Logs to Cap Team"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
