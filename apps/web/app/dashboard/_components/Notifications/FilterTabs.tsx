import clsx from "clsx";
import { motion } from "framer-motion";
import { useRef, useEffect } from "react";
import { Filters, FilterType } from "./types";

type FilterTabsProps = {
  activeFilter: FilterType;
  setActiveFilter: (filter: FilterType) => void;
};

export const FilterTabs = ({ activeFilter, setActiveFilter }: FilterTabsProps) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Add wheel event handling for horizontal scrolling
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Prevent the default vertical scroll
      if (!e.ctrlKey) {
        e.preventDefault();
      }
      
      // Scroll horizontally instead of vertically
      container.scrollLeft += e.deltaY;
    };

    // Add the wheel event listener
    container.addEventListener('wheel', handleWheel, { passive: false });

    // Clean up
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, []);

  return (
    <div 
      ref={scrollContainerRef}
      className="flex isolate overflow-x-auto relative gap-4 items-center px-6 border-r border-b border-l hide-scroll border-gray-3"
    >
      {Filters.map((filter) => (
        <div key={filter} className="relative min-w-fit">
          <div
            onClick={() => setActiveFilter(filter)}
            className="flex relative gap-2 items-center py-4 cursor-pointer group"
          >
            <p className={clsx(
              "text-[13px] transition-colors", 
              activeFilter === filter 
                ? "text-gray-12" 
                : "text-gray-10 group-hover:text-gray-11"
            )}>
              {filter}
            </p>
            <div className="flex justify-center items-center rounded-md size-4 bg-gray-4">
              <p className={clsx(
                "text-[10px] transition-colors", 
                activeFilter === filter 
                  ? "text-gray-12" 
                  : "text-gray-10 group-hover:text-gray-11"
              )}>
                5
              </p>
            </div>
          </div>
          
          {/* Indicator */}
          {activeFilter === filter && (
            <motion.div
              layoutId="indicator"
              className="absolute right-0 bottom-0 w-full h-px rounded-full bg-gray-12"
              transition={{ ease: "easeOut", duration: 0.2 }}
            />
          )}
        </div>
      ))}
    </div>
  );
};
