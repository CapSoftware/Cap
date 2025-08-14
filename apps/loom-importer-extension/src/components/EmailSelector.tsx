import type React from "react";
import type { WorkspaceMember } from "../types/loom";

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
      <div className="flex justify-between items-center mb-2">
        <p className="block text-sm font-medium text-gray-700">
          Select Loom Email
        </p>
      </div>
      <select
        className="p-2 w-full bg-white rounded-md border border-gray-300"
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
      <p className="mt-1 text-xs text-gray-500">
        Select the email address you use with Loom to correctly identify your
        videos.
      </p>
    </div>
  );
};

export default EmailSelector;
