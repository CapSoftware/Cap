"use client";

import { useState, useRef, useEffect, forwardRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  Avatar,
  Button,
} from "@cap/ui";
import { ChevronDown } from "lucide-react";
import clsx from "clsx";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faXmark } from "@fortawesome/free-solid-svg-icons";
import Image from "next/image";
import { useDashboardContext } from "../../../Contexts";

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
  canManageMembers?: boolean;
  showEmptyIfNoMembers?: boolean;
  emptyMessage?: string;
}

export const MemberSelect = forwardRef<HTMLDivElement, MemberSelectProps>(
  (
    {
      disabled = false,
      className = "",
      placeholder = "Add Member...",
      selected = [],
      onSelect,
      canManageMembers,
      showEmptyIfNoMembers = false,
      emptyMessage = "No members in your organization",
      ...props
    },
    ref
  ) => {
    const [isOpen, setIsOpen] = useState(false);

    const containerRef = useRef<HTMLDivElement>(null);
    const triggerWidth = useRef<number>(0);
    const triggerRef = useRef<HTMLDivElement>(null);
    const { activeOrganization } = useDashboardContext();

    // Generate options from organization members if no external options provided
    const { user } = useDashboardContext();

    const trueActiveOrgMembers = activeOrganization?.members.filter((m) => m.user?.id !== user?.id);

    // Only show members that can be added (not already selected and not the current user)
    const orgMemberOptions =
      trueActiveOrgMembers?.filter((m) => !selected.some((s) => s.value === m.user?.id))
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
        ref={ref || containerRef}
        className={clsx(
          "relative flex flex-col flex-wrap p-2 items-center min-h-[52px] flex-grow border border-gray-5 rounded-2xl bg-gray-1",
          className,
          disabled && "pointer-events-none"
        )}
        tabIndex={0}
        aria-disabled={disabled}
        {...props}
      >

        {!showEmptyIfNoMembers && trueActiveOrgMembers?.length === 0 && (
          <EmptyMessage
            message="No members in your organization"
            showUpgradeButton={true}
            onButtonClick={() => setIsOpen(false)}
          />
        )}

        {/* Empty state when no members in organization */}
        {showEmptyIfNoMembers &&
          trueActiveOrgMembers?.length === 0 && (
            <div className="py-3">
              <EmptyMessage
                message="No members in your organization"
                showUpgradeButton={true}
                onButtonClick={() => setIsOpen(false)}
              />
            </div>
          )}

        {/* Empty state when no members added to space */}
        {showEmptyIfNoMembers &&
          trueActiveOrgMembers &&
          trueActiveOrgMembers.length > 0 &&
          selected.length === 0 && (
            <EmptyMessage
              message="No members have been added to this space"
              showUpgradeButton={false}
              onButtonClick={() => setIsOpen(false)}
            />
          )}

        {/* Member dropdown - only show if user can manage members */}
        {canManageMembers && orgMemberOptions.length > 0 && (
          <div
            className={clsx(
              "flex relative w-full h-[40px]",
              selected.length >= 1 && "mb-2"
            )}
          >
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
                {orgMemberOptions.map((opt) => (
                  <DropdownMenuItem
                    onClick={() => {
                      handleSelect(opt);
                      setIsOpen(false);
                    }}
                    key={opt.value}
                    className="flex gap-2 items-center justify-start p-1.5 text-[13px] rounded-xl cursor-pointer"
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

        {/* Selected members list */}
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-2 justify-start w-full">
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
                {/* Only show remove button if user can manage members and this isn't the current user */}
                {canManageMembers && tag.value !== user?.id && (
                  <button
                    type="button"
                    onClick={() => handleRemove(tag)}
                    className="flex justify-center items-center rounded-full transition-colors cursor-pointer size-6 bg-gray-6 hover:bg-gray-7"
                    aria-label={`Remove ${tag.label}`}
                  >
                    <FontAwesomeIcon
                      className="text-gray-12 size-3"
                      icon={faXmark}
                    />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
);

interface EmptyMessageProps {
  message: string;
  showUpgradeButton?: boolean;
  onButtonClick?: () => void;
}

const EmptyMessage: React.FC<EmptyMessageProps> = ({
  message,
  showUpgradeButton = false,
  onButtonClick,
}) => (
  <div className="flex flex-col gap-2 justify-center items-center py-2 h-full">
    <p className="text-sm text-center text-gray-10">{message}</p>
    {showUpgradeButton && (
      <Button
        href="/dashboard/settings/organization"
        variant="dark"
        size="xs"
        onClick={onButtonClick}
      >
        <FontAwesomeIcon className="size-3" icon={faPlus} />
        Invite members
      </Button>
    )}
  </div>
);
