import { ImportStep } from "../context/ImportContext";
import { ChecklistItem } from "../components/ImportChecklist";

/**
 * Generates the checklist items based on the current import step
 * @param currentStep The current import step
 * @returns Array of checklist items to display
 */
export const getChecklistItemsForStep = (
  currentStep: ImportStep
): ChecklistItem[] => {
  const items: ChecklistItem[] = [];

  switch (currentStep) {
    case ImportStep.IDLE:
      items.push({
        message: "Ready to start importing",
        status: "waiting",
      });
      break;
    case ImportStep.COLLECTING_MEMBERS:
      items.push({
        message: "Collecting workspace members...",
        status: "in-progress",
      });
      break;
    case ImportStep.SELECT_WORKSPACE:
      items.push({
        message: "Select a workspace to import from",
        status: "waiting",
      });
      break;
    case ImportStep.MEMBERS_COLLECTED:
      items.push(
        { message: "Spaces collected", status: "complete" },
        { message: "Workspace members collected", status: "complete" },
        { message: "Select a workspace to import from", status: "waiting" }
      );
      break;
    case ImportStep.SELECTING_VIDEOS:
      items.push(
        { message: "Spaces collected", status: "complete" },
        { message: "Workspace members collected", status: "complete" },
        { message: "Select videos to import", status: "in-progress" }
      );
      break;
    case ImportStep.VIDEOS_SELECTED:
      items.push(
        { message: "Spaces collected", status: "complete" },
        { message: "Workspace members collected", status: "complete" },
        { message: "Videos selected", status: "complete" },
        { message: "Ready to process videos", status: "waiting" }
      );
      break;
    case ImportStep.PROCESSING_VIDEOS:
      items.push(
        { message: "Spaces collected", status: "complete" },
        { message: "Workspace members collected", status: "complete" },
        { message: "Videos selected", status: "complete" },
        { message: "Processing videos...", status: "in-progress" }
      );
      break;
    case ImportStep.PROCESSING_COMPLETE:
      items.push(
        { message: "Spaces collected", status: "complete" },
        { message: "Workspace members collected", status: "complete" },
        { message: "Videos selected", status: "complete" },
        { message: "Processing complete!", status: "complete" }
      );
      break;
    case ImportStep.IMPORT_COMPLETE:
      items.push(
        { message: "Spaces collected", status: "complete" },
        { message: "Workspace members collected", status: "complete" },
        { message: "Videos selected", status: "complete" },
        { message: "Processing complete!", status: "complete" },
        { message: "Import complete!", status: "complete" }
      );
      break;
  }

  return items;
};
