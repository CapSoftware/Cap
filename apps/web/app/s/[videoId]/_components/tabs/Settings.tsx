"use client";

import { Switch } from "@cap/ui";
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
			label: "允许评论",
			description: "设置观众可以查看和执行的操作。",
			enabled: true,
		},
		{
			id: "allow_anonymous_comments",
			label: "允许匿名评论",
			enabled: false,
		},
		{
			id: "enable_transcript",
			label: "启用文字稿",
			enabled: true,
		},
		{
			id: "enable_download",
			label: "启用下载",
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
				<h3 className="text-sm font-medium">设置</h3>
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
