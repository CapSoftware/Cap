import { fireSimpleAction } from './utils';

export default async function resumeRecording() {
  await fireSimpleAction('resume_recording', 'Recording resumed');
}
