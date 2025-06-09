"use client";

import { useState, useRef, useEffect } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@cap/ui";
import { ChevronDown } from "lucide-react";
import clsx from "clsx";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import Image from "next/image";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";

// Define types for organization member objects
type UserObject = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

type OrganizationMember = {
  id: string;
  user: UserObject;
};

export interface TagOption {
  value: string;
  label: string;
  image?: string;
}

interface MemberSelectProps {
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  selected: TagOption[];
  onSelect: (selected: TagOption[]) => void;
  showEmptyIfNoMembers?: boolean;
  emptyMessage?: string;
}

export const MemberSelect: React.FC<MemberSelectProps> = ({
  disabled = false,
  className = "",
  placeholder = "Add Member...",
  selected = [],
  onSelect,
  showEmptyIfNoMembers = false,
  emptyMessage = "No members in your organization",
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerWidth = useRef<number>(0);
  const triggerRef = useRef<HTMLDivElement>(null);
  const { activeOrganization } = useSharedContext();

  // Generate options from organization members if no external options provided
  const { user } = useSharedContext();

  const orgMemberOptions =
    activeOrganization?.members
      .filter((m) => m.user?.id !== user?.id)
      .map((m) => {
        // Cast to our known type for proper type safety
        const member = m as unknown as OrganizationMember;
        const userObj = member.user;
        return {
          value: userObj.id,
          label: userObj.name || userObj.email,
          image: userObj.image || undefined,
        };
      }) || [];

  useEffect(() => {
    if (triggerRef.current) {
      triggerWidth.current = triggerRef.current.offsetWidth;
    }
  }, []);

  const handleSelect = (option: TagOption) => {
    if (!(selected ?? []).some((tag) => tag.value === option.value)) {
      onSelect([...(selected ?? []), option]);
      setIsOpen(true);
    }
  };

  const handleRemove = (tag: TagOption) => {
    onSelect((selected ?? []).filter((t) => t.value !== tag.value));
  };

  return (
    <div
      ref={containerRef}
      className={clsx(
        "relative flex flex-col flex-wrap p-2 items-center min-h-[52px] flex-grow border border-gray-5 rounded-2xl bg-gray-1",
        className,
        disabled && "opacity-50 pointer-events-none"
      )}
      tabIndex={-1}
    >
      {showEmptyIfNoMembers && orgMemberOptions.length === 0 ? (
        <div className="flex flex-1 justify-center items-center h-full">
          <p className="text-sm text-center text-gray-10">{emptyMessage}</p>
        </div>
      ) : (
        <>
          {orgMemberOptions.length > 0 && (
            <div className="flex relative w-full h-[40px]">
              <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
                <DropdownMenuTrigger asChild>
                  <div
                    ref={triggerRef}
                    className="flex flex-1 items-center px-2 h-full rounded-xl border transition-colors cursor-pointer bg-gray-3 border-gray-4 hover:bg-gray-5 group hover:border-gray-6"
                  >
                    <div
                      onClick={() => setIsOpen(true)}
                      className="flex flex-1 justify-between items-center p-0 h-full bg-transparent border-0 placeholder:text-gray-10 w-fit group-hover:placeholder:text-gray-12"
                    >
                      <p className="text-[13px] text-gray-12">{placeholder}</p>
                      <ChevronDown
                        className={clsx(
                          "ml-1 transition-transform duration-150 text-gray-9",
                          isOpen ? "rotate-180" : "rotate-0"
                        )}
                        size={18}
                        tabIndex={-1}
                      />
                    </div>
                  </div>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  style={{
                    width: triggerRef.current?.offsetWidth,
                  }}
                  sideOffset={8}
                  align="start"
                >
                  {orgMemberOptions.length > 0 &&
                    orgMemberOptions.map((opt) => (
                      <DropdownMenuItem
                        onClick={() => {
                          handleSelect(opt);
                          setIsOpen(false);
                        }}
                        key={opt.value}
                        className="flex gap-2 items-center
                        justify-start p-1.5 text-[13px] 
                        rounded-xl cursor-pointer"
                      >
                        {opt.image ? (
                          <Image
                            src={opt.image}
                            alt={opt.label}
                            width={20}
                            height={20}
                            className="w-5 h-5 rounded-full"
                          />
                        ) : (
                          <Avatar name={opt.label} className="w-5 h-5" />
                        )}
                        {opt.label}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          {(!showEmptyIfNoMembers || orgMemberOptions.length > 0) &&
            selected.length > 0 && (
              <div
                className={clsx(
                  "flex flex-wrap gap-2 justify-start w-full",
                  orgMemberOptions.length > 0 ? "mt-2" : "mt-0"
                )}
              >
                {selected.map((tag) => (
                  <div
                    key={tag.value}
                    className="flex gap-4 items-center hover:scale-[1.02] transition-transform h-full px-2 py-1.5 min-h-full text-xs rounded-xl bg-gray-3 text-gray-11 wobble"
                  >
                    <div className="flex gap-2 items-center">
                      {tag.image ? (
                        <Image
                          src={tag.image}
                          alt={tag.label}
                          width={20}
                          height={20}
                          className="w-5 h-5 rounded-full"
                        />
                      ) : (
                        <Avatar name={tag.label} className="w-5 h-5" />
                      )}
                      <p className="truncate text-[13px] text-gray-12">
                        {tag.label}
                      </p>
                    </div>
                    {tag.value !== user?.id && (
                      <div
                        onClick={() => handleRemove(tag)}
                        className="flex justify-center items-center rounded-full transition-colors cursor-pointer size-6 bg-gray-6 hover:bg-gray-7"
                        aria-label={`Remove ${tag.label}`}
                      >
                        <FontAwesomeIcon
                          className="text-gray-12 size-3"
                          icon={faXmark}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
        </>
      )}
    </div>
  );
};
