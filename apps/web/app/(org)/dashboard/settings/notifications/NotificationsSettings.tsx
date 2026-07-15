"use client";

import { Card, CardDescription, CardTitle, Switch } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { updatePreferences } from "@/actions/notifications/update-preferences";
import { useDashboardContext } from "../../Contexts";

type NotificationPreferences = {
	pauseComments: boolean;
	pauseReplies: boolean;
	pauseViews: boolean;
	pauseReactions: boolean;
	pauseAnonViews: boolean;
};

const DEFAULT_PREFERENCES: NotificationPreferences = {
	pauseComments: false,
	pauseReplies: false,
	pauseViews: false,
	pauseReactions: false,
	pauseAnonViews: false,
};

const NOTIFICATION_TYPES: {
	key: keyof NotificationPreferences;
	title: string;
	description: string;
}[] = [
	{
		key: "pauseComments",
		title: "评论",
		description: "有人评论你的录制时，通过邮件和应用内通知提醒你。",
	},
	{
		key: "pauseReplies",
		title: "回复",
		description: "有人回复你的评论时，通过应用内通知提醒你。",
	},
	{
		key: "pauseViews",
		title: "观看",
		description: "已登录的观众观看你的录制时提醒你。",
	},
	{
		key: "pauseAnonViews",
		title: "匿名观看",
		description: "匿名观众观看你的录制时提醒你。",
	},
	{
		key: "pauseReactions",
		title: "回应",
		description: "有人对你的录制作出回应时，通过应用内通知提醒你。",
	},
];

export const NotificationsSettings = () => {
	const router = useRouter();
	const { userPreferences } = useDashboardContext();
	const [preferences, setPreferences] = useState<NotificationPreferences>(
		() => ({
			...DEFAULT_PREFERENCES,
			...(userPreferences?.notifications ?? {}),
		}),
	);

	const { mutate } = useMutation({
		mutationFn: (next: NotificationPreferences) =>
			updatePreferences({ notifications: next }),
		onSuccess: () => router.refresh(),
		onError: () => toast.error("更新通知偏好失败"),
	});

	const toggle = (key: keyof NotificationPreferences) => {
		const previous = preferences;
		const next = { ...preferences, [key]: !preferences[key] };
		setPreferences(next);
		mutate(next, { onError: () => setPreferences(previous) });
	};

	return (
		<Card className="divide-y divide-gray-4">
			{NOTIFICATION_TYPES.map(({ key, title, description }) => (
				<div
					key={key}
					className="flex gap-4 justify-between items-center py-4 first:pt-0 last:pb-0"
				>
					<div className="space-y-1">
						<CardTitle className="text-base">{title}</CardTitle>
						<CardDescription>{description}</CardDescription>
					</div>
					<Switch
						checked={!preferences[key]}
						onCheckedChange={() => toggle(key)}
						aria-label={`${title}通知`}
					/>
				</div>
			))}
		</Card>
	);
};
