import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { LoomExportData } from "../types/loom";
import * as LoomScraper from "../services/loomScraper";
import { CapApi } from "../api/cap";
import { createTab } from "../utils/urls";

export enum ImportStep {
  IDLE = "idle",
  COLLECTING_MEMBERS = "collecting_members",
  MEMBERS_COLLECTED = "members_collected",
  COLLECTING_SPACES = "collecting_spaces",
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
  setupSpaceScraping: () => void;
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
        console.log("🔍 Page detection:", {
          url: window.location.href,
          detectedPage: page,
        });
        set({ currentPage: page });
      },

      loadExistingData: async () => {
        const { currentPage } = get();
        if (currentPage === "workspace" || currentPage === "members") {
          const data = await LoomScraper.loadExistingData();
          console.log("📦 Loaded existing data:", data);

          if (data) {
            console.log("data.videos", data.videos);
            const newStep =
              data.videos && data.videos.length > 0
                ? ImportStep.PROCESSING_COMPLETE
                : data.workspaceMembers && data.workspaceMembers.length > 0
                ? ImportStep.SELECTING_VIDEOS
                : ImportStep.MEMBERS_COLLECTED;

            console.log("🔄 Setting step to:", newStep);
            set({ data, currentStep: newStep });
          }
        }
      },

      setupSpaceScraping: () => {
        const { currentPage, currentStep, data } = get();

        if (
          currentPage === "spaces" &&
          currentStep === ImportStep.COLLECTING_SPACES
        ) {
          console.log("✅ Starting spaces scraping...");
          const timer = setTimeout(async () => {
            try {
              const spaces = await LoomScraper.scrapeSpaces();
              console.log("✅ Successfully scraped spaces:", spaces);
              const updatedData = await LoomScraper.saveSpacesToStorage(
                data,
                spaces
              );
              set({
                currentStep: ImportStep.SPACES_COLLECTED,
                data: updatedData,
                error: null,
              });

              // After spaces are collected, navigate to members page
              setTimeout(() => {
                createTab("https://www.loom.com/settings/workspace#members");
                set({
                  currentStep: ImportStep.COLLECTING_MEMBERS,
                });
              }, 1000);
            } catch (error) {
              console.error("Failed to scrape spaces:", error);

              set({
                error: `Failed to get spaces: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`,
              });
            }
          }, 3000);
          return () => clearTimeout(timer);
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
      },
      setupVideoSelection: () => {
        let cleanup: (() => void) | undefined;

        const timer = setTimeout(async () => {
          console.log("running setup video selection try catch");
          try {
            const cleanupFn = await LoomScraper.setupVideoSelection(
              (
                hasSelectedVideos: boolean,
                selectedVideos?: {
                  id: string;
                  ownerName: string;
                  title: string;
                }[]
              ) => {
                console.log("📥 Video selection callback:", {
                  hasSelectedVideos,
                  selectedVideos,
                });

                const currentData = get().data; // Get fresh data

                if (
                  hasSelectedVideos &&
                  selectedVideos &&
                  selectedVideos.length > 0
                ) {
                  // Process videos using the existing processVideos function
                  const processedVideos = LoomScraper.processVideos(
                    selectedVideos,
                    currentData.workspaceMembers
                  );

                  console.log(
                    "✅ Setting videos to SELECTED state:",
                    processedVideos
                  );
                  set({
                    currentStep: ImportStep.VIDEOS_SELECTED,
                    data: { ...currentData, videos: processedVideos },
                    error: null,
                  });
                } else {
                  // When no videos are selected, stay in SELECTING_VIDEOS step
                  console.log(
                    "❌ No videos selected, staying in SELECTING_VIDEOS"
                  );
                  set({
                    currentStep: ImportStep.SELECTING_VIDEOS,
                    data: { ...currentData, videos: [] },
                    error: null,
                  });
                }
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
        }, 100);

        return () => {
          clearTimeout(timer);
          if (cleanup) cleanup();
        };
      },
      startImport: async (workspaceId: string | null) => {
        if (!workspaceId) {
          return { success: false, message: "Please select a workspace first" };
        }

        try {
          set({
            currentStep: ImportStep.COLLECTING_SPACES,
            error: null,
          });

          chrome.storage.local.remove(["loomImportData"], () => {
            createTab("https://www.loom.com/spaces/browse");
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
