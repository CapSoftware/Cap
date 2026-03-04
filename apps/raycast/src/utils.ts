import { open, showToast, Toast } from '@raycast/api';

const DEEPLINK_SCHEME = 'cap-desktop://action';

export async function dispatchAction(action: string | Record<string, unknown>) {
  const valueJson = typeof action === 'string' ? JSON.stringify(action) : JSON.stringify(action);
  const url = `${DEEPLINK_SCHEME}?value=${encodeURIComponent(valueJson)}`;

  try {
    await open(url);
  } catch {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Failed to communicate with Cap',
      message: 'Make sure Cap is running.',
    });
  }
}

export async function fireSimpleAction(action: string, label: string) {
  await showToast({ style: Toast.Style.Animated, title: `${label}...` });
  await dispatchAction(action);
  await showToast({ style: Toast.Style.Success, title: label });
}
