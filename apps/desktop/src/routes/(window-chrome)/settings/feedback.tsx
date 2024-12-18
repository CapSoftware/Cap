import { createSignal } from "solid-js";
import { Button } from "@cap/ui-solid";
import { action, useAction, useSubmission } from "@solidjs/router";

import { apiClient, protectedHeaders } from "~/utils/web-api";

const sendFeedbackAction = action(async (feedback: string) => {
  const response = await apiClient.desktop.submitFeedback({
    body: { feedback },
    headers: await protectedHeaders(),
  });

  if (response.status !== 200) throw new Error("Failed to submit feedback");
  return response.body;
});

export default function FeedbackTab() {
  const [feedback, setFeedback] = createSignal("");

  const submission = useSubmission(sendFeedbackAction);
  const sendFeedback = useAction(sendFeedbackAction);

  return (
    <div class="p-6 max-w-2xl">
      <h2 class="text-[--text-primary] text-lg font-medium mb-2">
        Send Feedback
      </h2>
      <p class="text-[--text-tertiary] mb-[1rem]">
        Help us improve Cap by submitting feedback or reporting bugs. We'll get
        right on it.
      </p>
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
              class="w-full h-32 p-2 border border-[--gray-500] bg-[--gray-100] text-[--text-primary] rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-[--blue-400]"
            />
          </div>

          {submission.error && (
            <p class="text-red-500 text-sm">{submission.error.toString()}</p>
          )}

          {submission.result?.success && (
            <p class="text-[--text-primary] text-sm">
              Thank you for your feedback!
            </p>
          )}

          <Button
            type="submit"
            onClick={() => console.log("bruh")}
            disabled={!feedback().trim() || feedback().trim().length < 0}
            class="w-full bg-[--blue-400] text-[--text-primary]"
          >
            {submission.pending ? "Submitting..." : "Submit Feedback"}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}
