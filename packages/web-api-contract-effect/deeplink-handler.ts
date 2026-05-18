import { DeeplinkParams, parseDeeplink, DeeplinkAction } from '@cap/utils';

export interface DeeplinkHandlerContext {
  onStartRecording?: () => void | Promise<void>;
  onStopRecording?: () => void | Promise<void>;
  onPauseRecording?: () => void | Promise<void>;
  onResumeRecording?: () => void | Promise<void>;
  onSwitchMicrophone?: (deviceId: string) => void | Promise<void>;
  onSwitchCamera?: (deviceId: string) => void | Promise<void>;
  onError?: (error: Error) => void;
}

export class DeeplinkHandlerError extends Error {
  constructor(
    public readonly action: DeeplinkAction | string | null,
    message: string,
  ) {
    super(message);
    this.name = 'DeeplinkHandlerError';
  }
}

export class DeeplinkHandler {
  constructor(private context: DeeplinkHandlerContext) {
    if (!context) {
      throw new Error('DeeplinkHandler context is required');
    }
  }

  async handle(url: string): Promise<boolean> {
    try {
      if (!url || typeof url !== 'string') {
        throw new DeeplinkHandlerError(null, 'Invalid URL provided');
      }

      const params = parseDeeplink(url);

      if (!params) {
        throw new DeeplinkHandlerError(null, `Unable to parse deeplink: ${url}`);
      }

      return await this.handleAction(params);
    } catch (error) {
      this.context.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      return false;
    }
  }

  private async handleAction(params: DeeplinkParams): Promise<boolean> {
    const { action, deviceId } = params;

    try {
      switch (action) {
        case 'record':
          await this.context.onStartRecording?.();
          return true;

        case 'stop':
          await this.context.onStopRecording?.();
          return true;

        case 'pause':
          await this.context.onPauseRecording?.();
          return true;

        case 'resume':
          await this.context.onResumeRecording?.();
          return true;

        case 'switch-microphone': {
          if (!deviceId) {
            throw new DeeplinkHandlerError(
              action,
              'deviceId is required for switch-microphone action',
            );
          }
          await this.context.onSwitchMicrophone?.(deviceId);
          return true;
        }

        case 'switch-camera': {
          if (!deviceId) {
            throw new DeeplinkHandlerError(
              action,
              'deviceId is required for switch-camera action',
            );
          }
          await this.context.onSwitchCamera?.(deviceId);
          return true;
        }

        default:
          return false;
      }
    } catch (error) {
      if (error instanceof DeeplinkHandlerError) {
        throw error;
      }
      throw new DeeplinkHandlerError(
        action,
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }
}