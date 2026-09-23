import { requireNativeModule } from 'expo';
export type ListenerStatus = {
  paired: boolean; running: boolean; state: string; lastText: string;
  lastAt: number; serverUrl: string; batteryExempt: boolean;
};
export default requireNativeModule<{
  status(): ListenerStatus;
  pair(url: string, code: string): Promise<void>;
  start(): void; stop(): void; testSpeech(): void;
  batterySettings(): void; speechSettings(): void;
}>('AudioListener');
