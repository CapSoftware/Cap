import { Button } from "@cap/ui-solid";
import { action, useAction, useSubmission } from "@solidjs/router";
import { createSignal, Show, For, createEffect } from "solid-js";
import { type as ostype } from "@tauri-apps/plugin-os";
import { getVersion } from "@tauri-apps/api/app";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { apiClient, protectedHeaders } from "~/utils/web-api";
import { commands } from "~/utils/tauri";
import toast from "solid-toast";

const sendFeedbackAction = action(async (feedback: string) => {
  const response = await apiClient.desktop.submitFeedback({
    body: { feedback, os: ostype() as any, version: await getVersion() },
    headers: await protectedHeaders(),
  });

  if (response.status !== 200) throw new Error("Failed to submit feedback");
  return response.body;
});

export default function FeedbackTab() {
  const [feedback, setFeedback] = createSignal("");
  const [isSubmittingDiagnostics, setIsSubmittingDiagnostics] =
    createSignal(false);
  const [recordings, setRecordings] = createSignal<Array<[string, any]>>([]);
  const [selectedRecording, setSelectedRecording] = createSignal<string>("");
  const [isLoadingRecordings, setIsLoadingRecordings] = createSignal(false);
  const [isUploadingBundle, setIsUploadingBundle] = createSignal(false);

  const submission = useSubmission(sendFeedbackAction);
  const sendFeedback = useAction(sendFeedbackAction);

  const submitDeviceDiagnostics = async () => {
    setIsSubmittingDiagnostics(true);
    try {
      // Collect diagnostics first
      const diagnosticsData = await commands.collectDiagnostics();
      console.log("Collected diagnostics:", diagnosticsData);

      // Then submit them
      const result = (await commands.submitDeviceProfile(
        diagnosticsData,
        null, // no description
        false // don't include errors
      )) as any; // TypeScript bindings need regeneration

      if (result && result.success) {
        toast.success("Device diagnostics submitted successfully");
        if (result.profileId) {
          console.log("Profile ID:", result.profileId);
        }
      } else {
        toast.error("Failed to submit device diagnostics");
      }
    } catch (error) {
      console.error("Failed to submit device diagnostics:", error);
      toast.error("Failed to submit device diagnostics");
    } finally {
      setIsSubmittingDiagnostics(false);
    }
  };

  const loadRecordings = async () => {
    setIsLoadingRecordings(true);
    try {
      const result = await commands.listRecordings();
      // Take only the first 10 recordings
      setRecordings(result.slice(0, 10));
    } catch (error) {
      console.error("Failed to load recordings:", error);
      toast.error("Failed to load recordings");
    } finally {
      setIsLoadingRecordings(false);
    }
  };

  // Load recordings on component mount
  createEffect(() => {
    loadRecordings();
  });

  const handleSendRecordingBundle = async () => {
    if (!selectedRecording()) {
      toast.error("Please select a recording");
      return;
    }

    setIsUploadingBundle(true);
    try {
      await commands.uploadRecordingBundle(selectedRecording());
      toast.success("Recording bundle sent successfully");
      setSelectedRecording("");
    } catch (error) {
      console.error("Failed to upload recording bundle:", error);
      toast.error("Failed to upload recording bundle");
    } finally {
      setIsUploadingBundle(false);
    }
  };

  return (
    <div class="flex flex-col w-full h-full">
      <div class="flex-1 custom-scroll">
        <div class="p-4 space-y-2">
          <div class="py-2 mb-4">
            <h2 class="text-gray-12 text-lg font-medium">Send Feedback</h2>
            <p class="text-gray-11 text-sm">
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
                  class="p-2 w-full h-32 bg-gray-2 rounded-md border transition-shadow duration-200 resize-none placeholder:text-zinc-400 border-gray-6 text-primary focus:outline-none focus:ring-2 focus:ring-blue-9"
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
                disabled={!feedback().trim() || feedback().trim().length < 10}
                class="mt-2 w-full bg-primary text-primary"
              >
                {submission.pending ? "Submitting..." : "Submit Feedback"}
              </Button>
            </fieldset>
          </form>

          {/* Debug Section */}
          <div class="pt-8 mt-8 border-t border-gray-5">
            <div class="py-2 mb-4">
              <h3 class="text-gray-12 text-base font-medium">
                Device Diagnostics
              </h3>
              <p class="text-gray-11 text-sm">
                Submit your device information to help us debug issues and
                improve compatibility.
              </p>
            </div>

            <div class="space-y-3">
              <Button
                onClick={submitDeviceDiagnostics}
                disabled={isSubmittingDiagnostics()}
                variant="secondary"
                class="w-full"
              >
                {isSubmittingDiagnostics()
                  ? "Submitting..."
                  : "Submit Device Diagnostics"}
              </Button>
            </div>
          </div>

          {/* Recording Bundle Section */}
          <div class="pt-8 mt-8 border-t border-gray-5">
            <div class="py-2 mb-4">
              <h3 class="text-gray-12 text-base font-medium">
                Send Recording Bundle
              </h3>
              <p class="text-gray-11 text-sm">
                Send a recording bundle to Cap support for debugging. This will
                help us investigate specific issues with your recordings.
              </p>
            </div>

            <div class="space-y-3">
              <div>
                <label class="block text-sm font-medium text-gray-11 mb-1">
                  Select Recording
                </label>
                <select
                  value={selectedRecording()}
                  onChange={(e) => setSelectedRecording(e.currentTarget.value)}
                  disabled={isLoadingRecordings() || isUploadingBundle()}
                  class="w-full p-2 bg-gray-2 border border-gray-6 rounded-md text-primary focus:outline-none focus:ring-2 focus:ring-blue-9"
                >
                  <option value="">
                    {isLoadingRecordings()
                      ? "Loading recordings..."
                      : "Choose a recording"}
                  </option>
                  <For each={recordings()}>
                    {(recording) => (
                      <option value={recording[0]}>
                        {recording[1].pretty_name}
                      </option>
                    )}
                  </For>
                </select>
              </div>

              <Button
                onClick={handleSendRecordingBundle}
                disabled={!selectedRecording() || isUploadingBundle()}
                variant="secondary"
                class="w-full"
              >
                {isUploadingBundle() ? "Uploading..." : "Send Recording Bundle"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
