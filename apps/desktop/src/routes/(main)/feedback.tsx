import { Button } from "@cap/ui-solid";
import { clientEnv } from "../../utils/env";
import { createSignal, onMount, Show } from "solid-js";
import { authStore } from "../../store";
import { getCurrentWindow } from "@tauri-apps/api/window";

export default function Page() {
  let textareaRef: HTMLTextAreaElement | undefined;
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [feedbackText, setFeedbackText] = createSignal("");
  const [isSubmitted, setIsSubmitted] = createSignal(false);

  onMount(() => {
    if (textareaRef) {
      textareaRef.focus();
    }
  });

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!feedbackText().trim()) return;

    setIsSubmitting(true);
    try {
      const auth = await authStore.get();

      if (!auth) {
        console.error("User not authenticated");
        window.close();
        return;
      }

      const formData = new FormData();
      formData.append("feedback", feedbackText());

      const response = await fetch(
        `${clientEnv.VITE_SERVER_URL}/api/desktop/feedback?origin=${window.location.origin}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.token}`,
          },
          body: formData,
        }
      );

      if (!response.ok) {
        throw new Error("Failed to submit feedback");
      }

      const data = await response.json();
      console.log("Feedback submitted:", data);
      setFeedbackText("");
      setIsSubmitted(true);
    } catch (error) {
      console.error("Error submitting feedback:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div class="flex flex-col p-[1rem] gap-[0.75rem] text-[0.875rem] font-[400] flex-1 bg-gray-100">
      <Show
        when={!isSubmitted()}
        fallback={
          <div class="flex flex-col items-center justify-center h-full text-center">
            <div>
              <IconLucideSmile class="size-[5rem] text-gray-200 mb-[1rem]" />
            </div>
            <h2 class="text-[1.15rem] font-[500] mb-[1.5rem]">
              Thank you, your feedback has been received.
            </h2>
            <Button
              onClick={() => {
                const window = getCurrentWindow();
                window.close();
              }}
              type="button"
            >
              Close Window
            </Button>
          </div>
        }
      >
        <h2 class="text-[1rem] font-[600] mb-[0.25rem]">
          Feedback / Report a bug
        </h2>
        <p class="text-gray-400 mb-[1rem]">
          Help us improve Cap by submitting feedback or reporting bugs. We'll
          get right on it.
        </p>
        <form>
          <textarea
            ref={textareaRef}
            value={feedbackText()}
            onInput={(e) => setFeedbackText(e.currentTarget.value)}
            class="w-full h-[150px] p-[0.5rem] border border-gray-300 rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Please enter your feedback here..."
            autofocus
          ></textarea>
          <Button
            onClick={handleSubmit}
            type="button"
            class="mt-[1rem] flex items-center justify-between gap-[0.5rem]"
            disabled={isSubmitting()}
          >
            {isSubmitting() ? (
              <>
                Submitting...
                <IconLucideLoaderCircle class="size-[1rem] animate-spin" />
              </>
            ) : (
              "Submit Feedback"
            )}
          </Button>
        </form>
      </Show>
    </div>
  );
}
