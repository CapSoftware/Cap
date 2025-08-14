import type React from "react";
import type { Organization } from "../types";

interface OrganizationSelectorProps {
  organizations: Organization[];
  selectedOrganizationId: string | null;
  onSelectOrganization: (organizationId: string) => void;
  onCreateOrganization: () => void;
}

const OrganizationSelector: React.FC<OrganizationSelectorProps> = ({
  organizations,
  selectedOrganizationId,
  onSelectOrganization,
  onCreateOrganization,
}) => {
  if (!organizations || organizations.length === 0) {
    return null;
  }

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-2">
        <p className="block text-sm font-medium text-gray-700">
          Select Organization
        </p>
        <button
          type="button"
          onClick={onCreateOrganization}
          className="text-xs text-[#625DF5] hover:text-[#524dcf] font-medium"
        >
          + Create
        </button>
      </div>
      <select
        className="p-2 w-full bg-white rounded-md border border-gray-300"
        value={selectedOrganizationId || ""}
        onChange={(e) => onSelectOrganization(e.target.value)}
      >
        <option value="">Choose an organization</option>
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
      </select>
    </div>
  );
};

export default OrganizationSelector;
