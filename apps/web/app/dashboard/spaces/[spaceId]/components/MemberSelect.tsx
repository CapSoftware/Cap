"use client";

import { useState, useRef, useEffect } from "react";
import {
  Input,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@cap/ui";
import { ChevronDown, X } from "lucide-react";
import clsx from "clsx";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import Image from "next/image";

export interface TagOption {
  value: string;
  label: string;
  avatarUrl?: string;
}

interface MemberSelectProps {
  value: TagOption[];
  onChange: (value: TagOption[]) => void;
  options: TagOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export const MemberSelect: React.FC<MemberSelectProps> = ({
  value,
  onChange,
  options,
  disabled = false,
  className = "",
}) => {
  const [inputValue, setInputValue] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerWidth = useRef<number>(0);
  const triggerRef = useRef<HTMLDivElement>(null);

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
      !value.some((tag) => tag.value === opt.value)
  );

  // Handle outside click
  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  const handleInputFocus = () => setIsOpen(true);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setIsOpen(true);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && filteredOptions.length > 0) {
      // Select the first filtered option
      const firstOption = filteredOptions[0];
      if (firstOption) {
        handleSelect(firstOption);
        e.preventDefault();
      }
    } else if (e.key === "Backspace" && !inputValue && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const handleSelect = (option: TagOption) => {
    if (!value.some((tag) => tag.value === option.value)) {
      onChange([...value, option]);
      setInputValue("");
      setIsOpen(true);
    }
  };

  const handleRemove = (tag: TagOption) => {
    onChange(value.filter((t) => t.value !== tag.value));
  };

  return (
    <div
      ref={containerRef}
      className={clsx(
        "relative flex flex-col flex-wrap p-2 items-center h-full flex-grow border border-gray-5 rounded-2xl bg-gray-1",
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
                  <p className="text-[13px] text-gray-12">Add Member...</p>
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
      {value.length > 0 && (
        <div
          className={clsx(
            "flex flex-wrap gap-2 justify-start w-full",
            filteredOptions.length > 0 ? "mt-2" : "mt-0"
          )}
        >
          {value.map((tag) => (
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
