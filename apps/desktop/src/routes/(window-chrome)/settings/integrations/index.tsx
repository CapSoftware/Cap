import { Button } from "@cap/ui-solid";
import { useNavigate } from "@solidjs/router";
import { For, createResource } from "solid-js";

import "@total-typescript/ts-reset/filter-boolean";
import { commands } from "~/utils/tauri";

export default function AppsTab() {
  const navigate = useNavigate();
  const [isUpgraded] = createResource(commands.checkUpgradedAndUpdate);

  const apps = [
    {
      name: "S3 Config",
      description:
        "Connect your own S3 bucket. All new shareable link uploads will be uploaded here. Maintain complete ownership over your data.",
      icon: IconLucideDatabase,
      url: "/settings/integrations/s3-config",
      pro: true,
    },
  ];

  const handleAppClick = async (app: (typeof apps)[number]) => {
    if (app.pro && !isUpgraded()) {
      await commands.showWindow("Upgrade");
      return;
    }
    navigate(app.url);
  };

  return (
    <div class="p-4">
      <For each={apps}>
        {(app) => (
          <div class="p-1.5 bg-white rounded-lg border border-[--gray-200]">
            <div class="flex justify-between items-center border-b border-[--gray-200] pb-2">
              <div class="flex items-center gap-3">
                <div class="p-2 rounded-lg bg-[--gray-100]">
                  <app.icon class="w-4 h-4 text-[--text-tertiary]" />
                </div>
                <div class="flex flex-col gap-1">
                  <span class="text-sm font-medium text-[--text-primary]">
                    {app.name}
                  </span>
                </div>
              </div>
              <Button
                variant={app.pro && !isUpgraded() ? "primary" : "secondary"}
                onClick={() => handleAppClick(app)}
              >
                {app.pro && !isUpgraded() ? "Upgrade to Pro" : "Configure"}
              </Button>
            </div>
            <div class="p-2">
              <p class="text-xs text-[--text-tertiary]">{app.description}</p>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
