import { Button } from "@cap/ui-solid";
import { action, useAction, useSubmission } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import { type as ostype } from "@tauri-apps/plugin-os";
import { createSignal } from "solid-js";

import { apiClient, protectedHeaders } from "~/utils/web-api";

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

	const submission = useSubmission(sendFeedbackAction);
	const sendFeedback = useAction(sendFeedbackAction);

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
								variant="dark"
								disabled={feedback().trim().length < 4}
								class="mt-2"
							>
								{submission.pending ? "Submitting..." : "Submit Feedback"}
							</Button>
						</fieldset>
					</form>
				</div>
			</div>
		</div>
	);
}
