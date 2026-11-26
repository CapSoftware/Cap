import { type RefObject, useCallback, useEffect, useRef } from "react";

export const MESSENGER_POLL_BACKOFF_MS = [3000, 6000, 12000, 30000, 60000];
export const MESSENGER_HIDDEN_POLL_MS = 60000;

interface MessengerPollMessage {
	id: string;
	role: "user" | "agent" | "admin";
	content: string;
}

interface MessengerPollConversation {
	id: string;
	agent: string;
	mode: "agent" | "human";
}

interface MessengerPollSnapshot {
	conversation: MessengerPollConversation;
	messages: MessengerPollMessage[];
}

interface MessengerUpdates {
	mode: MessengerPollConversation["mode"];
	messages: MessengerPollMessage[];
}

const fetchMessengerUpdates = async ({
	conversation,
	messages,
}: MessengerPollSnapshot): Promise<MessengerUpdates | null> => {
	const params = new URLSearchParams({ mode: conversation.mode });
	const after = messages
		.filter((message) => !message.id.startsWith("optimistic-"))
		.at(-1)?.id;
	if (after) params.set("after", after);
	const response = await fetch(
		`/api/messenger/conversations/${encodeURIComponent(conversation.id)}/updates?${params}`,
		{ cache: "no-store" },
	);
	if (response.status === 204) return null;
	if (!response.ok)
		throw new Error(`Messenger updates failed with ${response.status}`);
	return (await response.json()) as MessengerUpdates;
};

export function useMessengerPoll({
	conversation,
	messages,
	hiddenPollMs,
	isSendingRef,
	messageVersionRef,
	onSnapshot,
}: MessengerPollSnapshot & {
	hiddenPollMs: number | null;
	isSendingRef: RefObject<boolean>;
	messageVersionRef: RefObject<number>;
	onSnapshot: (snapshot: MessengerPollSnapshot) => void;
}) {
	const latestRef = useRef<MessengerPollSnapshot>({ conversation, messages });
	const onSnapshotRef = useRef(onSnapshot);
	const resetBackoffRef = useRef(() => {});

	useEffect(() => {
		latestRef.current = { conversation, messages };
		onSnapshotRef.current = onSnapshot;
	});

	useEffect(() => {
		let active = true;
		let pollVersion = 0;
		let appliedPollVersion = 0;
		let idlePolls = 0;
		let interval: ReturnType<typeof setInterval> | undefined;
		let intervalMs: number | null = null;

		const schedule = () => {
			const delay = document.hidden
				? hiddenPollMs
				: MESSENGER_POLL_BACKOFF_MS[
						Math.min(idlePolls, MESSENGER_POLL_BACKOFF_MS.length - 1)
					];
			if (interval !== undefined && delay === intervalMs) return;
			clearInterval(interval);
			interval = undefined;
			intervalMs = delay ?? null;
			if (delay != null) interval = setInterval(poll, delay);
		};

		const poll = async () => {
			if (isSendingRef.current) return;
			const requestVersion = ++pollVersion;
			const messageVersion = messageVersionRef.current;
			const result = await fetchMessengerUpdates(latestRef.current).then(
				(updates) => ({ updates }),
				() => null,
			);
			if (
				!active ||
				isSendingRef.current ||
				requestVersion <= appliedPollVersion ||
				messageVersion !== messageVersionRef.current
			)
				return;
			if (!result) {
				idlePolls++;
				schedule();
				return;
			}
			appliedPollVersion = requestVersion;

			const latest = latestRef.current;
			const known = new Set(latest.messages.map((message) => message.id));
			const added =
				result.updates?.messages.filter((message) => !known.has(message.id)) ??
				[];
			const mode = result.updates?.mode ?? latest.conversation.mode;
			const changed = added.length > 0 || mode !== latest.conversation.mode;
			idlePolls = changed ? 0 : idlePolls + 1;
			if (changed) {
				const snapshot = {
					conversation: { ...latest.conversation, mode },
					messages: [...latest.messages, ...added],
				};
				latestRef.current = snapshot;
				onSnapshotRef.current(snapshot);
			}
			schedule();
		};

		const handleVisibility = () => {
			if (!document.hidden) poll();
			schedule();
		};

		resetBackoffRef.current = () => {
			idlePolls = 0;
			schedule();
		};
		document.addEventListener("visibilitychange", handleVisibility);
		schedule();

		return () => {
			active = false;
			clearInterval(interval);
			document.removeEventListener("visibilitychange", handleVisibility);
			resetBackoffRef.current = () => {};
		};
	}, [hiddenPollMs, isSendingRef, messageVersionRef]);

	return useCallback(() => resetBackoffRef.current(), []);
}
