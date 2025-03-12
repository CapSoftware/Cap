import { LoomExportData, Video, WorkspaceMember } from "../types/loom";
import { waitForElement } from "../utils/dom";
import JSConfetti from "js-confetti";

export type LoomPage = "members" | "workspace" | "other";

/**
 * Detects which Loom page we're currently on
 */
export const detectCurrentPage = (): LoomPage => {
  const url = window.location.href;

  if (url.includes("loom.com/settings/workspace#members")) {
    return "members";
  } else if (url.match(/loom\.com\/spaces\/[a-zA-Z0-9-]+/)) {
    return "workspace";
  } else {
    return "other";
  }
};

/**
 * Loads existing import data from storage if available
 */
export const loadExistingData = (): Promise<LoomExportData | null> => {
  return new Promise((resolve) => {
    chrome.storage.local.get(["loomImportData"], (result) => {
      if (result.loomImportData?.workspaceMembers?.length > 0) {
        resolve(result.loomImportData);
      } else {
        resolve(null);
      }
    });
  });
};

/**
 * Scrapes workspace members from the Loom members page
 */
export const scrapeWorkspaceMembers = async (): Promise<WorkspaceMember[]> => {
  const tableElement = await waitForElement('div[role="table"]');
  if (!tableElement) {
    throw new Error("Table element not found");
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const members: WorkspaceMember[] = [];
  const tableRows = document.querySelectorAll(
    'div[role="table"] div[role="row"]'
  );

  if (!tableRows || tableRows.length === 0) {
    throw new Error("No table rows found");
  }

  tableRows.forEach((row) => {
    if (!row || !row.querySelectorAll) return;

    const cells = row.querySelectorAll('div[role="cell"]');
    if (!cells || cells.length < 6) return;

    try {
      const avatarSelector = [
        'img[alt^="Avatar for "]',
        'span span[aria-label^="Avatar for "]',
      ].join(", ");

      const avatarElement = cells[1]?.querySelector(avatarSelector);
      const nameElement = avatarElement
        ? (
            avatarElement.getAttribute("alt") ||
            avatarElement.getAttribute("aria-label")
          )?.replace("Avatar for ", "") || ""
        : "";

      const roleElement = cells[2]?.querySelector("div");
      const dateElement = cells[3]?.querySelector("div");
      const emailElement = cells[4]?.querySelector("a");
      const statusElement = cells[5]?.querySelector("div");

      if (
        nameElement &&
        roleElement &&
        dateElement &&
        emailElement &&
        statusElement
      ) {
        members.push({
          name: nameElement?.trim() || "",
          email: emailElement.textContent?.trim() || "",
          role: roleElement.textContent?.trim() || "",
          dateJoined: dateElement.textContent?.trim() || "",
          status: statusElement.textContent?.trim() || "",
        });
      }
    } catch (error) {
      console.error("Error processing row:", error);
    }
  });

  if (members.length === 0) {
    throw new Error("No members found in table");
  }

  return members;
};

/**
 * Saves workspace members to storage and returns updated data
 */
export const saveMembersToStorage = async (
  currentData: LoomExportData,
  members: WorkspaceMember[]
): Promise<LoomExportData> => {
  const updatedData = { ...currentData, workspaceMembers: members };

  return new Promise((resolve) => {
    chrome.storage.local.set({ loomImportData: updatedData }, () => {
      resolve(updatedData);
    });
  });
};

/**
 * Sets up video selection checkboxes and returns a cleanup function
 */
export const setupVideoSelection = async (
  onSelectionChange: (hasSelectedVideos: boolean) => void
): Promise<() => void> => {
  const videoElement = await waitForElement("article[data-videoid]");
  if (!videoElement) {
    throw new Error("No videos found on page");
  }

  const articles = document.querySelectorAll<HTMLElement>(
    "article[data-videoid]"
  );

  const listeners: { element: HTMLElement; listener: EventListener }[] = [];

  articles.forEach((article) => {
    const videoId = article.getAttribute("data-videoid");
    if (!videoId) return;

    const checkbox = document.querySelector<HTMLInputElement>(
      `#bulk-action-${videoId}`
    );
    if (!checkbox) return;

    const listener = () => {
      const anyVideoSelected = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[id^="bulk-action-"]')
      ).some((cb) => cb.checked);

      onSelectionChange(anyVideoSelected);
    };

    checkbox.addEventListener("change", listener);
    listeners.push({ element: checkbox, listener });
  });

  return () => {
    listeners.forEach(({ element, listener }) => {
      element.removeEventListener("change", listener);
    });
  };
};

/**
 * Gets all selected videos from the page
 */
export const getSelectedVideos = (): {
  id: string;
  ownerName: string;
  title: string;
}[] => {
  const selectedVideos = document.querySelectorAll<HTMLInputElement>(
    'input[id^="bulk-action-"]:checked'
  );
  const videos: {
    id: string;
    ownerName: string;
    title: string;
  }[] = [];

  selectedVideos.forEach((checkbox) => {
    const videoId = checkbox.id.replace("bulk-action-", "");
    if (!videoId) return;

    const article = document.querySelector<HTMLElement>(
      `article[data-videoid="${videoId}"]`
    );
    if (!article) return;

    const ownerName =
      article
        .querySelector('a[class^="profile-card_textLink_"] span')
        ?.textContent?.trim() || "";

    const labelText =
      article.querySelector("a")?.getAttribute("aria-label") || "";

    const title =
      labelText.replace("Deselect video: ", "") || "Imported from Loom";

    videos.push({ id: videoId, ownerName, title });
  });

  return videos;
};

/**
 * Process the selected videos and match them with workspace members
 */
export const processVideos = (
  rawVideos: { id: string; ownerName: string; title: string }[],
  workspaceMembers: WorkspaceMember[]
): Video[] => {
  return rawVideos.map((video) => {
    const owner = workspaceMembers.find((member) =>
      member.name.includes(video.ownerName)
    ) || { name: video.ownerName, email: "" };

    return {
      id: video.id,
      owner: {
        name: owner.name,
        email: owner.email,
      },
      title: video.title,
    };
  });
};

/**
 * Save processed videos to storage and send completion message
 */
export const saveProcessedVideos = async (
  currentData: LoomExportData,
  videos: Video[]
): Promise<LoomExportData> => {
  const updatedData = { ...currentData, videos };

  return new Promise((resolve) => {
    chrome.storage.local.set({ loomImportData: updatedData }, () => {
      chrome.runtime.sendMessage({
        type: "CAP_LOOM_IMPORT_COMPLETE",
        data: updatedData,
      });

      const jsConfetti = new JSConfetti();
      jsConfetti.addConfetti();

      resolve(updatedData);
    });
  });
};

/**
 * Complete the video import process
 */
export const completeVideoImport = async (
  currentData: LoomExportData
): Promise<LoomExportData> => {
  try {
    const rawVideos = getSelectedVideos();

    const processedVideos = processVideos(
      rawVideos,
      currentData.workspaceMembers
    );

    return await saveProcessedVideos(currentData, processedVideos);
  } catch (error) {
    console.error("Failed to process videos:", error);
    throw error;
  }
};
