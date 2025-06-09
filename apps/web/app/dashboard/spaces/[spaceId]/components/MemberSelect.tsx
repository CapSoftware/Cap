"use client";

import { useState, useRef, useEffect } from "react";
import {
  Input,
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
  avatarUrl?: string;
}

interface MemberSelectProps {
  options?: TagOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  selected: TagOption[];
  onSelect: (selected: TagOption[]) => void;
}

export const MemberSelect: React.FC<MemberSelectProps> = ({
  options: externalOptions,
  disabled = false,
  className = "",
  placeholder = "Add Member...",
  selected = [],
  onSelect,
}) => {
  const [inputValue, setInputValue] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerWidth = useRef<number>(0);
  const triggerRef = useRef<HTMLDivElement>(null);
  const { activeOrganization } = useSharedContext();

  // Generate options from organization members if no external options provided
  const orgMemberOptions =
    activeOrganization?.members
      .filter((m) => m.user?.email)
      .map((m) => {
        // Cast to our known type for proper type safety
        const member = m as unknown as OrganizationMember;
        const user = member.user;
        return {
          value: user.id,
          label: user.name || user.email,
          avatarUrl: user.image || undefined,
        };
      }) || [];

  // Use provided options or fall back to organization members
  const options = externalOptions || orgMemberOptions;

  useEffect(() => {
    if (triggerRef.current) {
      triggerWidth.current = triggerRef.current.offsetWidth;
    }
  }, []);

  // Filter options based on input and exclude already selected
  const filteredOptions = options.filter(
    (opt) =>
      (!inputValue ||
        opt.label.toLowerCase().includes(inputValue.toLowerCase()) ||
        opt.value.toLowerCase().includes(inputValue.toLowerCase())) &&
      !(selected ?? []).some((tag) => tag.value === opt.value)
  );

  const handleSelect = (option: TagOption) => {
    if (!(selected ?? []).some((tag) => tag.value === option.value)) {
      onSelect([...(selected ?? []), option]);
      setInputValue("");
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
        "relative flex flex-col flex-wrap p-2 items-center h-[52px] flex-grow border border-gray-5 rounded-2xl bg-gray-1",
        className,
        disabled && "opacity-50 pointer-events-none"
      )}
      tabIndex={-1}
    >
      {filteredOptions.length > 0 && (
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
              {filteredOptions.length > 0 &&
                filteredOptions.map((opt) => (
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
                    {opt.avatarUrl ? (
                      <Image
                        src={opt.avatarUrl}
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
      {selected.length > 0 && (
        <div
          className={clsx(
            "flex flex-wrap gap-2 justify-start w-full",
            filteredOptions.length > 0 ? "mt-2" : "mt-0"
          )}
        >
          {selected.map((tag) => (
            <div
              key={tag.value}
              className="flex gap-4 items-center hover:scale-[1.02] transition-transform h-full px-2 py-1.5 min-h-full text-xs rounded-xl bg-gray-3 text-gray-11 wobble"
            >
              <div className="flex gap-2 items-center">
                {tag.avatarUrl ? (
                  <Image
                    src={tag.avatarUrl}
                    alt={tag.label}
                    width={20}
                    height={20}
                    className="w-5 h-5 rounded-full"
                  />
                ) : (
                  <Avatar name={tag.label} className="w-5 h-5" />
                )}
                <p className="truncate text-[13px] text-gray-12">{tag.label}</p>
              </div>
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
