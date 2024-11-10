import { createSignal } from "solid-js";
import { Button } from "@cap/ui-solid";
import { commands } from "~/utils/tauri";

export default function FeedbackTab() {
  const [feedback, setFeedback] = createSignal("");
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!feedback().trim()) return;

    setIsSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      await commands.sendFeedbackRequest(feedback());
      setSuccess(true);
      setFeedback("");
    } catch (err) {
      console.error("Error submitting feedback:", err);
      setError(
        err instanceof Error ? err.message : "Failed to submit feedback"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div class="p-6 max-w-2xl">
      <h2 class="text-lg font-medium mb-2">Send Feedback</h2>
      <p class="text-gray-400 mb-[1rem]">
        Help us improve Cap by submitting feedback or reporting bugs. We'll get
        right on it.
      </p>
      <form class="space-y-4">
        <div>
          <textarea
            value={feedback()}
            onInput={(e) => setFeedback(e.currentTarget.value)}
            placeholder="Tell us what you think about Cap..."
            required
            minLength={10}
            class="w-full h-32 p-2 border border-gray-300 rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isSubmitting()}
          />
        </div>

        {error() && <p class="text-red-500 text-sm">{error()}</p>}

        {success() && (
          <p class="text-green-500 text-sm">Thank you for your feedback!</p>
        )}

        <Button
          onClick={handleSubmit}
          type="button"
          disabled={
            isSubmitting() || !feedback().trim() || feedback().trim().length < 0
          }
          class="w-full"
        >
          {isSubmitting() ? "Submitting..." : "Submit Feedback"}
        </Button>
      </form>
    </div>
  );
}
