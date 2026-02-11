"use client";

import { Logo, Switch } from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeftIcon } from "lucide-react";

interface SettingsPanelProps {
	open: boolean;
	rememberDevices: boolean;
	onClose: () => void;
	onRememberDevicesChange: (value: boolean) => void;
	onOpenDashboard?: () => void;
	onSignOut?: () => void;
}

export const SettingsPanel = ({
	open,
	rememberDevices,
	onClose,
	onRememberDevicesChange,
	onOpenDashboard,
	onSignOut,
}: SettingsPanelProps) => {
	return (
		<AnimatePresence mode="wait">
			{open && (
				<motion.div
					key="web-recorder-settings"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.2, ease: "easeOut" }}
					className="fixed inset-0 z-[90]"
				>
					<div className="absolute inset-0 bg-white/95 backdrop-blur-sm" />
					<div className="relative z-10 flex h-full flex-col gap-4 p-4">
						<div className="flex items-center justify-between">
							<button
								type="button"
								onClick={onClose}
								className="flex items-center gap-1 text-sm font-medium text-gray-500 transition-colors hover:text-gray-900"
							>
								<ArrowLeftIcon className="size-4" />
								Back
							</button>
							<Logo className="h-7 w-auto" />
							<span className="h-8 w-8" aria-hidden />
						</div>
						<div className="flex flex-col gap-3">
							<div className="flex gap-4 justify-between items-start p-4 text-left rounded-2xl border border-gray-200 bg-gray-50">
								<div className="flex flex-col gap-1 text-left">
									<p className="text-sm font-medium text-gray-900">
										Automatically select your last webcam/microphone
									</p>
									<p className="text-xs text-gray-500">
										If available, the last used camera and mic will be
										automatically selected.
									</p>
								</div>
								<Switch
									checked={rememberDevices}
									onCheckedChange={onRememberDevicesChange}
									aria-label="Remember selected devices"
								/>
							</div>
							{(onOpenDashboard || onSignOut) && (
								<div className="flex flex-col gap-2">
									<div className="text-xs font-medium text-gray-400 px-1">
										Account
									</div>
									<div className="flex flex-col gap-2">
										{onOpenDashboard && (
											<button
												type="button"
												onClick={onOpenDashboard}
												className="flex w-full items-center justify-between rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-100"
											>
												<span>Dashboard</span>
												<span className="text-xs text-gray-400">Open</span>
											</button>
										)}
										{onSignOut && (
											<button
												type="button"
												onClick={onSignOut}
												className="flex w-full items-center justify-between rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-100"
											>
												<span>Sign out</span>
											</button>
										)}
									</div>
								</div>
							)}
						</div>
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
};
