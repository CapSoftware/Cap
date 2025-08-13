import type React from "react";
import ImportChecklist from "./ImportChecklist";
import LoomLogo from "./LoomLogo";
import type { ChecklistItem } from "../types";
import { ImportStep } from "../context/ImportContext";
import { CapUrls } from "../utils/urls";

interface LoomImporterProps {
  importStarted: boolean;
  checklistItems: ChecklistItem[];
  selectedOrganizationId: string | null;
  currentStep: ImportStep;
  hasSelectedEmail: boolean;
  onStartImport: () => void;
  onSendToCap: () => void;
  onResetImport: () => void;
}

const LoomImporter: React.FC<LoomImporterProps> = ({
  importStarted,
  checklistItems,
  selectedOrganizationId,
  currentStep,
  hasSelectedEmail,
  onStartImport,
  onSendToCap,
  onResetImport,
}) => {
  if (currentStep === ImportStep.IMPORT_COMPLETE) {
    return (
      <div className="flex flex-col gap-4 items-center">
        <div className="flex flex-col gap-4 items-center">
          <span className="text-xs text-gray-500">
            <span className="text-4xl text-center">🎉</span>
          </span>
          <p className="text-[0.875rem] leading-[1.25rem] font-medium">
            Import Complete!
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            chrome.tabs.create({ url: CapUrls.DASHBOARD });
            onResetImport();
          }}
          className="px-4 py-2 w-full text-xs font-medium text-white bg-blue-500 rounded-full transition-colors duration-200 hover:bg-blue-600"
        >
          Go to Cap.so
        </button>
      </div>
    );
  }

  return (
      <div className="flex-grow">
        {currentStep === ImportStep.PROCESSING_COMPLETE ? (
          <div className="flex flex-col gap-4 items-center">
            <ImportChecklist items={checklistItems} />

            <button
              type="button" 
              onClick={onSendToCap}
              className="flex items-center justify-center gap-1 rounded-full border-[1px] bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 disabled:border-gray-300 disabled:cursor-not-allowed border-[#625DF5] px-4 py-2 relative w-full"
              disabled={!hasSelectedEmail}
            >
              Import
            </button>

            <div className="flex justify-center">
              <button
                type="button"
                onClick={onResetImport}
                className="text-xs text-gray-400 underline hover:text-red-500"
              >
                Reset Import Data
              </button>
            </div>
          </div>
        ) : importStarted ? (
          <div className="flex flex-col items-center">
            <ImportChecklist items={checklistItems} />
          </div>
        ) : (
          <div className="flex flex-col gap-4 items-center">
            {importStarted ? (
              <button
                type="button"
                onClick={onResetImport}
                className="text-xs text-gray-400 underline hover:text-red-500"
              >
                Reset Import Data
              </button>
            ) : (
              <button
                type="button"
                onClick={onStartImport}
                disabled={!selectedOrganizationId}
                className="flex items-center justify-center gap-1 rounded-full border-[1px] bg-[#625DF5] text-white hover:bg-[#524dcf] disabled:bg-gray-300 disabled:border-gray-300 disabled:cursor-not-allowed border-[#625DF5] px-4 py-2 relative w-full"
              >
                Import from Loom
                <LoomLogo className="text-white size-4" />
              </button>
            )}
          </div>
        )}
      </div>
  );
};

export default LoomImporter;
