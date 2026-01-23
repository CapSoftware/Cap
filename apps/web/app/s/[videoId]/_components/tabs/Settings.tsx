"use client";

import { Switch } from "@inflight/ui";
import { useState } from "react";

interface SettingOption {
	id: string;
	label: string;
	description?: string;
	enabled: boolean;
}

export const Settings = () => {
	const [settings, setSettings] = useState<SettingOption[]>([
		{
			id: "allow_comments",
			label: "Allow Comments",
			description: "Define what viewers can see and do.",
			enabled: true,
		},
		{
			id: "allow_anonymous_comments",
			label: "Allow Anonymous Comments",
			enabled: false,
		},
		{
			id: "enable_transcript",
			label: "Enable Transcript",
			enabled: true,
		},
		{
			id: "enable_download",
			label: "Enable Download",
			enabled: true,
		},
	]);

	const toggleSetting = (id: string) => {
		setSettings((prev) =>
			prev.map((setting) =>
				setting.id === id ? { ...setting, enabled: !setting.enabled } : setting,
			),
		);
	};

	return (
		<div className="flex flex-col h-full">
			<div className="p-4 border-b border-gray-200">
				<h3 className="text-sm font-medium">Settings</h3>
			</div>
			<div className="overflow-y-auto flex-1">
				<div className="p-4 space-y-6">
					{settings.map((setting) => (
						<div key={setting.id} className="flex justify-between items-center">
							<div className="flex-1">
								<div className="flex justify-between items-center">
									<div>
										<h4 className="text-sm font-medium text-gray-900">
											{setting.label}
										</h4>
										{setting.description && (
											<p className="text-sm text-gray-12">
												{setting.description}
											</p>
										)}
									</div>
									<Switch
										checked={setting.enabled}
										onCheckedChange={() => toggleSetting(setting.id)}
									/>
								</div>
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
};
