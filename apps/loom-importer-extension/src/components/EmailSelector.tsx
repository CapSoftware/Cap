import React from "react";
import { WorkspaceMember } from "../types/loom";

interface EmailSelectorProps {
  workspaceMembers: WorkspaceMember[];
  onEmailSelected: (email: string) => void;
  selectedEmail: string | null;
}

const EmailSelector: React.FC<EmailSelectorProps> = ({
  workspaceMembers,
  onEmailSelected,
  selectedEmail,
}) => {
  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-2">
        <label className="block text-sm font-medium text-gray-700">
          Select Loom Email
        </label>
      </div>
      <select
        className="w-full p-2 border border-gray-300 rounded-md bg-white"
        value={selectedEmail || ""}
        onChange={(e) => onEmailSelected(e.target.value)}
      >
        <option value="">Select an email</option>
        {workspaceMembers.map((member) => (
          <option key={member.email} value={member.email}>
            {member.email} ({member.name})
          </option>
        ))}
      </select>
      <p className="text-xs text-gray-500 mt-1">
        Select the email address you use with Loom to correctly identify your
        videos.
      </p>
    </div>
  );
};

export default EmailSelector;
