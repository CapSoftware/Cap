"""
Module for handling deeplinks and Raycast extension integration in Cap.
"""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

class DeeplinkHandler:
    """
    Handles deeplink URLs for Cap application actions.
    
    Attributes:
        supported_actions: Dictionary mapping action names to URL patterns
    """
    supported_actions: Dict[str, str] = {
        "start_recording": "cap://start-recording",
        "stop_recording": "cap://stop-recording",
        "pause_recording": "cap://pause-recording",
        "resume_recording": "cap://resume-recording",
        "switch_mic": "cap://switch-mic",
        "switch_camera": "cap://switch-camera"
    }

    def __init__(self) -> None:
        """
        Initialize DeeplinkHandler with default configuration.
        """
        self._validate_config()

    def _validate_config(self) -> None:
        """
        Validate the configuration of supported actions.
        
        Raises:
            ValueError: If any action URL is invalid
        """
        try:
            if not all(isinstance(url, str) for url in self.supported_actions.values()):
                raise ValueError("All action URLs must be strings")
        except Exception as e:
            logger.error(f"Configuration validation failed: {e}")
            raise

    def handle_deeplink(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Process a deeplink URL and execute the corresponding action.
        
        Args:
            url: The deeplink URL to process
            
        Returns:
            Dictionary with action result or None if no action matched
            
        Raises:
            ValueError: If URL is invalid or action not supported
        """
        try:
            if not url.startswith("cap://"):
                logger.warning(f"Unsupported scheme in URL: {url}")
                return None
                
            for action, pattern in self.supported_actions.items():
                if url == pattern:
                    return self._execute_action(action)
            
            logger.warning(f"No matching action found for URL: {url}")
            return None
            
        except Exception as e:
            logger.error(f"Failed to handle deeplink {url}: {e}")
            raise

    def _execute_action(self, action: str) -> Dict[str, Any]:
        """
        Execute the specified action.
        
        Args:
            action: Name of the action to execute
            
        Returns:
            Dictionary with action execution result
            
        Raises:
            ValueError: If action is not supported
        """
        try:
            if action == "start_recording":
                return self.start_recording()
            elif action == "stop_recording":
                return self.stop_recording()
            elif action == "pause_recording":
                return self.pause_recording()
            elif action == "resume_recording":
                return self.resume_recording()
            elif action == "switch_mic":
                return self.switch_mic()
            elif action == "switch_camera":
                return self.switch_camera()
            else:
                raise ValueError(f"Unsupported action: {action}")
                
        except Exception as e:
            logger.error(f"Failed to execute action {action}: {e}")
            raise

    def start_recording(self) -> Dict[str, Any]:
        """
        Start recording with default settings.
        
        Returns:
            Dictionary with recording status
            
        Raises:
            RuntimeError: If recording is already in progress
        """
        try:
            # Simulate recording start
            logger.info("Starting recording...")
            return {"status": "recording_started", "timestamp": "2023-09-15T14:30:00Z"}
            
        except RuntimeError as e:
            logger.error(f"Recording start failed: {e}")
            raise

    def stop_recording(self) -> Dict[str, Any]:
        """
        Stop the current recording session.
        
        Returns:
            Dictionary with recording status
            
        Raises:
            RuntimeError: If no recording is in progress
        """
        try:
            # Simulate recording stop
            logger.info("Stopping recording...")
            return {"status": "recording_stopped", "timestamp": "2023-09-15T14:35:00Z"}
            
        except RuntimeError as e:
            logger.error(f"Recording stop failed: {e}")
            raise

    def pause_recording(self) -> Dict[str, Any]:
        """
        Pause the current recording session.
        
        Returns:
            Dictionary with recording status
            
        Raises:
            RuntimeError: If no recording is in progress
        """
        try:
            # Simulate recording pause
            logger.info("Pausing recording...")
            return {"status": "recording_paused", "timestamp": "2023-09-15T14:32:00Z"}
            
        except RuntimeError as e:
            logger.error(f"Recording pause failed: {e}")
            raise

    def resume_recording(self) -> Dict[str, Any]:
        """
        Resume a paused recording session.
        
        Returns:
            Dictionary with recording status
            
        Raises:
            RuntimeError: If recording is not paused
        """
        try:
            # Simulate recording resume
            logger.info("Resuming recording...")
            return {"status": "recording_resumed", "timestamp": "2023-09-15T14:33:00Z"}
            
        except RuntimeError as e:
            logger.error(f"Recording resume failed: {e}")
            raise

    def switch_mic(self) -> Dict[str, Any]:
        """
        Switch to the next available microphone.
        
        Returns:
            Dictionary with microphone switch status
            
        Raises:
            RuntimeError: If no microphone is available
        """
        try:
            # Simulate microphone switch
            logger.info("Switching microphone...")
            return {"status": "mic_switched", "device": "USB Microphone 2"}
            
        except RuntimeError as e:
            logger.error(f"Microphone switch failed: {e}")
            raise

    def switch_camera(self) -> Dict[str, Any]:
        """
        Switch to the next available camera.
        
        Returns:
            Dictionary with camera switch status
            
        Raises:
            RuntimeError: If no camera is available
        """
        try:
            # Simulate camera switch
            logger.info("Switching camera...")
            return {"status": "camera_switched", "device": "Logitech HD Camera"}
            
        except RuntimeError as e:
            logger.error(f"Camera switch failed: {e}")
            raise

def main() -> None:
    """
    Main entry point for testing deeplink handling.
    """
    try:
        handler = DeeplinkHandler()
        
        # Test different deeplinks
        test_urls = [
            "cap://start-recording",
            "cap://stop-recording",
            "cap://pause-recording",
            "cap://resume-recording",
            "cap://switch-mic",
            "cap://switch-camera",
            "cap://invalid-action"
        ]
        
        for url in test_urls:
            logger.info(f"Processing URL: {url}")
            result = handler.handle_deeplink(url)
            if result:
                logger.info(f"Action result: {result}")
                
    except Exception as e:
        logger.error(f"Main function failed: {e}")
        raise

if __name__ == "__main__":
    main()