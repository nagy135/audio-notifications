package expo.modules.audiolistener

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class AudioListenerModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  private var voiceDiscovery: VoiceDiscovery? = null
  private fun voices() = voiceDiscovery ?: VoiceDiscovery(context.applicationContext).also { voiceDiscovery = it }
  override fun definition() = ModuleDefinition {
    Name("AudioListener")
    AsyncFunction("voices") { promise: Promise -> voices().load(promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("setVoice") { engineId: String, name: String -> voices().select(engineId, name) }.runOnQueue(Queues.MAIN)
    AsyncFunction("kokoroVoices") {
      val p = Store.prefs(context)
      check(p.contains("token")) { "Pair your phone to load Kokoro voices" }
      val client = OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).followRedirects(false).build()
      try {
        val request = Request.Builder().url(p.getString("url", "")!! + "/v1/voices")
          .header("Authorization", "Bearer ${Store.token(context)}").build()
        client.newCall(request).execute().use { response ->
          check(response.isSuccessful) { "Cannot load Kokoro voices. Check the server and Tailscale." }
          val body = JSONObject(response.body?.string() ?: "{}")
          val choices = body.getJSONArray("voices")
          mapOf("enabled" to body.getBoolean("enabled"), "available" to body.getBoolean("available"),
            "voices" to (0 until choices.length()).map { index ->
              val voice = choices.getJSONObject(index)
              mapOf("id" to voice.getString("id"), "name" to voice.getString("name"), "description" to voice.getString("description"))
            })
        }
      } finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    Function("setKokoroVoice") { voice: String ->
      require(voice.matches(Regex("[ab][fm]_[a-z]+"))) { "Invalid Kokoro voice" }
      Store.prefs(context).edit().putString("kokoroVoice", voice).commit()
    }
    Function("setUseKokoro") { enabled: Boolean -> Store.prefs(context).edit().putBoolean("useKokoro", enabled).commit() }
    OnDestroy { Handler(Looper.getMainLooper()).post { voiceDiscovery?.destroy(); voiceDiscovery = null } }
    Function("status") {
      val p = Store.prefs(context)
      mapOf("paired" to p.contains("token"), "running" to ListenerService.running,
        "speechBusy" to ListenerService.speechBusy, "useKokoro" to p.getBoolean("useKokoro", true),
        "kokoroVoice" to p.getString("kokoroVoice", "af_heart"), "lastVoice" to p.getString("lastVoice", ""),
        "state" to ListenerService.state, "speechEngine" to ListenerService.speechEngine, "lastText" to p.getString("lastText", ""),
        "lastAt" to p.getLong("lastAt", 0).toDouble(), "serverUrl" to p.getString("url", "https://nixpi.tail6650cb.ts.net:8444"),
        "batteryExempt" to context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName))
    }
    AsyncFunction("pair") { url: String, code: String ->
      check(!ListenerService.running) { "Stop listening before pairing again" }
      val base = url.trim().trimEnd('/')
      val uri = Uri.parse(base)
      require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path.isNullOrEmpty()) { "Use an HTTPS server URL with no path" }
      val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).followRedirects(false).build()
      val payload = JSONObject().put("code", code.trim()).put("name", Build.MODEL).toString()
      client.newCall(Request.Builder().url("$base/v1/pair").post(payload.toRequestBody("application/json".toMediaType())).build()).execute().use { response ->
        val body = JSONObject(response.body?.string() ?: "{}")
        check(response.isSuccessful) { body.optString("error", "Pairing failed") }
        Store.saveToken(context, body.getString("token"))
        Store.prefs(context).edit().putString("url", base).putString("deviceId", body.getString("deviceId")).commit()
      }
    }
    Function("start") {
      check(Store.token(context).isNotEmpty()) { "Pair your phone first" }
      Store.prefs(context).edit().putBoolean("enabled", true).commit()
      val intent = Intent(context, ListenerService::class.java)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
    }
    Function("stop") {
      Store.prefs(context).edit().putBoolean("enabled", false).commit()
      context.stopService(Intent(context, ListenerService::class.java))
    }
    Function("testSpeech") {
      check(ListenerService.running) { "Start listening first" }
      check(!ListenerService.speechBusy) { "Wait for the current message to finish" }
      context.startService(Intent(context, ListenerService::class.java).setAction("TEST"))
    }
    Function("testFallbackSpeech") {
      check(ListenerService.running) { "Start listening first" }
      check(!ListenerService.speechBusy) { "Wait for the current message to finish" }
      context.startService(Intent(context, ListenerService::class.java).setAction("TEST_FALLBACK"))
    }
    Function("batterySettings") {
      context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    Function("speechSettings") {
      context.startActivity(Intent("com.android.settings.TTS_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}
