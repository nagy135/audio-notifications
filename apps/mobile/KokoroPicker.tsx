import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Listener, { type KokoroCatalogue, type ListenerStatus } from './modules/audio-listener/src/AudioListenerModule';

export default function KokoroPicker({ status, refresh }: { status: ListenerStatus; refresh: () => void }) {
  const [catalogue, setCatalogue] = useState<KokoroCatalogue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const load = useCallback(async () => {
    if (!status.paired) return;
    setLoading(true); setError('');
    try { setCatalogue(await Listener.kokoroVoices()); }
    catch { setError('Cannot reach Kokoro. Android speech will be used until it is available.'); }
    finally { setLoading(false); }
  }, [status.paired]);
  useEffect(() => {
    void load();
    const sub = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
    return () => sub.remove();
  }, [load]);

  function run(action: () => void) {
    try { action(); refresh(); }
    catch (e) { Alert.alert('Kokoro voice', e instanceof Error ? e.message : String(e)); }
  }
  const selected = catalogue?.voices.find(voice => voice.id === status.kokoroVoice);
  const selectedName = selected?.name || (status.kokoroVoice === 'af_heart' ? 'Heart' : status.kokoroVoice);
  const canPreview = status.running && !status.speechBusy;

  return <View style={s.card}>
    <View style={s.row}>
      <View style={s.heading}><Text style={s.eyebrow}>PRIMARY VOICE</Text><Text style={s.title}>Kokoro</Text></View>
      <Switch accessibilityLabel="Use Kokoro voices" value={status.useKokoro} onValueChange={enabled => run(() => Listener.setUseKokoro(enabled))} trackColor={{ false: '#46515d', true: '#729d44' }} thumbColor="#e9f4dc" />
    </View>
    <Text style={s.hint}>{status.useKokoro ? 'Natural English voices from your private server. Android speech takes over if Kokoro is unavailable.' : 'Using Android speech only. Turn on Kokoro for neural voices.'}</Text>
    {status.useKokoro && <>
      <Text style={s.name}>{selectedName}{selected ? ` · ${selected.description}` : ''}</Text>
      {loading && <ActivityIndicator color="#b7f36b" />}
      {!!error && <Text accessibilityLiveRegion="polite" style={s.hint}>{error}</Text>}
      {!status.paired && <Text style={s.hint}>Pair your phone to load the available voices.</Text>}
      {!loading && !error && catalogue && !catalogue.available && <Text style={s.hint}>{catalogue.enabled ? 'Kokoro is warming up or unavailable. Android speech is ready as your fallback.' : 'Kokoro is not enabled on this server yet. Android speech will be used.'}</Text>}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => { setExpanded(!expanded); if (!expanded) void load(); }} style={s.button}><Text style={s.link}>{expanded ? 'Hide voices ↑' : 'Choose Kokoro voice →'}</Text></Pressable>
      {expanded && <View style={s.choices}>
        {catalogue?.voices.map(voice => <Pressable key={voice.id} accessibilityRole="radio" accessibilityState={{ checked: status.kokoroVoice === voice.id }} onPress={() => run(() => Listener.setKokoroVoice(voice.id))} style={[s.choice, status.kokoroVoice === voice.id && s.selected]}>
          <Text style={s.name}>{status.kokoroVoice === voice.id ? '✓ ' : ''}{voice.name}</Text><Text style={s.hint}>{voice.description}</Text>
        </Pressable>)}
        <Pressable accessibilityRole="button" disabled={loading} onPress={() => void load()} style={s.button}><Text style={s.link}>Refresh voices</Text></Pressable>
      </View>}
      <Pressable accessibilityRole="button" disabled={!canPreview} onPress={() => run(() => Listener.testSpeech())} style={[s.button, !canPreview && s.disabled]}><Text style={s.link}>Preview {selectedName} ↗</Text></Pressable>
      {!status.running && <Text style={s.hint}>Start listening to preview a voice.</Text>}
      {status.speechBusy && <Text style={s.hint}>Finishing the current message. Your choice applies to the next one.</Text>}
      {!!status.lastVoice && <Text accessibilityLiveRegion="polite" style={s.hint}>Last playback: {status.lastVoice}</Text>}
    </>}
  </View>;
}

const s = StyleSheet.create({
  card: { backgroundColor: '#1c242c', borderRadius: 24, padding: 24, borderWidth: 1, borderColor: '#303b45', gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, heading: { flex: 1, gap: 8 }, eyebrow: { color: '#aeb9c6', fontSize: 10, letterSpacing: 2, fontWeight: '700' }, title: { color: '#f2f4f8', fontSize: 27, fontWeight: '500' },
  name: { color: '#e4e9ef', fontSize: 16, lineHeight: 24 }, hint: { color: '#9ba5b3', fontSize: 13, lineHeight: 20 }, link: { color: '#b7f36b', fontSize: 14, fontWeight: '600' }, button: { paddingVertical: 12, alignItems: 'center' }, disabled: { opacity: 0.4 },
  choices: { gap: 10 }, choice: { borderWidth: 1, borderColor: '#46515d', borderRadius: 12, padding: 12, gap: 4 }, selected: { borderColor: '#b7f36b', backgroundColor: '#243224' },
});
