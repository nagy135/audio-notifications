package expo.modules.audiolistener

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
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
  override fun definition() = ModuleDefinition {
    Name("AudioListener")
    Function("status") {
      val p = Store.prefs(context)
      mapOf("paired" to p.contains("token"), "running" to ListenerService.running,
        "state" to ListenerService.state, "lastText" to p.getString("lastText", ""),
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
      context.startService(Intent(context, ListenerService::class.java).setAction("TEST"))
    }
    Function("batterySettings") {
      context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    Function("speechSettings") {
      context.startActivity(Intent("com.android.settings.TTS_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}
