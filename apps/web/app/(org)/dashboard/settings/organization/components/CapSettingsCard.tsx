import { Card, CardDescription, CardHeader, CardTitle, Switch } from "@cap/ui";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";

const VideoTabSettings = [
	{
		label: "5 minutes video duration",
		description: "Set the default video duration",
	},
	{
		label: "1080p resolution",
		description: "Set the default video resolution",
	},
	{
		label: "10Mbps bitrate",
		description: "Set the default video bitrate",
	},
];

const NotificationTabSettings = [
	{
		label: "Notifications",
		description: "Set the default notification settings",
	},
	{
		label: "Setting 1",
		description: "Set the default random settings",
	},
	{
		label: "Setting 2",
		description: "Set the default random settings",
	},
	{
		label: "Setting 3",
		description: "Set the default random settings",
	},
	{
		label: "Setting 4",
		description: "Set the default random settings",
	},
	{
		label: "Setting 5",
		description: "Set the default random settings",
	},
	{
		label: "Setting 6",
		description: "Set the default random settings",
	},
];

const CapSettingsCard = () => {
	const [activeTab, setActiveTab] = useState("Notifications");
	return (
		<Card className="flex relative flex-col flex-1 gap-6 w-full min-h-fit">
			<CardHeader>
				<CardTitle>Cap Settings</CardTitle>
				<CardDescription>
					Enable or disable specific settings for your organization.
					Notifications, videos, etc...
				</CardDescription>
			</CardHeader>

			<div className="relative">
				<div className="absolute top-0 left-0 z-[20] rounded-xl flex items-center justify-center w-full h-full backdrop-blur-md bg-zinc-900/20">
					<p className="px-3 py-2 text-sm font-semibold rounded-full border text-gray-12 border-gray-3 bg-gray-3">
						Coming Soon
					</p>
				</div>
				<div className="flex gap-4 pb-4 mt-3 border-b border-gray-3">
					{["Notifications", "Videos"].map((setting) => (
						<motion.div
							key={setting}
							style={{
								borderRadius: 12,
							}}
							onClick={() => setActiveTab(setting)}
							className={clsx("relative cursor-pointer")}
						>
							<p
								className={clsx(
									"relative z-10 text-[13px] px-2.5 py-1.5 font-medium transition-colors duration-200 text-gray-10 hover:text-gray-11",
									activeTab === setting && "text-gray-12 hover:text-gray-12",
								)}
							>
								{setting}
							</p>
							{/** Indicator */}
							{activeTab === setting && (
								<motion.div
									layoutId="activeTabIndicator"
									transition={{ damping: 25, stiffness: 250, type: "spring" }}
									className="absolute top-0 left-0 w-full h-full rounded-xl bg-gray-3"
								/>
							)}
						</motion.div>
					))}
				</div>
				<div className="mt-4 space-y-3">
					{activeTab === "Videos" ? (
						<AnimatePresence initial={false}>
							{VideoTabSettings.map((setting, index) => (
								<motion.div
									initial={{ opacity: 0, y: 10 }}
									animate={{
										opacity: 1,
										y: 0,
										transition: { delay: index * 0.05 },
									}}
									exit={{ opacity: 0, y: -10, transition: { duration: 0.2 } }}
									key={index.toString() + setting.label}
									className="flex justify-between items-center p-3 rounded-xl border border-gray-4"
								>
									<p className="text-[13px] text-gray-12">{setting.label}</p>
									<Switch />
								</motion.div>
							))}
						</AnimatePresence>
					) : (
						<AnimatePresence initial={false}>
							{NotificationTabSettings.map((setting, index) => (
								<motion.div
									initial={{ opacity: 0, y: 10 }}
									animate={{
										opacity: 1,
										y: 0,
										transition: { delay: index * 0.05 },
									}}
									exit={{ opacity: 0, y: -10, transition: { duration: 0.2 } }}
									key={index.toString() + setting.label}
									className="flex justify-between items-center p-3 rounded-xl border border-gray-4"
								>
									<p className="text-[13px] text-gray-12">{setting.label}</p>
									<Switch />
								</motion.div>
							))}
						</AnimatePresence>
					)}
				</div>
			</div>
		</Card>
	);
};

export default CapSettingsCard;
