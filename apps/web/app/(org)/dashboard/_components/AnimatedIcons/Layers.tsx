'use client';

import { cn } from "@/lib/utils";
import type { Transition } from 'motion/react';
import { motion, useAnimation } from 'motion/react';
import type { HTMLAttributes } from 'react';
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';

export interface LayersIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface LayersIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const defaultTransition: Transition = {
  type: 'spring',
  stiffness: 100,
  damping: 14,
  mass: 1,
};

const LayersIcon = forwardRef<LayersIconHandle, LayersIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;

      return {
        startAnimation: async () => {
          await controls.start('firstState');
          await controls.start('secondState');
        },
        stopAnimation: () => controls.start('normal'),
      };
    });

    const handleMouseEnter = useCallback(
      async (e: React.MouseEvent<HTMLDivElement>) => {
        if (!isControlledRef.current) {
          await controls.start('firstState');
          await controls.start('secondState');
        } else {
          onMouseEnter?.(e);
        }
      },
      [controls, onMouseEnter]
    );

    const handleMouseLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (!isControlledRef.current) {
          controls.start('normal');
        } else {
          onMouseLeave?.(e);
        }
      },
      [controls, onMouseLeave]
    );

    return (
      <div
        className={cn(className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
          <motion.path
            d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"
            variants={{
              normal: { y: 0 },
              firstState: { y: -9 },
              secondState: { y: 0 },
            }}
            animate={controls}
            transition={defaultTransition}
          />
          <motion.path
            d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"
            variants={{
              normal: { y: 0 },
              firstState: { y: -5 },
              secondState: { y: 0 },
            }}
            animate={controls}
            transition={defaultTransition}
          />
        </svg>
      </div>
    );
  }
);

LayersIcon.displayName = 'LayersIcon';

export default LayersIcon;
