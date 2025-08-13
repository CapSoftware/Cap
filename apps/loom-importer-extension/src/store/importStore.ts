import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { LoomExportData } from "../types/loom";
import * as LoomScraper from "../services/loomScraper";
import { CapApi } from "../api/cap";

export enum ImportStep {
  IDLE = "idle",
  COLLECTING_MEMBERS = "collecting_members",
  COLLECTING_SPACES = "collecting_spaces",
  MEMBERS_COLLECTED = "members_collected",
  SPACES_COLLECTED = "spaces_collected",
  SELECT_WORKSPACE = "select_workspace",
  SELECTING_VIDEOS = "selecting_videos",
  VIDEOS_SELECTED = "videos_selected",
  PROCESSING_VIDEOS = "processing_videos",
  PROCESSING_COMPLETE = "processing_complete",
  IMPORT_COMPLETE = "import_complete",
}

export interface ImportState {
  currentStep: ImportStep;
  error: string | null;
  data: LoomExportData;
  currentPage: LoomScraper.LoomPage;
}

interface ImportActions {
  setCurrentStep: (step: ImportStep) => void;
  setError: (error: string | null) => void;
  setData: (data: Partial<LoomExportData>) => void;
  setCurrentPage: (page: LoomScraper.LoomPage) => void;
  setSelectedUserEmail: (email: string) => void;

  setSelectedOrganizationId: (id: string) => void;
  startImport: (
    organizationId: string | null
  ) => Promise<{ success: boolean; message?: string }>;
  processVideos: () => Promise<void>;
  sendDataToCap: () => Promise<{ success: boolean; message?: string }>;
  resetImport: () => void;

  initializePageDetection: () => void;
  loadExistingData: () => void;
  setupMemberScraping: () => void;
  setupWorkspaceDetection: () => void;
  setupVideoSelection: () => void;
}

type ImportStore = ImportState & ImportActions;

