import { createRoot, createEffect } from "solid-js";
import { createStore } from "solid-js/store";
import { commands } from "~/utils/tauri";

export type CaptionSegment = {
  id: string;
  start: number;
  end: number;
  text: string;
};

export type CaptionSettings = {
  enabled: boolean;
  font: string;
  size: number;
  color: string;
  background_color: string;
  background_opacity: number;
  position: string;
  bold: boolean;
  italic: boolean;
  outline: boolean;
  outline_color: string;
  export_with_subtitles: boolean;
};

export type CaptionsState = {
  segments: CaptionSegment[];
  settings: CaptionSettings;
  currentCaption: string | null;
};

function createCaptionsStore() {
  const [state, setState] = createStore<CaptionsState>({
    segments: [],
    settings: {
      enabled: false,
      font: "Arial",
      size: 24,
      color: "#FFFFFF",
      background_color: "#000000",
      background_opacity: 80,
      position: "bottom",
      bold: true,
      italic: false,
      outline: true,
      outline_color: "#000000",
      export_with_subtitles: false,
    },
    currentCaption: null
  });

  return {
    state,
    setState,
    
    // Actions
    updateSettings(settings: Partial<CaptionSettings>) {
      setState("settings", prev => ({ ...prev, ...settings }));
    },
    
    updateSegments(segments: CaptionSegment[]) {
      setState("segments", segments);
    },
    
    setCurrentCaption(caption: string | null) {
      setState("currentCaption", caption);
    },
    
    // Load captions for a video
    async loadCaptions(videoPath: string) {
      try {
        const captionsData = await commands.loadCaptions(videoPath);
        if (captionsData) {
          setState(prev => ({
            ...prev,
            segments: captionsData.segments,
            settings: { ...prev.settings, enabled: true }
          }));
        }
        
        // Try loading from localStorage as backup
        try {
          const localCaptionsData = JSON.parse(localStorage.getItem(`captions-${videoPath}`) || '{}');
          if (localCaptionsData.segments) {
            setState("segments", localCaptionsData.segments);
          }
          if (localCaptionsData.settings) {
            setState("settings", localCaptionsData.settings);
          }
        } catch (e) {
          console.error("Error loading saved captions from localStorage:", e);
        }
      } catch (e) {
        console.error("Error loading captions:", e);
      }
    },
    
    // Save captions for a video
    async saveCaptions(videoPath: string) {
      try {
        await commands.saveCaptions(videoPath, { 
          segments: state.segments,
          settings: state.settings 
        });
        localStorage.setItem(`captions-${videoPath}`, JSON.stringify({
          segments: state.segments,
          settings: state.settings
        }));
      } catch (e) {
        console.error("Error saving captions:", e);
      }
    },
    
    // Update current caption based on playback time
    updateCurrentCaption(time: number) {
      // Binary search for the correct segment
      const findSegment = (time: number, segments: CaptionSegment[]): CaptionSegment | undefined => {
        let left = 0;
        let right = segments.length - 1;
        
        while (left <= right) {
          const mid = Math.floor((left + right) / 2);
          const segment = segments[mid];
          
          if (time >= segment.start && time < segment.end) {
            return segment;
          }
          
          if (time < segment.start) {
            right = mid - 1;
          } else {
            left = mid + 1;
          }
        }
        
        return undefined;
      };

      // Find the current segment using binary search
      const currentSegment = findSegment(time, state.segments);
      
      // Only update if the caption has changed
      if (currentSegment?.text !== state.currentCaption) {
        setState("currentCaption", currentSegment?.text || null);
      }
    }
  };
}

// Create a singleton instance
const captionsStore = createRoot(() => createCaptionsStore());

export { captionsStore }; 