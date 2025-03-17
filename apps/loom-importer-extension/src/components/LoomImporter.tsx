import React from "react";
import ImportChecklist from "./ImportChecklist";
import LoomLogo from "./LoomLogo";
import { ChecklistItem } from "../types";
import { ImportState, ImportStep, useImport } from "../context/ImportContext";
import EmailSelector from "./EmailSelector";
import { useImportStore } from "../store/importStore";
import { CapUrls } from "../utils/urls";

interface LoomImporterProps {
  importStarted: boolean;
  checklistItems: ChecklistItem[];
  selectedWorkspaceId: string | null;
  currentStep: ImportStep;
  hasSelectedEmail: boolean;
  onStartImport: () => void;
  onSendToCap: () => void;
  onResetImport: () => void;
}

const LoomImporter: React.FC<LoomImporterProps> = ({
  importStarted,
  checklistItems,
  selectedWorkspaceId,
  currentStep,
  hasSelectedEmail,
  onStartImport,
  onSendToCap,
  onResetImport,
}) => {
  if (currentStep === ImportStep.IMPORT_COMPLETE) {
    return (
      <div className="flex flex-col items-center gap-4">
        <div className="flex flex-col items-center gap-4">
          <span className="text-xs text-gray-500">
            <span className="text-4xl text-center">🎉</span>
          </span>
          <p className="text-[0.875rem] leading-[1.25rem] font-medium">
            Import Complete!
          </p>
        </div>
        <button
          onClick={() => {
            chrome.tabs.create({ url: CapUrls.DASHBOARD });
            onResetImport();
          }}
          className="bg-blue-500 text-white px-4 py-2 rounded-full text-xs font-medium transition-colors duration-200 hover:bg-blue-600 w-full"
        >
          Go to Cap.so
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex-grow">
        {currentStep === ImportStep.PROCESSING_COMPLETE ? (
          <div className="flex flex-col items-center gap-4">
            <ImportChecklist items={checklistItems} />

            <button
              onClick={onSendToCap}
              className="flex items-center justify-center gap-1 rounded-full border-[1px] bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 disabled:border-gray-300 disabled:cursor-not-allowed border-[#625DF5] px-4 py-2 relative w-full"
              disabled={!hasSelectedEmail}
            >
              Import
            </button>

            <div className="flex justify-center">
              <button
                onClick={onResetImport}
                className="text-xs text-gray-400 hover:text-red-500 underline"
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
          <div className="flex flex-col items-center gap-4">
            {importStarted ? (
              <button
                onClick={onResetImport}
                className="text-xs text-gray-400 hover:text-red-500 underline"
              >
                Reset Import Data
              </button>
            ) : (
              <button
                onClick={onStartImport}
                disabled={!selectedWorkspaceId}
                className="flex items-center justify-center gap-1 rounded-full border-[1px] bg-[#625DF5] text-white hover:bg-[#524dcf] disabled:bg-gray-300 disabled:border-gray-300 disabled:cursor-not-allowed border-[#625DF5] px-4 py-2 relative w-full"
              >
                Import from Loom
                <LoomLogo className="size-4 text-white" />
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default LoomImporter;
