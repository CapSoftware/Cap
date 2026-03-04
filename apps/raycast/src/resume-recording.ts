import { fireSimpleAction } from './utils';

export default async function resumeRecording() {
  await fireSimpleAction('resume_recording', 'Resuming recording…', 'Recording resumed');
}
