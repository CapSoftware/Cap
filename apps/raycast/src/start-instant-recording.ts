import { dispatchAction } from './utils';
import { showToast, Toast, getPreferenceValues } from '@raycast/api';

export default async function startInstantRecording() {
  await showToast({ style: Toast.Style.Animated, title: 'Starting instant recording...' });

  await dispatchAction({
    start_recording: {
      capture_mode: { screen: 'Built-in Retina Display' },
      camera: null,
      mic_label: null,
      capture_system_audio: false,
      mode: 'instant',
    },
  });

  await showToast({ style: Toast.Style.Success, title: 'Instant recording started' });
}
