import { dispatchAction } from './utils';
import { showToast, Toast } from '@raycast/api';

export default async function openSettings() {
  await showToast({ style: Toast.Style.Animated, title: 'Opening Cap settings...' });

  try {
    await dispatchAction({
      open_settings: {
        page: null,
      },
    });
    await showToast({ style: Toast.Style.Success, title: 'Settings opened' });
  } catch {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Failed to communicate with Cap',
      message: 'Make sure Cap is running.',
    });
  }
}
