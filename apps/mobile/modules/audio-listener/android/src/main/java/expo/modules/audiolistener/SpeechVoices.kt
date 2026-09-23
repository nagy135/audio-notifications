package expo.modules.audiolistener

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import expo.modules.kotlin.Promise
import java.util.Locale

object SpeechVoices {
  fun available(engine: TextToSpeech): List<Voice> = (engine.voices ?: emptySet())
    .filter { !it.features.orEmpty().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
    .sortedWith(compareBy<Voice>({ it.locale.language != Locale.getDefault().language },
      { it.locale.toLanguageTag() }, { it.isNetworkConnectionRequired }, { it.name }))

  // Re-read preferences before each utterance, without interrupting speech in progress.
  fun apply(engine: TextToSpeech, engineId: String, prefs: SharedPreferences): Boolean {
    val voices = available(engine)
    if (prefs.getString("voiceEngine", "") == engineId) {
      voices.firstOrNull { it.name == prefs.getString("voiceName", "") }?.let {
        if (engine.setVoice(it) == TextToSpeech.SUCCESS) return true
      }
    }
    val language = engine.setLanguage(Locale.getDefault())
    if (language < TextToSpeech.LANG_AVAILABLE && engine.setLanguage(Locale.US) < TextToSpeech.LANG_AVAILABLE) return false
    val locale = engine.voice?.locale ?: Locale.getDefault()
    voices.filter { it.locale.language == locale.language && !it.isNetworkConnectionRequired }
      .sortedBy { it.locale != locale }
      .firstOrNull()?.let { engine.setVoice(it) }
    return true
  }
}

/** Short-lived engine for discovery, including when the background listener is stopped. */
class VoiceDiscovery(private val context: Context) {
  private val handler = Handler(Looper.getMainLooper())
  private var engine: TextToSpeech? = null
  private val pending = mutableListOf<Promise>()
  private var engineId = ""
  private var voices = emptyList<Voice>()
  private var generation = 0
  private var destroyed = false
  private val timeout = Runnable { fail("Speech engine did not respond. Try again or open Android voice settings.") }

  fun load(promise: Promise) {
    if (destroyed) { promise.reject("ERR_VOICES", "Voice discovery closed", null); return }
    pending.add(promise)
    if (pending.size > 1) return
    val request = ++generation
    handler.postDelayed(timeout, 15000)
    try {
      engine = TextToSpeech(context) { result -> handler.post {
        if (request != generation || destroyed) return@post
        try {
          val tts = engine
          if (result != TextToSpeech.SUCCESS || tts == null) {
            fail("Speech engine unavailable. Install or enable an engine in Android voice settings.")
            return@post
          }
          engineId = tts.defaultEngine.orEmpty()
          voices = SpeechVoices.available(tts)
          val prefs = Store.prefs(context)
          val catalogue = mapOf(
            "engineId" to engineId,
            "engineLabel" to (tts.engines.firstOrNull { it.name == engineId }?.label ?: engineId),
            "selectedEngine" to prefs.getString("voiceEngine", ""),
            "selectedVoice" to prefs.getString("voiceName", ""),
            "voices" to voices.map { mapOf("id" to it.name, "language" to it.locale.toLanguageTag(),
              "label" to it.locale.getDisplayName(Locale.getDefault()), "online" to it.isNetworkConnectionRequired) }
          )
          val promises = pending.toList()
          close()
          promises.forEach { it.resolve(catalogue) }
        } catch (_: Exception) { fail("Could not read voices. Try again or open Android voice settings.") }
      } }
    } catch (_: Exception) { fail("Speech engine unavailable. Open Android voice settings.") }
  }

  fun select(selectedEngine: String, name: String) {
    require(name.isEmpty() || (selectedEngine == engineId && voices.any { it.name == name })) {
      "This voice is no longer available. Refresh the voice list."
    }
    check(Store.prefs(context).edit().putString("voiceEngine", if (name.isEmpty()) "" else selectedEngine)
      .putString("voiceName", name).commit()) { "Could not save your voice selection" }
  }

  private fun close() {
    generation++
    handler.removeCallbacks(timeout)
    engine?.shutdown(); engine = null
    pending.clear()
  }

  private fun fail(message: String) {
    val promises = pending.toList()
    close()
    promises.forEach { it.reject("ERR_VOICES", message, null) }
  }

  fun destroy() { destroyed = true; fail("Voice discovery closed") }
}
