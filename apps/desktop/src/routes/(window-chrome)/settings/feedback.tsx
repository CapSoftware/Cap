import { Button } from "@cap/ui-solid";
import { action, useAction, useSubmission } from "@solidjs/router";
import { createSignal } from "solid-js";

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
      <h2 class="mb-2 text-lg font-medium text-primary">Send Feedback</h2>
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
              class="p-2 w-full h-32 bg-gray-2 rounded-md border transition-shadow duration-200 resize-none placeholder:text-zinc-400 border-zinc-200 text-primary focus:outline-none focus:ring-2 focus:ring-blue-9"
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
            disabled={!feedback().trim() || feedback().trim().length < 0}
            class="mt-2 w-full bg-primary text-primary"
          >
            {submission.pending ? "Submitting..." : "Submit Feedback"}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}
