import { requireNativeModule } from 'expo';
export type ListenerStatus = {
  paired: boolean; running: boolean; state: string; lastText: string;
  lastAt: number; serverUrl: string; batteryExempt: boolean; speechEngine: string;
  speechBusy: boolean; useKokoro: boolean; kokoroVoice: string; lastVoice: string;
};
export type SpeechVoice = { id: string; language: string; label: string; online: boolean };
export type VoiceCatalogue = {
  engineId: string; engineLabel: string; selectedEngine: string; selectedVoice: string;
  voices: SpeechVoice[];
};
export type KokoroCatalogue = {
  enabled: boolean; available: boolean;
  voices: { id: string; name: string; description: string }[];
};
export default requireNativeModule<{
  kokoroVoices(): Promise<KokoroCatalogue>;
  setKokoroVoice(voice: string): void;
  setUseKokoro(enabled: boolean): void;
  testFallbackSpeech(): void;
  voices(): Promise<VoiceCatalogue>;
  setVoice(engineId: string, name: string): Promise<void>;
  status(): ListenerStatus;
  pair(url: string, code: string): Promise<void>;
  start(): void; stop(): void; testSpeech(): void;
  batterySettings(): void; speechSettings(): void;
}>('AudioListener');
