import React, { createContext, useContext, ReactNode, useEffect } from "react";
import { LoomExportData } from "../types/loom";
import * as LoomScraper from "../services/loomScraper";
import { ImportStep, useImportStore } from "../store/importStore";

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
    const cleanup = store.setupMemberScraping();
    return cleanup;
  }, [store.currentPage, store.currentStep, store.data]);

  useEffect(() => {
    const cleanup = store.setupWorkspaceDetection();
    return cleanup;
  }, [store.currentPage, store.currentStep]);

  useEffect(() => {
    const cleanup = store.setupVideoSelection();
    return cleanup;
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
