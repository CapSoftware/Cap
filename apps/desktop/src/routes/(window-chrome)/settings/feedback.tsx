import { Button } from "@cap/ui-solid";
import { action, useAction, useSubmission } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type as ostype } from "@tauri-apps/plugin-os";
import { createSignal, For, Show, onMount } from "solid-js";

import { commands } from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";
import { clientEnv } from "~/utils/env";

const sendFeedbackAction = action(async (feedback: string) => {
  const logsAndInfo = await commands.getLogsAndSystemInfo();

  const formData = new URLSearchParams();
  formData.append("feedback", feedback);
  formData.append("os", ostype() as any);
  formData.append("version", await getVersion());
  formData.append("systemInfo", JSON.stringify(logsAndInfo.system_info));

  const headers = await protectedHeaders();
  const response = await fetch(`${clientEnv.VITE_SERVER_URL}/api/desktop/feedback`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData,
  });

  if (response.status !== 200) throw new Error("Failed to submit feedback");
  return await response.json();
});

export default function FeedbackTab() {
  const [feedback, setFeedback] = createSignal("");
  const [isSubmittingLogs, setIsSubmittingLogs] = createSignal(false);
  const [logsResult, setLogsResult] = createSignal<{
    success?: boolean;
    error?: string;
  }>({});
  const [isSubmittingRecording, setIsSubmittingRecording] = createSignal(false);
  const [recordingResult, setRecordingResult] = createSignal<{
    success?: boolean;
    error?: string;
  }>({});
  const [selectedRecording, setSelectedRecording] = createSignal<string | null>(
    null
  );
  const [recordings, setRecordings] = createSignal<
    Array<{ path: string; name: string; thumbnailPath: string }>
  >([]);
  const [isLoadingRecordings, setIsLoadingRecordings] = createSignal(false);
  const [showRecordingSelector, setShowRecordingSelector] = createSignal(false);

  const submission = useSubmission(sendFeedbackAction);
  const sendFeedback = useAction(sendFeedbackAction);

  const loadRecordings = async () => {
    setIsLoadingRecordings(true);
    try {
      const result = await commands.listRecordings().catch(() => [] as const);
      const recentRecordings = result.slice(0, 10).map(([path, meta]) => ({
        path,
        name: meta.pretty_name,
        thumbnailPath: `${path}/screenshots/display.jpg`,
      }));
      setRecordings(recentRecordings);
      if (recentRecordings.length > 0) {
        setSelectedRecording(recentRecordings[0].path);
      }
    } catch (error) {
      console.error("Error loading recordings:", error);
      setRecordings([]);
    } finally {
      setIsLoadingRecordings(false);
    }
  };

  const sendRecording = async () => {
    const recordingPath = selectedRecording();
    if (!recordingPath) return;

    setIsSubmittingRecording(true);
    setRecordingResult({});

    try {
      const recordingZip = await commands.getRecordingZip(recordingPath);

      if (!recordingZip) {
        setRecordingResult({ error: "Failed to compress recording" });
        return;
      }

      const logsAndInfo = await commands.getLogsAndSystemInfo();

      const response = await apiClient.desktop.submitRecording({
        body: {
          systemInfo: logsAndInfo.system_info,
          appVersion: logsAndInfo.app_version,
          recording: {
            name: recordingZip.name,
            content: recordingZip.content,
            size_mb: recordingZip.size_mb,
          },
        },
        headers: await protectedHeaders(),
      });

      if (response.status !== 200) {
        throw new Error(`Failed to send recording: ${response.status}`);
      }

      setRecordingResult({ success: true });
      setShowRecordingSelector(false);
    } catch (error) {
      if (error instanceof Error) {
        setRecordingResult({ error: error.message });
      } else {
        setRecordingResult({ error: "Failed to send recording" });
      }
    } finally {
      setIsSubmittingRecording(false);
    }
  };

  const sendLogs = async () => {
    setIsSubmittingLogs(true);
    setLogsResult({});

    try {
      const logsAndInfo = await commands.getLogsAndSystemInfo();

      const logFilePaths = logsAndInfo.recent_logs
        .filter((log) => log.log_file_path)
        .map((log) => log.log_file_path as string);

      let logFiles: Array<{ name: string; content: string }> = [];
      if (logFilePaths.length > 0) {
        logFiles = await commands.getLogFiles(logFilePaths);
      }

      const response = await apiClient.desktop.submitLogs({
        body: {
          systemInfo: logsAndInfo.system_info,
          recentLogs: logsAndInfo.recent_logs,
          appVersion: logsAndInfo.app_version,
          logFiles: logFiles,
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

      setLogsResult({ success: true });
    } catch (error) {
      console.error("Detailed error sending logs:", error);
      if (error instanceof Error) {
        setLogsResult({ error: `Error: ${error.message}` });
      } else {
        setLogsResult({ error: `Unknown error: ${JSON.stringify(error)}` });
      }
    } finally {
      setIsSubmittingLogs(false);
    }
  };

  return (
    <div class="flex flex-col w-full h-full">
      <div class="flex-1 custom-scroll">
        <div class="p-4 space-y-4">
          <div class="flex flex-col pb-4 border-b border-gray-2">
            <h2 class="text-lg font-medium text-gray-12">Send Feedback</h2>
            <p class="text-sm text-gray-10">
              Help us improve Cap by submitting feedback or reporting bugs.
              We'll get right on it.
            </p>
          </div>
          <form
            class="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              sendFeedback(feedback());
            }}
          >
            <fieldset disabled={submission.pending}>
              <div>
                <textarea
                  value={feedback()}
                  onInput={(e) => setFeedback(e.currentTarget.value)}
                  placeholder="Tell us what you think about Cap..."
                  required
                  minLength={10}
                  class="p-2 w-full h-32 text-[13px] rounded-md border transition-colors duration-200 resize-none bg-gray-2 placeholder:text-gray-10 border-gray-3 text-primary focus:outline-none focus:ring-1 focus:ring-gray-8 hover:border-gray-6"
                />
              </div>

              {submission.error && (
                <p class="mt-2 text-sm text-red-400">
                  {submission.error.toString()}
                </p>
              )}

              {submission.result?.success && (
                <p class="text-sm text-primary">Thank you for your feedback!</p>
              )}

              <Button
                type="submit"
                size="md"
                disabled={!feedback().trim() || feedback().trim().length < 0}
                class="mt-2 bg-primary text-primary"
              >
                {submission.pending ? "Submitting..." : "Submit Feedback"}
              </Button>
            </fieldset>
          </form>

          {/* Send Logs Section */}
          <div class="mt-8 pt-6 border-t border-gray-2">
            <h3 class="text-md font-medium text-gray-12 mb-2">
              Send Diagnostic Logs
            </h3>
            <p class="text-sm text-gray-10 mb-4">
              Send diagnostic information and logs from your recent recordings
              to help us troubleshoot issues.
            </p>

            <div class="p-3 bg-gray-2 rounded-md mb-4">
              <p class="text-sm text-gray-11 mb-2">This will send:</p>
              <ul class="text-sm text-gray-10 space-y-1 list-disc list-inside">
                <li>System information (OS, hardware, displays)</li>
                <li>Camera and microphone device list</li>
                <li>Logs from your 3 most recent recordings</li>
                <li>Cap app version information</li>
              </ul>
            </div>

            {logsResult().error && (
              <p class="text-sm text-red-400 mb-3">{logsResult().error}</p>
            )}

            {logsResult().success && (
              <p class="text-sm text-green-400 mb-3">
                Logs sent successfully! Thank you for helping us improve Cap.
              </p>
            )}

            <Button
              onClick={sendLogs}
              size="md"
              disabled={isSubmittingLogs()}
              class="bg-primary text-primary"
            >
              {isSubmittingLogs() ? "Sending..." : "Send Logs to Cap Team"}
            </Button>
          </div>

          {/* Send Recording Section */}
          <div class="mt-8 pt-6 border-t border-gray-2">
            <h3 class="text-md font-medium text-gray-12 mb-2">
              Send Recording
            </h3>
            <p class="text-sm text-gray-10 mb-4">
              Send a recording to help us debug specific issues. The entire
              recording folder will be compressed and uploaded securely.
            </p>

            <div class="p-3 bg-gray-2 rounded-md mb-4">
              <p class="text-sm text-gray-11 mb-2">⚠️ Important:</p>
              <ul class="text-sm text-gray-10 space-y-1 list-disc list-inside">
                <li>
                  This will send your entire recording including video/audio to
                  the Cap team.
                </li>
                <li>
                  Large recordings may take some time to compress and upload.
                </li>
                <li>Only use this when requested by the Cap team.</li>
              </ul>
            </div>

            <Show when={!showRecordingSelector()}>
              <div class="flex gap-2 items-center">
                <Button
                  onClick={async () => {
                    await loadRecordings();
                    if (recordings().length > 0) {
                      setShowRecordingSelector(true);
                      // Scroll to bottom after a small delay to ensure DOM is updated
                      setTimeout(() => {
                        const container =
                          document.querySelector(".custom-scroll");
                        if (container) {
                          container.scrollTo({
                            top: container.scrollHeight,
                            behavior: "smooth",
                          });
                        }
                      }, 100);
                    } else {
                      setRecordingResult({ error: "No recordings found" });
                    }
                  }}
                  size="md"
                  disabled={isLoadingRecordings()}
                  class="bg-primary text-primary"
                >
                  {isLoadingRecordings() ? (
                    <IconLucideLoaderCircle class="animate-spin size-4" />
                  ) : (
                    "Select Recording to Send"
                  )}
                </Button>
              </div>
            </Show>

            <Show when={showRecordingSelector()}>
              <div class="space-y-3">
                <div class="max-h-60 overflow-y-auto border border-gray-3 rounded-md">
                  <For each={recordings()}>
                    {(recording, index) => (
                      <div
                        class={`flex items-center gap-3 p-3 hover:bg-gray-3 cursor-pointer transition-colors ${
                          selectedRecording() === recording.path
                            ? "bg-gray-3"
                            : ""
                        } ${
                          index() !== recordings().length - 1
                            ? "border-b border-gray-3"
                            : ""
                        }`}
                        onClick={() => setSelectedRecording(recording.path)}
                      >
                        <input
                          type="radio"
                          name="recording"
                          checked={selectedRecording() === recording.path}
                          class="text-primary"
                        />
                        <img
                          class="object-cover rounded size-10"
                          alt="Recording thumbnail"
                          src={convertFileSrc(recording.thumbnailPath)}
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                        <span class="text-sm text-gray-12">
                          {recording.name}
                        </span>
                      </div>
                    )}
                  </For>
                </div>

                <Show when={isSubmittingRecording()}>
                  <div class="p-3 bg-blue-500/10 border border-blue-500/20 rounded-md">
                    <div class="flex items-center gap-2 text-sm text-blue-400">
                      <IconLucideLoaderCircle class="animate-spin size-4" />
                      <span>Uploading recording...</span>
                    </div>
                    <p class="mt-1 text-xs text-gray-10">
                      Please keep this window open while we upload your
                      recording.
                    </p>
                  </div>
                </Show>

                {recordingResult().error && (
                  <p class="text-sm text-red-400">{recordingResult().error}</p>
                )}

                {recordingResult().success && (
                  <p class="text-sm">
                    Recording sent successfully. The Cap team will review it and
                    get back to you as soon as possible.
                  </p>
                )}

                <div class="flex gap-2">
                  <Button
                    onClick={sendRecording}
                    size="md"
                    disabled={isSubmittingRecording() || !selectedRecording()}
                    class="bg-primary text-primary"
                  >
                    {isSubmittingRecording()
                      ? "Uploading..."
                      : "Send Selected Recording"}
                  </Button>
                  <Show when={!isSubmittingRecording()}>
                    <Button
                      onClick={() => {
                        setShowRecordingSelector(false);
                        setSelectedRecording(null);
                      }}
                      size="md"
                      class="bg-gray-3 text-gray-12"
                    >
                      Cancel
                    </Button>
                  </Show>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
