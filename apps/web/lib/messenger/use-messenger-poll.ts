import { type RefObject, useCallback, useEffect, useRef } from "react";
import { fetchMessengerConversation } from "@/actions/messenger";

type MessengerConversationSnapshot = Awaited<
	ReturnType<typeof fetchMessengerConversation>
>;

export const MESSENGER_POLL_BACKOFF_MS = [3000, 6000, 12000, 30000, 60000];
export const MESSENGER_HIDDEN_POLL_MS = 60000;

const activityKey = ({
	conversation,
	messages,
}: MessengerConversationSnapshot) =>
	`${conversation.mode}:${messages.length}:${messages.at(-1)?.id ?? ""}`;

export function useMessengerPoll({
	conversationId,
	hiddenPollMs,
	isSendingRef,
	messageVersionRef,
	onSnapshot,
}: {
	conversationId: string;
	hiddenPollMs: number | null;
	isSendingRef: RefObject<boolean>;
	messageVersionRef: RefObject<number>;
	onSnapshot: (snapshot: MessengerConversationSnapshot) => void;
}) {
	const onSnapshotRef = useRef(onSnapshot);
	const resetBackoffRef = useRef(() => {});

	useEffect(() => {
		onSnapshotRef.current = onSnapshot;
	});

	useEffect(() => {
		let active = true;
		let pollVersion = 0;
		let appliedPollVersion = 0;
		let idlePolls = 0;
		let lastActivity: string | null = null;
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
			const data = await fetchMessengerConversation(conversationId).catch(
				() => null,
			);
			if (!active) return;
			if (
				data &&
				!isSendingRef.current &&
				requestVersion > appliedPollVersion &&
				messageVersion === messageVersionRef.current
			) {
				appliedPollVersion = requestVersion;
				const activity = activityKey(data);
				const changed = lastActivity !== null && activity !== lastActivity;
				lastActivity = activity;
				idlePolls = changed ? 0 : idlePolls + 1;
				onSnapshotRef.current(data);
			} else {
				idlePolls++;
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
	}, [conversationId, hiddenPollMs, isSendingRef, messageVersionRef]);

	return useCallback(() => resetBackoffRef.current(), []);
}
