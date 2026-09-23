import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Listener, { type ListenerStatus, type SpeechVoice, type VoiceCatalogue } from './modules/audio-listener/src/AudioListenerModule';

export default function VoicePicker({ status }: { status: ListenerStatus }) {
  const [catalogue, setCatalogue] = useState<VoiceCatalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const request = useRef(0);
  const invalidate = useCallback(() => { request.current++; }, []);
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError('');
    try {
      const result = await Listener.voices();
      if (id === request.current) setCatalogue(result);
    } catch (e) {
      if (id === request.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const sub = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
    return () => { invalidate(); sub.remove(); };
  }, [load, invalidate]);

  const selected = catalogue?.selectedEngine === catalogue?.engineId
    ? catalogue?.voices.find(voice => voice.id === catalogue.selectedVoice) : undefined;
  const unavailable = !!catalogue?.selectedVoice && !selected;
  const filter = query.trim().toLocaleLowerCase();
  const choices = catalogue?.voices.filter(voice => `${voice.label} ${voice.language} ${voice.id} ${voice.online ? 'online' : 'offline'}`.toLocaleLowerCase().includes(filter)) ?? [];
  const changingEngine = status.running && !!status.speechEngine && !!catalogue && status.speechEngine !== catalogue.engineId;

  async function choose(voice?: SpeechVoice) {
    if (!catalogue || saving || loading) return;
    setSaving(true);
    try {
      await Listener.setVoice(catalogue.engineId, voice?.id ?? '');
      // Ignore any discovery response started before this preference was saved.
      request.current++;
      setCatalogue({ ...catalogue, selectedEngine: voice ? catalogue.engineId : '', selectedVoice: voice?.id ?? '' });
      setLoading(false);
    } catch (e) { Alert.alert('Could not select voice', e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  function preview() {
    try { Listener.testFallbackSpeech(); }
    catch (e) { Alert.alert('Voice preview', e instanceof Error ? e.message : String(e)); }
  }

  const summary = selected ? `${selected.label} · ${selected.id}` : unavailable ? 'Saved voice unavailable' : 'Automatic · prefer offline';
  const canPreview = status.running && !status.speechBusy && !saving && !loading && !changingEngine;
  const feedback = <>
    {loading && <View style={s.loading}><ActivityIndicator color="#b7f36b" /><Text style={s.hint}>Finding voices…</Text></View>}
    {!!error && <Text accessibilityLiveRegion="polite" style={s.hint}>{error}</Text>}
    {!loading && !error && catalogue?.voices.length === 0 && <Text style={s.hint}>No voices found. Install a voice in Android voice settings, then refresh.</Text>}
    {!loading && !error && unavailable && <Text style={s.hint}>Your saved voice is unavailable in this engine. Automatic selection will be used until you choose another voice.</Text>}
    {changingEngine && <Text style={s.hint}>Stop and start listening to use the new speech engine.</Text>}
  </>;
  const previewButton = <>
    <Pressable accessibilityRole="button" disabled={!canPreview} onPress={preview} style={[s.button, !canPreview && s.disabled]}><Text style={s.link}>Test selected voice ↗</Text></Pressable>
    {!status.running && <Text style={s.hint}>Start listening to preview your selected voice.</Text>}
    {status.speechBusy && <Text style={s.hint}>Wait for the current message to finish before previewing.</Text>}
  </>;

  return <View style={s.section}>
    <Text style={s.eyebrow}>{status.useKokoro ? 'ANDROID FALLBACK VOICE' : 'ANDROID VOICE'}</Text>
    <Text style={s.title}>{summary}</Text>
    {!!catalogue && <Text style={s.hint}>{catalogue.engineLabel} · {catalogue.voices.length} voices</Text>}
    {feedback}
    <Pressable accessibilityRole="button" onPress={() => { setQuery(''); setOpen(true); void load(); }} style={s.button}><Text style={s.link}>Choose Android voice →</Text></Pressable>
    <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={s.page}>
        <View style={s.header}>
          <View style={s.heading}><Text style={s.modalTitle}>Android voice</Text><Text style={s.hint}>{catalogue?.engineLabel || 'Android speech voices'}</Text></View>
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={s.close}><Text style={s.link}>Done</Text></Pressable>
        </View>
        <View style={s.controls}>
          <TextInput accessibilityLabel="Search voices" placeholder="Search language or voice" placeholderTextColor="#778595" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} style={s.input} />
          {feedback}
          <Pressable accessibilityRole="radio" accessibilityState={{ checked: !catalogue?.selectedVoice, disabled: saving || loading || !catalogue || !!error }} disabled={saving || loading || !catalogue || !!error} onPress={() => void choose()} style={[s.voice, !catalogue?.selectedVoice && s.selected]}>
            <Text style={s.voiceTitle}>{!catalogue?.selectedVoice ? '✓ ' : ''}Automatic</Text>
            <Text style={s.hint}>Prefer an offline voice in your phone’s language.</Text>
          </Pressable>
        </View>
        <FlatList<SpeechVoice>
          data={loading || error ? [] : choices}
          keyExtractor={voice => voice.id}
          extraData={[catalogue?.selectedVoice, catalogue?.selectedEngine, saving]}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={s.list}
          ListEmptyComponent={!loading && !error && !!catalogue?.voices.length ? <Text style={s.hint}>No voices match your search.</Text> : null}
          renderItem={({ item }) => {
            const checked = selected?.id === item.id;
            return <Pressable accessibilityRole="radio" accessibilityState={{ checked, disabled: saving }} disabled={saving} onPress={() => void choose(item)} style={[s.voice, checked && s.selected]}>
              <View style={s.voiceHeader}><Text style={[s.voiceTitle, s.heading]}>{checked ? '✓ ' : ''}{item.label}</Text><Text style={s.badge}>{item.online ? 'ONLINE' : 'OFFLINE'}</Text></View>
              <Text style={s.hint}>{item.id}</Text>
              <Text style={s.detail}>{item.language}{item.online ? ' · Requires internet' : ' · Works without internet'}</Text>
            </Pressable>;
          }}
        />
        <View style={s.bottom}>
          <Text numberOfLines={2} style={s.hint}>Selected: {summary}</Text>
          {previewButton}
          <View style={s.actions}>
            <Pressable accessibilityRole="button" disabled={loading || saving} onPress={() => void load()} style={s.close}><Text style={s.link}>Refresh</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => { try { Listener.speechSettings(); } catch (e) { Alert.alert('Voice settings', String(e)); } }} style={s.close}><Text style={s.link}>Android voice settings ↗</Text></Pressable>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  </View>;
}

const s = StyleSheet.create({
  section: { gap: 12 }, page: { flex: 1, backgroundColor: '#101419' }, header: { padding: 20, flexDirection: 'row', gap: 12, alignItems: 'center' }, heading: { flex: 1, gap: 6 },
  eyebrow: { color: '#aeb9c6', fontSize: 10, letterSpacing: 2, fontWeight: '700' }, title: { color: '#e4e9ef', fontSize: 18, lineHeight: 26 }, modalTitle: { color: '#f2f4f8', fontSize: 25, fontWeight: '600' },
  hint: { color: '#9ba5b3', fontSize: 13, lineHeight: 20 }, detail: { color: '#aeb9c6', fontSize: 11, lineHeight: 17 }, link: { color: '#b7f36b', fontSize: 14, fontWeight: '600' },
  button: { borderWidth: 1, borderColor: '#596f42', borderRadius: 12, alignItems: 'center', padding: 15 }, disabled: { opacity: 0.4 }, close: { paddingVertical: 12, paddingHorizontal: 4 },
  controls: { paddingHorizontal: 20, gap: 12 }, input: { color: '#f2f4f8', backgroundColor: '#1c242c', borderWidth: 1, borderColor: '#35404b', borderRadius: 12, padding: 14, fontSize: 14 },
  list: { padding: 20, gap: 10 }, voice: { padding: 14, borderWidth: 1, borderColor: '#303b45', backgroundColor: '#1c242c', borderRadius: 14, gap: 5 }, selected: { borderColor: '#b7f36b', backgroundColor: '#243224' },
  voiceHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 }, voiceTitle: { color: '#f2f4f8', fontSize: 15, fontWeight: '600' }, badge: { color: '#b7f36b', fontSize: 9, letterSpacing: 1 },
  bottom: { padding: 20, paddingTop: 12, gap: 8, borderTopWidth: 1, borderTopColor: '#2a323c' }, actions: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap' }, loading: { flexDirection: 'row', gap: 10, alignItems: 'center' },
});
