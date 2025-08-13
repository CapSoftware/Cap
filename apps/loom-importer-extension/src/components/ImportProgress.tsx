import React from "react";
import ImportChecklist from "./ImportChecklist";
import { ImportStep } from "../context/ImportContext";
import { getChecklistItemsForStep } from "../utils/importUtils";

interface ImportProgressProps {
  importState: {
    currentStep: ImportStep;
    error: string | null;
  };
  processVideos: () => Promise<void>;
}

const ImportProgress: React.FC<ImportProgressProps> = ({
  importState,
  processVideos,
}) => {
  const isProcessingDisabled =
    importState.currentStep !== ImportStep.VIDEOS_SELECTED;

  if (
    importState.currentStep === ImportStep.IMPORT_COMPLETE &&
    window.location.href.includes("loom.com")
  ) {
    return <></>;
  }

  return (
    <div className="bg-white rounded-xl border-[1px] border-gray-200 p-5 min-w-[320px] shadow-[0px_8px_16px_rgba(18,22,31,0.04)]">
      <ImportChecklist
        items={getChecklistItemsForStep(importState.currentStep)}
      />

      {importState.currentStep !== ImportStep.IDLE && (
        <button
          type="button"
          onClick={processVideos}
          disabled={isProcessingDisabled}
          className="px-4 py-2 mt-4 w-full font-medium text-white bg-blue-500 rounded-lg transition-colors duration-200 disabled:bg-gray-200 disabled:text-gray-400 hover:bg-blue-600"
        >
          {importState.currentStep === ImportStep.PROCESSING_VIDEOS
            ? "Processing..."
            : "Complete"}
        </button>
      )}

      {importState.currentStep === ImportStep.PROCESSING_COMPLETE && (
        <div className="p-4 mt-3 bg-green-50 rounded-lg border border-green-100">
          <p className="text-[0.875rem] leading-[1.25rem] font-medium text-green-600 mb-1">
            Success 🎉
          </p>
          <p className="text-[0.875rem] leading-[1.25rem] text-green-500">
            Open the Extension UI to finish
          </p>
        </div>
      )}

      {importState.error && (
        <div className="p-4 mt-3 bg-red-50 rounded-lg border border-red-100">
          <p className="text-[0.875rem] leading-[1.25rem] font-medium text-red-600 mb-1">
            Error
          </p>
          <p className="text-[0.875rem] leading-[1.25rem] text-red-500">
            {importState.error}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 px-3 py-1.5 bg-red-100 hover:bg-red-200 rounded-md text-red-600 text-xs font-medium transition-colors duration-200"
          >
            Reload page
          </button>
        </div>
      )}
    </div>
  );
};

export default ImportProgress;
