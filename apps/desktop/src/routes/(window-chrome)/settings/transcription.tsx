import { Button } from "@cap/ui-solid";
import {
	createEffect,
	createResource,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import { Input } from "~/routes/editor/ui";
import { generalSettingsStore } from "~/store";
import {
	deriveGeneralSettings,
	type GeneralSettingsStore,
	normalizeTranscriptionHints,
} from "~/utils/general-settings";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideX from "~icons/lucide/x";

export default function TranscriptionSettings() {
	const [store] = createResource(() => generalSettingsStore.get());

	return (
		<Show when={store.state === "ready" && ([store()] as const)}>
			{(store) => <Inner initialStore={store()[0] ?? null} />}
		</Show>
	);
}

function Inner(props: { initialStore: GeneralSettingsStore | null }) {
	const [hints, setHints] = createSignal(
		deriveGeneralSettings(props.initialStore).transcriptionHints ?? [],
	);
	const [pendingHint, setPendingHint] = createSignal("");
	const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved">(
		"idle",
	);
	let saveTimeout: ReturnType<typeof setTimeout> | undefined;
	let resetTimeout: ReturnType<typeof setTimeout> | undefined;

	createEffect(() => {
		setHints(
			deriveGeneralSettings(props.initialStore).transcriptionHints ?? [],
		);
	});

	const persist = (nextHints: string[]) => {
		const normalized = normalizeTranscriptionHints(nextHints);
		setSaveState("saving");

		if (saveTimeout) clearTimeout(saveTimeout);
		if (resetTimeout) clearTimeout(resetTimeout);

		saveTimeout = setTimeout(() => {
			void generalSettingsStore
				.set({
					transcriptionHints: normalized,
				})
				.then(() => {
					setSaveState("saved");
					resetTimeout = setTimeout(() => setSaveState("idle"), 1200);
				})
				.catch((error) => {
					console.error("Failed to save transcription hints", error);
					setSaveState("idle");
				});
		}, 250);
	};

	const addHint = () => {
		const value = pendingHint().replaceAll("\0", "").trim();
		if (!value) return;

		const nextHints = normalizeTranscriptionHints([...hints(), value]);
		if (nextHints.length === hints().length) {
			setPendingHint("");
			return;
		}

		setHints(nextHints);
		setPendingHint("");
		persist(nextHints);
	};

	const removeHint = (hintToRemove: string) => {
		const nextHints = hints().filter((hint) => hint !== hintToRemove);
		setHints(nextHints);
		persist(nextHints);
	};

	onCleanup(() => {
		if (saveTimeout) clearTimeout(saveTimeout);
		if (resetTimeout) clearTimeout(resetTimeout);
	});

	return (
		<div class="flex flex-col h-full custom-scroll">
			<div class="p-4 space-y-4">
				<div class="flex flex-col pb-4 border-b border-gray-2">
					<h2 class="text-lg font-medium text-gray-12">Transcription</h2>
					<p class="text-sm text-gray-10">
						Add names, spellings, domains, and capitalization preferences that
						caption generation should keep in mind.
					</p>
				</div>

				<div class="space-y-3">
					<div class="px-4 py-4 space-y-3 rounded-xl border border-gray-3 bg-gray-2">
						<div class="flex items-center justify-between gap-3">
							<div>
								<h3 class="text-sm font-medium text-gray-12">
									Remembered terms
								</h3>
								<p class="text-xs text-gray-11">
									Add one term at a time to reduce typos and formatting
									mistakes.
								</p>
							</div>
							<div class="flex items-center gap-2">
								<Show when={hints().length > 0}>
									<Button
										variant="gray"
										size="sm"
										onClick={() => {
											setHints([]);
											persist([]);
										}}
									>
										Clear
									</Button>
								</Show>
								<span class="text-xs text-gray-11 min-w-[3.75rem] text-right">
									{saveState() === "saving"
										? "Saving..."
										: saveState() === "saved"
											? "Saved"
											: ""}
								</span>
							</div>
						</div>

						<div class="flex items-center gap-2">
							<Input
								type="text"
								value={pendingHint()}
								onInput={(event) => setPendingHint(event.currentTarget.value)}
								onKeyDown={(event) => {
									if (event.key !== "Enter") return;
									event.preventDefault();
									addHint();
								}}
								placeholder="Add a term"
								spellcheck={false}
								autocapitalize="off"
								autocomplete="off"
								autocorrect="off"
								class="flex-1 px-3 py-2 bg-gray-1 border border-gray-3 rounded-md text-gray-12 placeholder:text-gray-10 focus:outline-none focus:ring-1 focus:ring-gray-8 hover:border-gray-6"
							/>
							<Button
								onClick={addHint}
								disabled={pendingHint().trim().length === 0}
								class="shrink-0"
							>
								<IconLucidePlus class="size-4" />
								Add
							</Button>
						</div>

						<p class="text-xs text-gray-11">
							These hints are applied when you generate captions in the editor.
						</p>
					</div>

					<Show when={hints().length > 0}>
						<div class="px-4 py-4 space-y-3 rounded-xl border border-gray-3 bg-gray-2">
							<div class="flex items-center justify-between gap-3">
								<h3 class="text-sm font-medium text-gray-12">Active hints</h3>
								<span class="text-xs text-gray-11">
									{hints().length} {hints().length === 1 ? "item" : "items"}
								</span>
							</div>
							<div class="flex flex-wrap gap-2">
								<For each={hints()}>
									{(hint) => (
										<button
											type="button"
											class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs text-gray-12 bg-gray-3 border border-gray-4 hover:bg-gray-4 transition-colors"
											onClick={() => removeHint(hint)}
										>
											<span>{hint}</span>
											<IconLucideX class="size-3" />
										</button>
									)}
								</For>
							</div>
						</div>
					</Show>
				</div>
			</div>
		</div>
	);
}
