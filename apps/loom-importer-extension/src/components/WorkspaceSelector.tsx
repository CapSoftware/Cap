import React from "react";
import { Workspace } from "../types";

interface WorkspaceSelectorProps {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
}

const WorkspaceSelector: React.FC<WorkspaceSelectorProps> = ({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
}) => {
  if (!workspaces || workspaces.length === 0) {
    return null;
  }

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-2">
        <label className="block text-sm font-medium text-gray-700">
          Select Workspace
        </label>
        <button
          onClick={onCreateWorkspace}
          className="text-xs text-[#625DF5] hover:text-[#524dcf] font-medium"
        >
          + Create
        </button>
      </div>
      <select
        className="w-full p-2 border border-gray-300 rounded-md bg-white"
        value={selectedWorkspaceId || ""}
        onChange={(e) => onSelectWorkspace(e.target.value)}
      >
        <option value="">Choose a workspace</option>
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
    </div>
  );
};

export default WorkspaceSelector;
