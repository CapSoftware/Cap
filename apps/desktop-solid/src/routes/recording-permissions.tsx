import { Dialog as KDialog } from "@kobalte/core/dialog";

import MacPermissionsImage from "./mac-permissions.png";
import { Dialog, DialogContent } from "./editor/ui";

export default function () {
  return (
    <KDialog forceMount>
      <KDialog.Content class="text-sm divide-y rounded-[1.25rem] border overflow-hidden border-gray-200 font-[500] bg-gray-50">
        <Dialog.Header data-tauri-drag-region title="Recording Permissions" />

        <Dialog.Content class="space-y-[0.75rem]">
          <p class="text-gray-400">
            Open{" "}
            <span class="text-gray-500">
              Screen & System Audio Recording Settings
            </span>{" "}
            and enable Cap.
          </p>
          <img
            aria-hidden="true"
            src={MacPermissionsImage}
            class="border rounded-lg border-gray-200"
          />
          <p class="text-gray-400">
            After enabling Cap, restart the application for the changes to take
            effect.
          </p>
        </Dialog.Content>

        <Dialog.Footer>
          <Dialog.ConfirmButton>Settings</Dialog.ConfirmButton>
        </Dialog.Footer>
      </KDialog.Content>
    </KDialog>
  );
}
