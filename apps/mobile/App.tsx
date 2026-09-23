import { useEffect, useState } from 'react';
import { Alert, AppState, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Listener from './modules/audio-listener/src/AudioListenerModule';

export default function App() {
  const [status, setStatus] = useState(() => Listener.status());
  const [url, setUrl] = useState(status.serverUrl);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(!status.paired);
  const refresh = () => setStatus(Listener.status());
  useEffect(() => {
    const timer = setInterval(refresh, 1000);
    const sub = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => { clearInterval(timer); sub.remove(); };
  }, []);
  async function run(action: () => void | Promise<void>) {
    setBusy(true);
    try { await action(); refresh(); } catch (e) { Alert.alert('Audio Notifications', e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function start() {
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      if (result !== PermissionsAndroid.RESULTS.GRANTED) {
        Alert.alert('Allow notifications', 'Enable notifications in Android app settings so you can see and stop the background listener.');
        return;
      }
    }
    Listener.start();
  }
  const connected = status.state === 'Listening' || status.state === 'Speaking';
  return <SafeAreaProvider><SafeAreaView style={s.page}>
    <StatusBar style="light" />
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View style={s.top}><Text style={s.brand}>INFINITER / AUDIO</Text><View style={s.tag}><Text style={s.tagText}>PRIVATE</Text></View></View>
      <Text style={s.title}>A little less{ '\n' }screen time.</Text>
      <Text style={s.subtitle}>Your agents have something to say.{ '\n' }Hear it, wherever you are.</Text>
      <View style={s.card}>
        <View style={s.statusRow}><View style={[s.dot, { backgroundColor: connected ? '#b7f36b' : '#8d95a3' }]} /><Text style={s.eyebrow}>{status.running ? 'LISTENER ACTIVE' : 'LISTENER PAUSED'}</Text></View>
        <Text accessibilityLiveRegion="polite" style={s.state}>{status.state}</Text>
        <Text style={s.hint}>{status.running ? 'You can leave this screen or lock your phone.' : 'Start listening to hear incoming messages aloud.'}</Text>
        <Pressable accessibilityRole="button" disabled={!status.paired || busy} onPress={() => run(status.running ? () => Listener.stop() : start)} style={[s.primary, (!status.paired || busy) && s.disabled, status.running && s.stop]}>
          <Text style={[s.primaryText, status.running && { color: '#f2f4f8' }]}>{status.running ? 'Stop listening' : 'Start listening'}  {status.running ? 'Ⅱ' : '→'}</Text>
        </Pressable>
        {status.running && <Pressable accessibilityRole="button" onPress={() => run(() => Listener.testSpeech())} style={s.linkButton}><Text style={s.link}>Test voice ↗</Text></Pressable>}
      </View>
      {!status.batteryExempt && <View style={s.notice}>
        <Text style={s.noticeTitle}>Let it listen while locked</Text>
        <Text style={s.hint}>Allow unrestricted battery use for reliable delivery with the screen off. Keep Tailscale connected and media volume audible.</Text>
        <Pressable accessibilityRole="button" onPress={() => run(() => Listener.batterySettings())} style={s.linkButton}><Text style={s.link}>Allow background listening →</Text></Pressable>
      </View>}
      {editing ? <View style={s.section}>
        <Text style={s.eyebrow}>CONNECT YOUR PHONE</Text>
        <Text style={s.label}>Server address</Text>
        <TextInput accessibilityLabel="Server address" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={s.input} editable={!status.running && !busy} />
        <Text style={s.label}>One-time pairing code</Text>
        <TextInput accessibilityLabel="Pairing code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} maxLength={10} placeholder="XXXXXXXXXX" placeholderTextColor="#626d7c" style={s.input} editable={!status.running && !busy} />
        <Pressable accessibilityRole="button" disabled={busy || status.running || code.trim().length !== 10} onPress={() => run(async () => { await Listener.pair(url, code); setCode(''); setEditing(false); })} style={[s.secondary, (busy || status.running || code.trim().length !== 10) && s.disabled]}><Text style={s.link}>{busy ? 'Connecting…' : 'Pair this phone →'}</Text></Pressable>
        {status.running && <Text style={s.hint}>Stop the listener before changing pairing.</Text>}
        {status.paired && <Pressable onPress={() => setEditing(false)} style={s.linkButton}><Text style={s.hint}>Cancel</Text></Pressable>}
      </View> : <View style={s.section}>
        <Text style={s.eyebrow}>LAST SPOKEN</Text>
        <Text style={s.last}>{status.lastText || 'All quiet for now.'}</Text>
        <Text style={s.hint}>{status.lastAt ? new Date(status.lastAt).toLocaleString() : 'Your next message will appear here.'}</Text>
      </View>}
      <View style={s.footer}>
        <Pressable accessibilityRole="button" onPress={() => run(() => Listener.speechSettings())}><Text style={s.footerLink}>Voice settings</Text></Pressable>
        {status.paired && !editing && <Pressable accessibilityRole="button" onPress={() => setEditing(true)}><Text style={s.footerLink}>Change pairing</Text></Pressable>}
      </View>
      <Text style={s.fine}>Speech uses your media volume and current audio output. After a force-stop or phone restart, open the app and start listening again.</Text>
    </ScrollView>
  </SafeAreaView></SafeAreaProvider>;
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#101419' }, content: { padding: 24, paddingTop: 18, paddingBottom: 32, gap: 24 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, brand: { color: '#c9d2dd', fontSize: 11, fontWeight: '700', letterSpacing: 2 }, tag: { borderWidth: 1, borderColor: '#394338', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 }, tagText: { color: '#b7f36b', fontSize: 9, letterSpacing: 1.5 },
  title: { color: '#f2f4f8', fontSize: 42, lineHeight: 46, fontWeight: '600', letterSpacing: -1.7, marginTop: 12 }, subtitle: { color: '#9ba5b3', fontSize: 16, lineHeight: 25, marginTop: -10 },
  card: { backgroundColor: '#1c242c', borderRadius: 24, padding: 24, borderWidth: 1, borderColor: '#303b45', gap: 16 }, statusRow: { flexDirection: 'row', gap: 8, alignItems: 'center' }, dot: { width: 7, height: 7, borderRadius: 4 }, eyebrow: { color: '#aeb9c6', fontSize: 10, letterSpacing: 2, fontWeight: '700' }, state: { color: '#f2f4f8', fontSize: 27, fontWeight: '500' }, hint: { color: '#9ba5b3', fontSize: 13, lineHeight: 20 },
  primary: { backgroundColor: '#b7f36b', padding: 18, borderRadius: 14, alignItems: 'center', marginTop: 5 }, primaryText: { color: '#162211', fontSize: 16, fontWeight: '700' }, stop: { backgroundColor: '#303d48' }, disabled: { opacity: 0.4 }, link: { color: '#b7f36b', fontSize: 14, fontWeight: '600' }, linkButton: { alignItems: 'center', paddingVertical: 10 },
  notice: { borderLeftWidth: 2, borderLeftColor: '#b7f36b', paddingLeft: 16, gap: 8 }, noticeTitle: { color: '#e7ecdF', fontSize: 16, fontWeight: '600' }, section: { gap: 12 }, label: { color: '#c4cdd7', fontSize: 12 }, input: { color: '#f2f4f8', backgroundColor: '#1c242c', borderWidth: 1, borderColor: '#35404b', borderRadius: 12, padding: 14, fontSize: 14 }, secondary: { alignItems: 'center', borderWidth: 1, borderColor: '#596f42', padding: 16, borderRadius: 12 }, last: { color: '#e4e9ef', fontSize: 20, lineHeight: 29 }, footer: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#2a323c', paddingTop: 20 }, footerLink: { color: '#aab5c2', fontSize: 13, paddingVertical: 8 }, fine: { color: '#697687', fontSize: 11, lineHeight: 17, marginTop: -8 },
});
