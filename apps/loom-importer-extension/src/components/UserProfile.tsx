import React from "react";
import Avatar from "./avatar";
import { User } from "../types";

interface UserProfileProps {
  user: User | null;
  onLogout: () => void;
}

const UserProfile: React.FC<UserProfileProps> = ({ user, onLogout }) => {
  return (
    <div className="mt-4 flex items-center justify-between cursor-pointer hover:bg-gray-200 p-2 rounded-lg transition-colors">
      <div className="flex items-center">
        <Avatar username={user?.name || "Loading..."} imageUrl={user?.image} />
        <span className="ml-2 text-sm">{user?.name || "Loading..."}</span>
      </div>
      <button
        onClick={onLogout}
        className="ml-2 text-xs text-white bg-red-500 px-2 py-1 rounded-full no-underline hover:bg-red-600"
      >
        Logout
      </button>
    </div>
  );
};

export default UserProfile;
