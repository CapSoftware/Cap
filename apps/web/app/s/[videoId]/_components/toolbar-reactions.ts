export interface ReactionDefinition {
	emoji: string;
	label: string;
}

export const REACTIONS: readonly ReactionDefinition[] = [
	{
		emoji: "😂",
		label: "joy",
	},
	{
		emoji: "😍",
		label: "love",
	},
	{
		emoji: "😮",
		label: "wow",
	},
	{
		emoji: "🙌",
		label: "yay",
	},
	{
		emoji: "👍",
		label: "up",
	},
	{
		emoji: "👎",
		label: "down",
	},
];

export interface HandleEmojiReactionParams {
	emoji: string;
	canReact: boolean;
	user: { id: string } | null | undefined;
	onRequireAuth: () => void;
	onReact: (emoji: string) => void | Promise<void>;
}

export function handleEmojiReaction({
	emoji,
	canReact,
	user,
	onRequireAuth,
	onReact,
}: HandleEmojiReactionParams): void {
	if (!canReact) return;
	if (!user) {
		onRequireAuth();
		return;
	}
	void onReact(emoji);
}
