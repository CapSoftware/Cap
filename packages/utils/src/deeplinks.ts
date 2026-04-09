export type DeeplinkAction = 
  | 'record'
  | 'stop'
  | 'pause'
  | 'resume'
  | 'switch-microphone'
  | 'switch-camera';

export interface DeeplinkParams {
  action: DeeplinkAction;
  deviceId?: string;
  [key: string]: string | undefined;
}

export const DEEPLINK_PREFIX = 'cap://';

// Validate action against known types
function isValidAction(action: string): action is DeeplinkAction {
  const validActions: DeeplinkAction[] = [
    'record',
    'stop',
    'pause',
    'resume',
    'switch-microphone',
    'switch-camera',
  ];
  return validActions.includes(action as DeeplinkAction);
}

export function parseDeeplink(url: string): DeeplinkParams | null {
  try {
    if (!url || typeof url !== 'string') {
      return null;
    }

    if (!url.startsWith(DEEPLINK_PREFIX)) {
      return null;
    }

    const urlPart = url.slice(DEEPLINK_PREFIX.length).trim();
    
    if (!urlPart) {
      return null;
    }

    const [pathSegment, queryString] = urlPart.split('?');
    const segments = pathSegment.split('/').filter(Boolean);
    const action = segments[0];

    if (!action || !isValidAction(action)) {
      return null;
    }

    const queryParams: Record<string, string> = {};

    if (queryString) {
      try {
        new URLSearchParams(queryString).forEach((value, key) => {
          if (value) {
            queryParams[key] = value;
          }
        });
      } catch {
        // Invalid query string, continue with parsed params
      }
    }

    return {
      action,
      ...queryParams,
    };
  } catch {
    return null;
  }
}

export function createDeeplink(
  action: DeeplinkAction,
  params?: Record<string, string | undefined>,
): string {
  let url = `${DEEPLINK_PREFIX}${action}`;

  // Filter out undefined/empty values
  const validParams = Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== '')
    .reduce((acc, [key, value]) => {
      acc[key] = value as string;
      return acc;
    }, {} as Record<string, string>);

  if (Object.keys(validParams).length > 0) {
    const searchParams = new URLSearchParams(validParams);
    url += `?${searchParams.toString()}`;
  }

  return url;
}

// Builder pattern for fluent API
export class DeeplinkBuilder {
  private action: DeeplinkAction;
  private params: Record<string, string> = {};

  constructor(action: DeeplinkAction) {
    this.action = action;
  }

  withParam(key: string, value: string): this {
    if (key && value) {
      this.params[key] = value;
    }
    return this;
  }

  withDeviceId(deviceId: string): this {
    return this.withParam('deviceId', deviceId);
  }

  build(): string {
    return createDeeplink(this.action, this.params);
  }
}

export const DeeplinkActions = {
  startRecording: (): string => createDeeplink('record'),
  stopRecording: (): string => createDeeplink('stop'),
  pauseRecording: (): string => createDeeplink('pause'),
  resumeRecording: (): string => createDeeplink('resume'),
  switchMicrophone: (deviceId: string): string => {
    if (!deviceId) throw new Error('deviceId is required for switchMicrophone');
    return createDeeplink('switch-microphone', { deviceId });
  },
  switchCamera: (deviceId: string): string => {
    if (!deviceId) throw new Error('deviceId is required for switchCamera');
    return createDeeplink('switch-camera', { deviceId });
  },
};