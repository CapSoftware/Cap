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
import { Section, SectionCard, SettingsPageContent } from "./Setting";

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
		<div class="cap-settings-page flex flex-col h-full custom-scroll">
			<SettingsPageContent>
				<Section
					title="转录"
					description="添加人名、拼写、域名和大小写偏好，生成字幕时会优先采用这些写法。"
				>
					<SectionCard padded class="space-y-3">
						<div class="flex items-center justify-between gap-3">
							<div class="flex flex-col gap-0.5 min-w-0">
								<p class="text-[13px] text-gray-12">记忆词条</p>
								<p class="text-xs leading-snug text-gray-10">
									每次添加一个词条，减少拼写和格式错误。
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
										清空
									</Button>
								</Show>
								<span class="text-xs text-gray-11 min-w-15 text-right">
									{saveState() === "saving"
										? "正在保存……"
										: saveState() === "saved"
											? "已保存"
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
								placeholder="添加词条"
								spellcheck={false}
								autocapitalize="off"
								autocomplete="off"
								autocorrect="off"
								class="flex-1 px-3 py-2 bg-gray-1 border border-gray-3 rounded-md text-gray-12 placeholder:text-gray-10 focus:outline-hidden focus:ring-1 focus:ring-gray-8 hover:border-gray-6"
							/>
							<Button
								onClick={addHint}
								disabled={pendingHint().trim().length === 0}
								class="shrink-0"
							>
								<IconLucidePlus class="size-4" />
								添加
							</Button>
						</div>

						<p class="text-xs leading-relaxed text-gray-10">
							在编辑器中生成字幕时会应用这些提示词。
						</p>
					</SectionCard>
				</Section>

				<Show when={hints().length > 0}>
					<Section
						title="已启用的提示词"
						right={
							<span class="text-xs text-gray-10">{hints().length} 项</span>
						}
					>
						<SectionCard padded>
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
						</SectionCard>
					</Section>
				</Show>
			</SettingsPageContent>
		</div>
	);
}
