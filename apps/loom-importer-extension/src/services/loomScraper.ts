import { LoomExportData, Video, WorkspaceMember } from "../types/loom";
import { waitForElement } from "../utils/dom";
import JSConfetti from "js-confetti";

export type LoomPage = "members" | "workspace" | "spaces" | "other";

/**
 * Detects which Loom page we're currently on
 */
export const detectCurrentPage = (): LoomPage => {
  const url = window.location.href;

  if (url.includes("loom.com/settings/workspace#members")) {
    return "members";
  } else if (url.match(/loom\.com\/spaces\/[a-zA-Z0-9-]+/)) {
    return "workspace";
  } else if (url.match(/loom\.com\/spaces\/browse/)) {
    return "spaces";
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
 * Scrapes spaces form the Loom spaces page
 */
export const scrapeSpaces = async () => {
  const tableElement = await waitForElement(
    'div[role="table"][aria-label="Spaces"]'
  );
  if (!tableElement) {
    throw new Error("Table element not found");
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const spaceNames: string[] = [];

  const getAllRowGroups = tableElement.querySelectorAll('div[role="rowgroup"]');

  getAllRowGroups.forEach((rowGroup, index) => {
    //skip the first one, since thats table column names
    if (index === 0) return;
    const rows = rowGroup.querySelectorAll('div[role="row"]');
    rows.forEach((row) => {
      const cells = row.querySelectorAll('div[role="cell"]');
      const name = cells[0].textContent?.trim() || "";
      spaceNames.push(name);
    });
  });
  return spaceNames;
};

/**
 * Scrapes workspace members from the Loom members page
 */
export const scrapeWorkspaceMembers = async (): Promise<WorkspaceMember[]> => {
  const tableElement = await waitForElement(
    'div[role="table"][aria-label="Member Role Details"]'
  );
  if (!tableElement) {
    throw new Error("Table element not found");
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const members: WorkspaceMember[] = [];
  const tableRows = tableElement.querySelectorAll('div[role="row"]');

  if (!tableRows || tableRows.length === 0) {
    throw new Error("No table rows found");
  }

  tableRows.forEach((row, index) => {
    // Skip header row (first row)
    if (index === 0) return;

    if (!row || !row.querySelectorAll) return;

    const cells = row.querySelectorAll('div[role="cell"]');
    if (!cells || cells.length < 6) return;

    try {
      // Let's be more flexible with finding the name
      // Try to find name from various sources
      let nameElement = "";

      // First, try the avatar approach
      const avatarSelector = [
        'img[alt^="Avatar for "]',
        'span[aria-label^="Avatar for "]',
        'img[alt*="Avatar"]',
        'span[aria-label*="Avatar"]',
      ].join(", ");

      const avatarEl = cells[1]?.querySelector(avatarSelector);
      if (avatarEl) {
        nameElement =
          (
            avatarEl.getAttribute("alt") || avatarEl.getAttribute("aria-label")
          )?.replace("Avatar for ", "") || "";
      }

      // If avatar approach fails, try to find name in the cell text
      if (!nameElement) {
        // Look for name in cells[1] or cells[0] text content
        nameElement =
          cells[1]?.textContent?.trim() || cells[0]?.textContent?.trim() || "";
      }

      const roleElement = cells[2]?.textContent?.trim() || "";
      const dateElement = cells[3]?.textContent?.trim() || "";
      const emailElement =
        cells[4]?.querySelector("a")?.textContent?.trim() ||
        cells[4]?.textContent?.trim() ||
        "";
      const statusElement = cells[5]?.textContent?.trim() || "";

      console.log("Extracted data:", {
        name: nameElement,
        role: roleElement,
        date: dateElement,
        email: emailElement,
        status: statusElement,
      });

      if (
        nameElement &&
        roleElement &&
        dateElement &&
        emailElement &&
        statusElement
      ) {
        members.push({
          name: nameElement,
          email: emailElement,
          role: roleElement,
          dateJoined: dateElement,
          status: statusElement,
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
    'input[id^="bulk-action-"][aria-checked="true"]'
  );
  const videos: {
    id: string;
    ownerName: string;
    title: string;
  }[] = [];

  console.log(selectedVideos, "selected videos");

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
