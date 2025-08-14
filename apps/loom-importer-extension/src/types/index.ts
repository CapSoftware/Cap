import type { LoomExportData } from "./loom";

export interface AuthResponse {
  token: string | null;
  timestamp?: number;
}

export interface Organization {
  id: string;
  name: string;
}

export interface User {
  name: string;
  image: string;
}

export interface ChecklistItem {
  message: string;
  status: ChecklistItemStatus;
}

export type ChecklistItemStatus =
  | "waiting"
  | "in-progress"
  | "complete"
  | "error";

export interface PopupState {
  status: string;
  token: string;
  isError: boolean;
  isAuthenticated: boolean;
  user: User | null;
  importStarted: boolean;
  importComplete: boolean;
  importData: LoomExportData | null;
  checklistItems: ChecklistItem[];
  organizations: Organization[];
  selectedOrganizationId: string | null;
}
