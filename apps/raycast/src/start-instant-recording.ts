import { dispatchAction } from './utils';
import { showToast, Toast } from '@raycast/api';

export default async function startInstantRecording() {
  await showToast({ style: Toast.Style.Animated, title: 'Starting instant recording...' });

  try {
    await dispatchAction({
      start_recording: {
        capture_mode: null,
        camera: null,
        mic_label: null,
        capture_system_audio: false,
        mode: 'instant',
      },
    });
    await showToast({ style: Toast.Style.Success, title: 'Instant recording started' });
  } catch {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Failed to communicate with Cap',
      message: 'Make sure Cap is running.',
    });
  }
}
