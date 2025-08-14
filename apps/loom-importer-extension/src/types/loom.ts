export interface WorkspaceMember {
  name: string;
  email: string;
  role: string;
  dateJoined: string;
  status: string;
}

export interface VideoOwner {
  name: string;
  email: string;
}

export interface Video {
  id: string;
  owner: VideoOwner;
  title: string;
}

export interface LoomExportData {
  workspaceMembers: WorkspaceMember[];
  videos: Video[];
  spaces: string[];
  selectedOrganizationId: string;
  userEmail: string | null;
}
