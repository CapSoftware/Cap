"use client";

import { Switch } from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeftIcon } from "lucide-react";

interface SettingsPanelProps {
	open: boolean;
	rememberDevices: boolean;
	onClose: () => void;
	onRememberDevicesChange: (value: boolean) => void;
}

export const SettingsPanel = ({
	open,
	rememberDevices,
	onClose,
	onRememberDevicesChange,
}: SettingsPanelProps) => {
	return (
		<AnimatePresence mode="wait">
			{open && (
				<motion.div
					key="web-recorder-settings"
					initial={{ opacity: 0, y: -12 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: -12 }}
					transition={{ duration: 0.2, ease: "easeOut" }}
					className="absolute inset-0 z-40 flex flex-col gap-4 p-4 border border-gray-3 rounded-lg bg-gray-1 shadow-lg dark:bg-gray-2"
				>
					<div className="flex items-center justify-between">
						<button
							type="button"
							onClick={onClose}
							className="flex items-center gap-1 text-sm font-medium text-gray-11 transition-colors hover:text-gray-12"
						>
							<ArrowLeftIcon className="size-4" />
							Back
						</button>
						<h2 className="text-sm font-semibold text-gray-12">
							Recorder settings
						</h2>
						<span className="w-9 h-9" aria-hidden />
					</div>
					<div className="flex flex-col gap-3">
						<div className="flex gap-4 justify-between items-start p-4 text-left rounded-xl border border-gray-3 bg-gray-1 dark:bg-gray-3">
							<div className="flex flex-col gap-1 text-left">
								<p className="text-sm font-medium text-gray-12">
									Automatically select your last webcam/microphone
								</p>
								<p className="text-xs text-gray-10">
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
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
};
