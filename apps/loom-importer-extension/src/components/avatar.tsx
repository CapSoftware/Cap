import React from "react";

interface AvatarProps {
  username: string;
  imageUrl?: string;
}

const Avatar: React.FC<AvatarProps> = ({ username, imageUrl }) => {
  const initial = username.slice(0, 1).toUpperCase();

  return (
    <div className="w-8 h-8 rounded-full overflow-hidden">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={username}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-blue-400">
          <span className="text-sm font-medium text-white">{initial}</span>
        </div>
      )}
    </div>
  );
};

export default Avatar;