export const useImportStore = create<ImportStore>()(
  persist(
    (set, get) => ({
      currentStep: ImportStep.IDLE,
      error: null,
      data: {
        workspaceMembers: [],
        videos: [],
        spaces: [],
        selectedOrganizationId: "",
        userEmail: null,
      },
      currentPage: "other",

      setCurrentStep: (step) => set({ currentStep: step }),
      setError: (error) => set({ error }),
      setData: (data) =>
        set((state) => ({
          data: { ...state.data, ...data },
        })),
      setCurrentPage: (page) => set({ currentPage: page }),
      setSelectedUserEmail: (email) => {
        set({ data: { ...get().data, userEmail: email } });
        set({ currentStep: ImportStep.PROCESSING_COMPLETE });
      },
      setSelectedOrganizationId: (id) =>
        set({ data: { ...get().data, selectedOrganizationId: id } }),

      initializePageDetection: () => {
        const page = LoomScraper.detectCurrentPage();
        set({ currentPage: page });
      },

      loadExistingData: async () => {
        const { currentPage } = get();
        if (currentPage === "workspace" || currentPage === "members") {
          const data = await LoomScraper.loadExistingData();
          if (data) {
            const newStep =
              data.videos && data.videos.length > 0
                ? ImportStep.PROCESSING_COMPLETE
                : data.workspaceMembers && data.workspaceMembers.length > 0
                ? ImportStep.SELECT_WORKSPACE
                : ImportStep.MEMBERS_COLLECTED;

            set({ data, currentStep: newStep });
          }
        }
      },

      setupSpaceScraping: () => {
        const { currentPage, currentStep } = get();
        if (
          currentPage === "spaces" &&
          currentStep === ImportStep.COLLECTING_SPACES
        ) {
        }
      },
      setupMemberScraping: () => {
        const { currentPage, currentStep, data } = get();

        if (
          currentPage === "members" &&
          currentStep === ImportStep.COLLECTING_MEMBERS
        ) {
          const timer = setTimeout(async () => {
            try {
              const members = await LoomScraper.scrapeWorkspaceMembers();
              const updatedData = await LoomScraper.saveMembersToStorage(
                data,
                members
              );

              set({
                currentStep: ImportStep.MEMBERS_COLLECTED,
                data: updatedData,
                error: null,
              });
            } catch (error) {
              console.error("Failed to scrape members:", error);

              set({
                error: `Failed to get workspace members: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              });
            }
          }, 3000);

          return () => clearTimeout(timer);
        }
        return () => {};
      },

      setupWorkspaceDetection: () => {
        const { currentPage, currentStep } = get();

        if (
          currentPage === "workspace" &&
          currentStep === ImportStep.SELECT_WORKSPACE
        ) {
          const checkWorkspaceUrl = () => {
            const url = window.location.href;
            const workspacePattern = /https:\/\/www\.loom\.com\/spaces\/[\w-]+/;

            if (workspacePattern.test(url)) {
              set({
                currentStep: ImportStep.SELECTING_VIDEOS,
              });
            }
          };

          checkWorkspaceUrl();

          const intervalId = setInterval(checkWorkspaceUrl, 1000);

          return () => clearInterval(intervalId);
        }

        return () => {};
      },

      setupVideoSelection: () => {
        const { currentPage, currentStep } = get();

        if (
          currentPage === "workspace" &&
          currentStep === ImportStep.SELECTING_VIDEOS
        ) {
          let cleanup: (() => void) | undefined;

          const timer = setTimeout(async () => {
            try {
              const cleanupFn = await LoomScraper.setupVideoSelection(
                (hasSelectedVideos) => {
                  set({
                    currentStep: hasSelectedVideos
                      ? ImportStep.VIDEOS_SELECTED
                      : ImportStep.MEMBERS_COLLECTED,
                  });
                }
              );

              cleanup = cleanupFn;
            } catch (error) {
              console.error("Failed to setup video selection:", error);

              set({
                error: `Failed to setup video selection: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              });
            }
          }, 3000);

          return () => {
            clearTimeout(timer);
            if (cleanup) cleanup();
          };
        }

        return () => {};
      },

      startImport: async (workspaceId: string | null) => {
        if (!workspaceId) {
          return { success: false, message: "Please select a workspace first" };
        }

        try {
          set({
            currentStep: ImportStep.COLLECTING_MEMBERS,
            error: null,
          });

          chrome.storage.local.remove(["loomImportData"], () => {
            chrome.tabs.create({
              url: "https://www.loom.com/settings/workspace#members",
            });
          });

          return { success: true };
        } catch (error) {
          console.error("Import failed:", error);

          set({
            error: `Import failed: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          });

          return {
            success: false,
            message: `Import failed: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          };
        }
      },

      processVideos: async () => {
        try {
          set({
            currentStep: ImportStep.PROCESSING_COMPLETE,
            error: null,
          });

          const { data } = get();
          const updatedData = await LoomScraper.completeVideoImport(data);

          set({
            data: updatedData,
            error: null,
          });
        } catch (error) {
          console.error("Failed to process videos:", error);

          set({
            error: `Failed to process videos: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          });
        }
      },

      sendDataToCap: async () => {
        const { data } = get();

        if (!data || !data.videos || data.videos.length === 0) {
          set({
            error: "No import data available",
          });

          return { success: false, message: "No import data available" };
        }

        if (!data.userEmail) {
          set({
            error: "You must select your email address before importing",
          });

          return {
            success: false,
            message: "You must select your email address before importing",
          };
        }

        try {
          const api = new CapApi();
          const response = await api.sendLoomData({
            ...data,
            userEmail: data.userEmail,
            selectedOrganizationId: data.selectedOrganizationId,
          });

          if (response?.success) {
            chrome.storage.local.remove(["loomImportData"]);
            set({ currentStep: ImportStep.IMPORT_COMPLETE });
            return { success: true };
          } else {
            throw new Error(
              response?.message || "Failed to send data to Cap.so"
            );
          }
        } catch (error) {
          console.error("Error sending data to Cap.so:", error);

          set({
            error: `Error sending data to Cap.so: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          });

          return {
            success: false,
            message: `Error sending data to Cap.so: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          };
        }
      },

      resetImport: () => {
        chrome.storage.local.clear(() => {
          console.log("Storage cleared");

          set({
            currentStep: ImportStep.IDLE,
            error: null,
            data: {
              workspaceMembers: [],
              videos: [],
              spaces: [],
              selectedOrganizationId: "",
              userEmail: "",
            },
            currentPage: LoomScraper.detectCurrentPage(),
          });
        });
      },
    }),
    {
      name: "loom-import-storage",
      storage: createJSONStorage(() => ({
        getItem: async (name) => {
          return new Promise((resolve) => {
            chrome.storage.local.get([name], (result) => {
              resolve(result[name] || null);
            });
          });
        },
        setItem: async (name, value) => {
          return new Promise<void>((resolve) => {
            chrome.storage.local.set({ [name]: value }, () => {
              resolve();
            });
          });
        },
        removeItem: async (name) => {
          return new Promise<void>((resolve) => {
            chrome.storage.local.remove([name], () => {
              resolve();
            });
          });
        },
      })),
    }
  )
);
