package expo.modules.audiolistener

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.*
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import okhttp3.*
import org.json.JSONObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import java.util.concurrent.TimeUnit

class ListenerService : Service() {
  companion object {
    @Volatile var running = false
    @Volatile var state = "Stopped"
    @Volatile var speechEngine = ""
    @Volatile var speechBusy = false
    private const val CHANNEL = "audio-listener"
    private const val NOTICE = 7001
    private const val TAG = "AudioListener"
    private const val HANDSHAKE_TIMEOUT_MS = 30000L
  }
  private val handler = Handler(Looper.getMainLooper())
  // OkHttp clears the read timeout after upgrading to WebSocket. Keep the HTTP/TLS handshake bounded.
  private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).followRedirects(false).build()
  private val speechClient = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(35, TimeUnit.SECONDS).callTimeout(35, TimeUnit.SECONDS).followRedirects(false).build()
  private var socket: WebSocket? = null
  private var tts: TextToSpeech? = null
  private var ready = false
  private var ttsReady = false
  private var ttsInitialized = false
  private val ttsInitDeadline = SystemClock.elapsedRealtime() + 10000
  private var download: Call? = null
  private var audioFile: File? = null
  private var player: MediaPlayer? = null
  private var kokoroAttempted = false
  private var speaking = false
  private var utteranceId: String? = null
  private var playbackLabel = ""
  private var playbackDeadline = 0L
  private var destroyed = false
  private var retry = 1000L
  private var connectionAttempt = 0
  private var connectionStartedAt = 0L
  private var connected = false
  private var active: JSONObject? = null
    set(value) { field = value; speechBusy = value != null }
  private var wakeLock: PowerManager.WakeLock? = null
  private var focus: AudioFocusRequest? = null
  private var legacyFocusListener: AudioManager.OnAudioFocusChangeListener? = null
  private val audio by lazy { getSystemService(AudioManager::class.java) }
  private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
  private val reconnect = Runnable { connect() }
  private val connectionWatchdog = Runnable {
    if (!destroyed && !connected) {
      val pending = socket
      socket = null; pending?.cancel()
      recordConnectionError("Connection timed out after 30 seconds. Check Tailscale and the server address.")
      scheduleReconnect()
    }
  }
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
    cacheDir.listFiles()?.filter { it.name.startsWith("kokoro-") && it.extension == "wav" }?.forEach { it.delete() }
    // Delivery and Kokoro do not depend on an installed Android speech engine.
    ready = true; connect()
    tts = TextToSpeech(this) { result -> handler.post {
      if (destroyed) return@post
      ttsInitialized = true
      if (result != TextToSpeech.SUCCESS) { speak(); return@post }
      val engine = tts ?: return@post
      speechEngine = engine.defaultEngine.orEmpty()
      engine.setAudioAttributes(attributes)
      engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(id: String?) {}
        override fun onDone(id: String?) { handler.post { if (id != null && utteranceId == id) finish("spoken") } }
        @Deprecated("Android legacy callback") override fun onError(id: String?) { handler.post { if (id != null && utteranceId == id) finish("failed", "Speech engine error") } }
        override fun onError(id: String?, code: Int) { handler.post { if (id != null && utteranceId == id) finish("failed", "Speech engine error $code") } }
      })
      ttsReady = true; speak()
    } }
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "STOP" || !Store.prefs(this).getBoolean("enabled", false)) {
      Store.prefs(this).edit().putBoolean("enabled", false).commit(); stopSelf(); return START_NOT_STICKY
    }
    if ((intent?.action == "TEST" || intent?.action == "TEST_FALLBACK") && active == null) {
      active = JSONObject().put("id", "test-${System.currentTimeMillis()}").put("text", "Audio notifications are ready. You can lock your phone and I will keep listening.").put("expiresAt", System.currentTimeMillis() + 60000).put("local", true).put("androidOnly", intent.action == "TEST_FALLBACK")
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
    handler.removeCallbacks(connectionWatchdog)
    socket?.cancel(); socket = null
    connected = false
    connectionAttempt++; connectionStartedAt = SystemClock.elapsedRealtime()
    try {
      val p = Store.prefs(this)
      val url = p.getString("url", "")!!.replaceFirst("https://", "wss://") + "/v1/listen"
      update("Connecting…")
      val request = Request.Builder().url(url).header("Authorization", "Bearer ${Store.token(this)}").build()
      Log.i(TAG, "Connecting attempt=$connectionAttempt server=${request.url.host}:${request.url.port} deviceId=${p.getString("deviceId", "")}")
      socket = client.newWebSocket(request, object : WebSocketListener() {
        override fun onOpen(ws: WebSocket, response: Response) { handler.post {
          if (socket !== ws || destroyed) return@post
          handler.removeCallbacks(connectionWatchdog)
          connected = true; retry = 1000L
          Store.prefs(this@ListenerService).edit().remove("connectionError").remove("connectionErrorAt").apply()
          Log.i(TAG, "Connected attempt=$connectionAttempt elapsedMs=${SystemClock.elapsedRealtime() - connectionStartedAt}")
          if (active == null) update("Listening")
        } }
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
          handler.removeCallbacks(connectionWatchdog)
          socket = null; connected = false
          recordConnectionError(connectionFailure(t, response), t)
          if (response?.code == 401) { update("Pairing expired or revoked. Pair again."); return@post }
          if (response?.code == 429) retry = 60000L
          scheduleReconnect()
        } }
        override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, reason) }
        override fun onClosed(ws: WebSocket, code: Int, reason: String) { handler.post {
          if (socket !== ws || destroyed) return@post
          handler.removeCallbacks(connectionWatchdog)
          socket = null; connected = false
          recordConnectionError("Server closed the connection (code $code): ${reason.take(200)}")
          if (code == 4000 || code == 4001) { update("Device disconnected. Pair again."); return@post }
          scheduleReconnect()
        } }
      })
      handler.postDelayed(connectionWatchdog, HANDSHAKE_TIMEOUT_MS)
    } catch (error: Exception) {
      recordConnectionError(connectionFailure(error, null), error)
      scheduleReconnect()
    }
  }
  private fun connectionFailure(error: Throwable, response: Response?): String = when {
    response?.code == 401 -> "Server rejected this device's pairing (HTTP 401). Pair again."
    response?.code == 429 -> "Server rate limit reached (HTTP 429). Waiting one minute before retrying."
    response != null -> "Server rejected the connection (HTTP ${response.code}). Check the server address and server logs."
    error is UnknownHostException -> "Cannot resolve the server name. Check Tailscale DNS and Android Private DNS."
    error is SSLException -> "Secure connection failed. Check the phone's date/time and server certificate."
    error is SocketTimeoutException -> "Connection timed out. Check Tailscale and the server address."
    error is ConnectException -> "Cannot reach the server. Check Tailscale and the server address."
    else -> "${error.javaClass.simpleName}: ${error.message?.take(200) ?: "Connection failed"}"
  }
  private fun recordConnectionError(reason: String, error: Throwable? = null) {
    Store.prefs(this).edit().putString("connectionError", reason).putLong("connectionErrorAt", System.currentTimeMillis()).apply()
    Log.w(TAG, "Connection failed attempt=$connectionAttempt elapsedMs=${SystemClock.elapsedRealtime() - connectionStartedAt}: $reason", error)
  }
  private fun scheduleReconnect() {
    if (destroyed) return
    if (active == null) update("Reconnecting in ${retry / 1000} seconds…")
    val delay = retry + (0..500).random()
    Log.i(TAG, "Retrying connection in ${delay}ms")
    handler.removeCallbacks(reconnect); handler.postDelayed(reconnect, delay)
    retry = (retry * 2).coerceAtMost(30000L)
  }
  private fun speak() {
    val m = active ?: return
    if (!ready || destroyed || speaking || download != null) return
    handler.removeCallbacks(speakLater)
    if (m.optLong("expiresAt") <= System.currentTimeMillis()) { finish("expired"); return }
    if (audio.getStreamVolume(AudioManager.STREAM_MUSIC) == 0) { update("Media volume is muted — waiting"); handler.postDelayed(speakLater, 2000); return }
    if (!kokoroAttempted && !m.optBoolean("androidOnly") && Store.prefs(this).getBoolean("useKokoro", true)) {
      kokoroAttempted = true
      fetchKokoro(m)
      return
    }
    if (audioFile == null && !ttsInitialized) {
      if (SystemClock.elapsedRealtime() >= ttsInitDeadline) { finish("failed", "Android fallback engine did not initialize"); return }
      update("Preparing Android voice…")
      if (playbackDeadline == 0L) armWatchdog()
      handler.postDelayed(speakLater, 500)
      return
    }
    if (audioFile == null && (!ttsReady || tts?.let { SpeechVoices.apply(it, speechEngine, Store.prefs(this)) } != true)) {
      finish("failed", "No Android fallback voice available. Open voice settings."); return
    }
    val listener = AudioManager.OnAudioFocusChangeListener { change -> handler.post {
      if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
        stopPlayback(); abandonFocus(); handler.removeCallbacks(speakLater); handler.postDelayed(speakLater, 2000)
      }
    } }
    val granted = if (Build.VERSION.SDK_INT >= 26) {
      focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attributes).setOnAudioFocusChangeListener(listener, handler).build()
      audio.requestAudioFocus(focus!!)
    } else {
      legacyFocusListener = listener
      @Suppress("DEPRECATION")
      audio.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
    }
    if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { update("Waiting for audio"); abandonFocus(); handler.postDelayed(speakLater, 2000); return }
    speaking = true
    armWatchdog()
    val file = audioFile
    if (file != null) {
      playbackLabel = "Kokoro · ${m.optString("kokoroVoice", "af_heart").substringAfter('_').replaceFirstChar { it.uppercase() }}"
      update("Speaking · Kokoro")
      try {
        val media = MediaPlayer()
        player = media
        media.setAudioAttributes(attributes)
        media.setOnCompletionListener { if (player === it && active === m) finish("spoken") }
        media.setOnErrorListener { failed, _, _ ->
          if (player === failed && active === m) fallbackFromPlayback()
          true
        }
        media.setOnPreparedListener {
          if (player === it && active === m && !destroyed) {
            if (m.optLong("expiresAt") <= System.currentTimeMillis()) finish("expired")
            else try { it.start() } catch (_: Exception) { fallbackFromPlayback() }
          }
        }
        media.setDataSource(file.absolutePath)
        media.prepareAsync()
      } catch (_: Exception) { fallbackFromPlayback() }
    } else {
      playbackLabel = if (kokoroAttempted) "Android fallback" else "Android"
      update("Speaking · $playbackLabel")
      utteranceId = "${m.getString("id")}-${System.nanoTime()}"
      if (tts?.speak(m.getString("text"), TextToSpeech.QUEUE_FLUSH, Bundle(), utteranceId) != TextToSpeech.SUCCESS) finish("failed", "Could not start Android speech")
    }
  }

  private fun armWatchdog() {
    if (playbackDeadline == 0L) playbackDeadline = SystemClock.elapsedRealtime() + 150000
    handler.removeCallbacks(watchdog)
    handler.postDelayed(watchdog, (playbackDeadline - SystemClock.elapsedRealtime()).coerceAtLeast(1))
  }

  private fun fetchKokoro(m: JSONObject) {
    update("Preparing Kokoro voice…")
    armWatchdog()
    try {
      val prefs = Store.prefs(this)
      val voice = prefs.getString("kokoroVoice", "af_heart")!!
      m.put("kokoroVoice", voice)
      val payload = JSONObject().put("voice", voice)
      if (m.optBoolean("local")) payload.put("preview", true) else payload.put("messageId", m.getString("id"))
      val remaining = m.optLong("expiresAt") - System.currentTimeMillis()
      val request = Request.Builder().url(prefs.getString("url", "")!! + "/v1/speech")
        .header("Authorization", "Bearer ${Store.token(this)}")
        .post(payload.toString().toRequestBody("application/json".toMediaType())).build()
      val call = speechClient.newCall(request)
      call.timeout().timeout(remaining.coerceIn(1, 35000), TimeUnit.MILLISECONDS)
      download = call
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { handler.post {
          if (download === call && active === m && !destroyed) { download = null; speak() }
        } }
        override fun onResponse(call: Call, response: Response) {
          var file: File? = null
          try {
            response.use {
              check(it.isSuccessful && it.header("Content-Type")?.startsWith("audio/wav") == true)
              val body = requireNotNull(it.body)
              check(body.contentLength() <= 8 * 1024 * 1024)
              val target = File.createTempFile("kokoro-", ".wav", cacheDir)
              file = target
              target.outputStream().use { output -> body.byteStream().use { input ->
                val buffer = ByteArray(8192)
                var total = 0
                while (true) {
                  val count = input.read(buffer)
                  if (count < 0) break
                  total += count
                  check(total <= 8 * 1024 * 1024)
                  output.write(buffer, 0, count)
                }
                check(total >= 44)
              } }
            }
          } catch (_: Exception) { file?.delete(); file = null }
          val completed = file
          handler.post {
            if (download !== call || active !== m || destroyed) { completed?.delete(); return@post }
            download = null; audioFile = completed; speak()
          }
        }
      })
    } catch (_: Exception) { download = null; speak() }
  }

  private fun stopPlayback() {
    utteranceId = null
    tts?.stop()
    val media = player; player = null
    media?.release()
    speaking = false
  }

  private fun fallbackFromPlayback() {
    stopPlayback(); abandonFocus()
    audioFile?.delete(); audioFile = null
    speak()
  }
  private fun abandonFocus() {
    if (Build.VERSION.SDK_INT >= 26) focus?.let { audio.abandonAudioFocusRequest(it) }
    focus = null
    @Suppress("DEPRECATION")
    legacyFocusListener?.let { audio.abandonAudioFocus(it) }
    legacyFocusListener = null
  }
  private fun finish(status: String, error: String? = null) {
    val m = active ?: return
    handler.removeCallbacks(watchdog); handler.removeCallbacks(speakLater)
    active = null; stopPlayback(); abandonFocus()
    download?.cancel(); download = null
    audioFile?.delete(); audioFile = null
    kokoroAttempted = false; playbackDeadline = 0
    val p = Store.prefs(this)
    if (status == "spoken") p.edit().putString("lastText", m.optString("text")).putString("lastVoice", playbackLabel).putLong("lastAt", System.currentTimeMillis()).commit()
    if (!m.optBoolean("local")) {
      val ack = JSONObject().put("type", "ack").put("id", m.getString("id")).put("status", status)
      if (error != null) ack.put("error", error)
      val receipts = JSONObject(p.getString("receipts", "{}")!!)
      receipts.put(m.getString("id"), ack)
      while (receipts.length() > 200) receipts.remove(receipts.keys().next())
      p.edit().putString("receipts", receipts.toString()).commit()
      socket?.send(ack.toString())
    }
    update(if (status == "failed") "Speech failed — open voice settings" else if (!connected) "Waiting for server connection…" else "Listening")
  }
  override fun onDestroy() {
    destroyed = true; running = false; state = "Stopped"; speechEngine = ""
    connected = false
    Log.i(TAG, "Listener stopped")
    active = null
    handler.removeCallbacksAndMessages(null)
    download?.cancel(); download = null
    stopPlayback(); audioFile?.delete(); audioFile = null
    socket?.cancel(); socket = null; tts?.shutdown(); abandonFocus()
    if (wakeLock?.isHeld == true) wakeLock?.release()
    client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll()
    speechClient.dispatcher.executorService.shutdown(); speechClient.connectionPool.evictAll()
    stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
  }
}
