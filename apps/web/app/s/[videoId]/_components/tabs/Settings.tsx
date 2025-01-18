"use client";

import { useState } from "react";
import { Switch } from "@cap/ui";

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
        setting.id === id ? { ...setting, enabled: !setting.enabled } : setting
      )
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-200">
        <h3 className="text-sm font-medium">Settings</h3>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-6 p-4">
          {settings.map((setting) => (
            <div key={setting.id} className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-medium text-gray-900">
                      {setting.label}
                    </h4>
                    {setting.description && (
                      <p className="text-sm text-gray-500">
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
