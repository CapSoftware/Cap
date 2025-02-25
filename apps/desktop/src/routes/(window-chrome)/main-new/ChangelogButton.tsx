import { makePersisted } from "@solid-primitives/storage";
import { getVersion } from "@tauri-apps/api/app";
import { createEffect, createResource } from "solid-js";
import { createStore } from "solid-js/store";
import { commands } from "~/utils/tauri";
import { apiClient } from "~/utils/web-api";

function ChangelogButton() {
  const [changelogState, setChangelogState] = makePersisted(
    createStore({
      hasUpdate: false,
      lastOpenedVersion: "",
      changelogClicked: false,
    }),
    { name: "changelogState" }
  );

  const [currentVersion] = createResource(() => getVersion());

  const [changelogStatus] = createResource(
    () => currentVersion(),
    async (version) => {
      if (!version) {
        return { hasUpdate: false };
      }
      const response = await apiClient.desktop.getChangelogStatus({
        query: { version },
      });
      if (response.status === 200) return response.body;
      return null;
    }
  );

  const handleChangelogClick = () => {
    commands.showWindow({ Settings: { page: "changelog" } });
    const version = currentVersion();
    if (version) {
      setChangelogState({
        hasUpdate: false,
        lastOpenedVersion: version,
        changelogClicked: true,
      });
    }
  };

  createEffect(() => {
    if (changelogStatus.state === "ready" && currentVersion()) {
      const hasUpdate = changelogStatus()?.hasUpdate || false;
      if (
        hasUpdate === true &&
        changelogState.lastOpenedVersion !== currentVersion()
      ) {
        setChangelogState({
          hasUpdate: true,
          lastOpenedVersion: currentVersion(),
          changelogClicked: false,
        });
      }
    }
  });

  return (
    <button type="button" onClick={handleChangelogClick} class="relative">
      <IconLucideBell class="size-[1.10rem] text-gray-400 hover:text-gray-500" />
      {changelogState.hasUpdate && (
        <div
          style={{ "background-color": "#FF4747" }}
          class="block z-10 absolute top-0 right-0 size-1.5 rounded-full animate-bounce"
        />
      )}
    </button>
  );
}

export default ChangelogButton;
