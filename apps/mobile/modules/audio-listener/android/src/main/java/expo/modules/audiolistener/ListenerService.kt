package expo.modules.audiolistener

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.*
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import okhttp3.*
import org.json.JSONObject
import org.json.JSONArray
import java.util.Locale
import java.util.concurrent.TimeUnit

class ListenerService : Service() {
  companion object {
    @Volatile var running = false
    @Volatile var state = "Stopped"
    private const val CHANNEL = "audio-listener"
    private const val NOTICE = 7001
  }
  private val handler = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
  private var socket: WebSocket? = null
  private var tts: TextToSpeech? = null
  private var ready = false
  private var destroyed = false
  private var retry = 1000L
  private var active: JSONObject? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var focus: AudioFocusRequest? = null
  private val audio by lazy { getSystemService(AudioManager::class.java) }
  private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
  private val reconnect = Runnable { connect() }
  private val speakLater = Runnable { speak() }
  private val watchdog = Runnable { finish("failed", "Speech timed out") }
  private val renewWake = object : Runnable {
    override fun run() {
      if (destroyed) return
      wakeLock?.acquire(10 * 60 * 1000L)
      handler.postDelayed(this, 5 * 60 * 1000L)
    }
  }
  override fun onBind(intent: Intent?) = null
  override fun onCreate() {
    super.onCreate(); running = true
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, "Listening status", NotificationManager.IMPORTANCE_LOW))
    val notification = notification("Starting listener…")
    if (Build.VERSION.SDK_INT >= 34) startForeground(NOTICE, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(NOTICE, notification)
    wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AudioNotifications:Listener").apply { setReferenceCounted(false) }
    renewWake.run()
    tts = TextToSpeech(this) { result -> handler.post {
      if (destroyed) return@post
      if (result != TextToSpeech.SUCCESS) { update("Speech engine unavailable. Open voice settings."); return@post }
      val engine = tts ?: return@post
      val lang = engine.setLanguage(Locale.getDefault())
      if (lang < TextToSpeech.LANG_AVAILABLE && engine.setLanguage(Locale.US) < TextToSpeech.LANG_AVAILABLE) {
        update("Install a voice in Android speech settings."); return@post
      }
      // Prefer an installed offline voice so speech works without cloud TTS.
      engine.voices?.firstOrNull { it.locale.language == engine.language?.language && !it.isNetworkConnectionRequired && !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }?.let { engine.voice = it }
      engine.setAudioAttributes(attributes)
      engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(id: String?) { handler.post { if (active?.optString("id") == id) update("Speaking") } }
        override fun onDone(id: String?) { handler.post { if (active?.optString("id") == id) finish("spoken") } }
        @Deprecated("Android legacy callback") override fun onError(id: String?) { handler.post { if (active?.optString("id") == id) finish("failed", "Speech engine error") } }
        override fun onError(id: String?, code: Int) { handler.post { if (active?.optString("id") == id) finish("failed", "Speech engine error $code") } }
      })
      ready = true; connect(); speak()
    } }
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "STOP" || !Store.prefs(this).getBoolean("enabled", false)) {
      Store.prefs(this).edit().putBoolean("enabled", false).commit(); stopSelf(); return START_NOT_STICKY
    }
    if (intent?.action == "TEST" && active == null) {
      active = JSONObject().put("id", "test-${System.currentTimeMillis()}").put("text", "Audio notifications are ready. You can lock your phone and I will keep listening.").put("expiresAt", System.currentTimeMillis() + 60000).put("local", true)
      speak()
    }
    return START_STICKY
  }
  private fun notification(text: String): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)!!
    val open = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val stop = PendingIntent.getService(this, 1, Intent(this, ListenerService::class.java).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    return builder.setContentTitle("Audio Notifications").setContentText(text).setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
      .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE)
      .addAction(Notification.Action.Builder(null, "Stop listening", stop).build()).build()
  }
  private fun update(value: String) {
    if (destroyed) return
    state = value; getSystemService(NotificationManager::class.java).notify(NOTICE, notification(value))
  }
  private fun connect() {
    if (destroyed || !ready) return
    handler.removeCallbacks(reconnect)
    socket?.cancel(); socket = null
    try {
      val p = Store.prefs(this)
      val url = p.getString("url", "")!!.replaceFirst("https://", "wss://") + "/v1/listen"
      update("Connecting…")
      val request = Request.Builder().url(url).header("Authorization", "Bearer ${Store.token(this)}").build()
      socket = client.newWebSocket(request, object : WebSocketListener() {
        override fun onOpen(ws: WebSocket, response: Response) { handler.post { if (socket === ws && !destroyed) { retry = 1000L; update(if (active == null) "Listening" else "Speaking") } } }
        override fun onMessage(ws: WebSocket, text: String) { handler.post {
          if (socket !== ws || destroyed) return@post
          try {
            val m = JSONObject(text); if (m.optString("type") != "message") return@post
            val id = m.getString("id")
            val receipts = JSONObject(Store.prefs(this@ListenerService).getString("receipts", "{}")!!)
            if (receipts.has(id)) { ws.send(receipts.getJSONObject(id).toString()); return@post }
            if (active?.optString("id") == id) return@post
            // The server sends one unacknowledged message at a time. A local voice test may still be playing.
            if (active != null) { ws.close(1000, "Busy; retry"); return@post }
            active = m; speak()
          } catch (_: Exception) { update("Invalid server message"); ws.close(1008, "Invalid message") }
        } }
        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) { handler.post {
          if (socket !== ws || destroyed) return@post
          socket = null
          if (response?.code == 401) { update("Pairing expired or revoked. Pair again."); return@post }
          scheduleReconnect()
        } }
        override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, reason) }
        override fun onClosed(ws: WebSocket, code: Int, reason: String) { handler.post {
          if (socket !== ws || destroyed) return@post
          socket = null
          if (code == 4000 || code == 4001) { update("Device disconnected. Pair again."); return@post }
          scheduleReconnect()
        } }
      })
    } catch (_: Exception) { scheduleReconnect() }
  }
  private fun scheduleReconnect() {
    update("Reconnecting — check Tailscale")
    handler.removeCallbacks(reconnect); handler.postDelayed(reconnect, retry + (0..500).random())
    retry = (retry * 2).coerceAtMost(30000L)
  }
  private fun speak() {
    val m = active ?: return
    if (!ready || destroyed) return
    if (m.optLong("expiresAt") <= System.currentTimeMillis()) { finish("expired"); return }
    if (audio.getStreamVolume(AudioManager.STREAM_MUSIC) == 0) { update("Media volume is muted — waiting"); handler.postDelayed(speakLater, 2000); return }
    val listener = AudioManager.OnAudioFocusChangeListener { change -> handler.post {
      if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
        tts?.stop(); handler.removeCallbacks(watchdog); abandonFocus(); handler.removeCallbacks(speakLater); handler.postDelayed(speakLater, 2000)
      }
    } }
    val granted = if (Build.VERSION.SDK_INT >= 26) {
      focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attributes).setOnAudioFocusChangeListener(listener, handler).build()
      audio.requestAudioFocus(focus!!)
    } else { @Suppress("DEPRECATION") audio.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK) }
    if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { update("Waiting for audio"); abandonFocus(); handler.postDelayed(speakLater, 2000); return }
    update("Speaking")
    handler.postDelayed(watchdog, 150000)
    if (tts?.speak(m.getString("text"), TextToSpeech.QUEUE_FLUSH, Bundle(), m.getString("id")) != TextToSpeech.SUCCESS) finish("failed", "Could not start speech")
  }
  private fun abandonFocus() {
    if (Build.VERSION.SDK_INT >= 26) focus?.let { audio.abandonAudioFocusRequest(it) }
    focus = null
  }
  private fun finish(status: String, error: String? = null) {
    val m = active ?: return
    handler.removeCallbacks(watchdog); handler.removeCallbacks(speakLater)
    active = null; if (status != "spoken") tts?.stop(); abandonFocus()
    val p = Store.prefs(this)
    if (status == "spoken") p.edit().putString("lastText", m.optString("text")).putLong("lastAt", System.currentTimeMillis()).commit()
    if (!m.optBoolean("local")) {
      val ack = JSONObject().put("type", "ack").put("id", m.getString("id")).put("status", status)
      if (error != null) ack.put("error", error)
      val receipts = JSONObject(p.getString("receipts", "{}")!!)
      receipts.put(m.getString("id"), ack)
      while (receipts.length() > 200) receipts.remove(receipts.keys().next())
      p.edit().putString("receipts", receipts.toString()).commit()
      socket?.send(ack.toString())
    }
    update(if (status == "failed") "Speech failed — open voice settings" else if (socket == null) "Reconnecting — check Tailscale" else "Listening")
  }
  override fun onDestroy() {
    destroyed = true; running = false; state = "Stopped"
    handler.removeCallbacksAndMessages(null)
    socket?.cancel(); socket = null; tts?.stop(); tts?.shutdown(); abandonFocus()
    if (wakeLock?.isHeld == true) wakeLock?.release()
    client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll()
    stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
  }
}
