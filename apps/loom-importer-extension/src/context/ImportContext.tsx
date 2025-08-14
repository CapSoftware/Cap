import React, { createContext, useContext, ReactNode, useEffect } from "react";
import type { LoomExportData } from "../types/loom";
import type * as LoomScraper from "../services/loomScraper";
import { ImportStep } from "../store/importStore";
import { useImportStore } from "../store/importStore";

export { ImportStep };
export interface ImportState {
  currentStep: ImportStep;
  error: string | null;
  data: LoomExportData;
  currentPage: LoomScraper.LoomPage;
}

interface ImportContextType {
  importState: ImportState;
  startImport: (
    workspaceId: string | null
  ) => Promise<{ success: boolean; message?: string }>;
  processVideos: () => Promise<void>;
  sendDataToCap: () => Promise<{ success: boolean; message?: string }>;
  resetImport: () => void;
}

const ImportContext = createContext<ImportContextType | undefined>(undefined);

export const ImportProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const store = useImportStore();

  useEffect(() => {
    store.initializePageDetection();
  }, []);

  useEffect(() => {
    store.loadExistingData();
  }, [store.currentPage]);

  useEffect(() => {
    const cleanup = store.setupSpaceScraping();
    return cleanup;
  }, [store.currentPage, store.currentStep]);

  useEffect(() => {
    const cleanup = store.setupMemberScraping();
    return cleanup;
  }, [store.currentPage, store.currentStep]);

  useEffect(() => {
    const cleanup = store.setupWorkspaceDetection();
    return cleanup;
  }, [store.currentPage, store.currentStep]);

  useEffect(() => {
    // Only setup video selection when we're on workspace page
    // Don't recreate when toggling between SELECTING_VIDEOS and VIDEOS_SELECTED
    if (store.currentPage === "workspace" && 
        (store.currentStep === ImportStep.SELECTING_VIDEOS || 
         store.currentStep === ImportStep.VIDEOS_SELECTED)) {
      const cleanup = store.setupVideoSelection();
      return cleanup;
    }
  }, [store.currentPage, store.currentStep]);

  const importContextValue: ImportContextType = {
    importState: {
      currentStep: store.currentStep,
      error: store.error,
      data: store.data,
      currentPage: store.currentPage,
    },
    startImport: store.startImport,
    processVideos: store.processVideos,
    sendDataToCap: store.sendDataToCap,
    resetImport: store.resetImport,
  };

  return (
    <ImportContext.Provider value={importContextValue}>
      {children}
    </ImportContext.Provider>
  );
};

export const useImport = (): ImportContextType => {
  const context = useContext(ImportContext);
  if (context === undefined) {
    throw new Error("useImport must be used within an ImportProvider");
  }
  return context;
};
