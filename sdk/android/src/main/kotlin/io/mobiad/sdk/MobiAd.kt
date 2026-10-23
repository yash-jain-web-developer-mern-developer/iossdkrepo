// MobiAd Android SDK (Kotlin, no third-party dependencies; uses HttpURLConnection and the platform's org.json).
//
//   val ads = MobiAd(appId = "app_...", baseUrl = "https://ads.example.com")
//   // All network calls are blocking: call them from a background thread / coroutine dispatcher, never the main thread.
//   val ad = ads.requestAd(country = "US", consent = Consent(gdpr = false))
//   if (ad != null) { render(ad.title, ad.imageUrl); ad.onShown() /* when actually visible */; button.setOnClickListener { ad.onClicked()?.let(::openUrl) } }
//
// Same rules as the JS SDK, enforced here so integrators cannot generate invalid traffic:
//  - the impression is reported at most once, and only when you call onShown();
//  - a click is only reported after the impression and not sooner than minClickDelayMs;
//  - no device id is sent unless you pass one AND consent allows it (never when coppa / limitAdTracking is set).
// Tracking calls retry with backoff; a failure never throws into your UI (it is passed to onError).
package io.mobiad.sdk

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class Consent(
    val gdpr: Boolean = false,
    val gdprConsent: String? = null,
    val coppa: Boolean = false,
    val usPrivacy: String? = null,
    val limitAdTracking: Boolean = false,
)

class MobiAd(
    val appId: String,
    baseUrl: String,
    val timeoutMs: Int = 4000,
    val retries: Int = 2,
    val minClickDelayMs: Long = 500,
    val onError: (Throwable) -> Unit = {},
    private val clock: () -> Long = System::currentTimeMillis,
    private val sleeper: (Long) -> Unit = { Thread.sleep(it) },
) {
    val baseUrl: String = baseUrl.trimEnd('/')

    init {
        require(appId.isNotBlank()) { "appId is required" }
        require(Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(this.baseUrl)) { "baseUrl must be an http(s) URL" }
    }

    /** Returns an [Ad], or null on no fill (HTTP 204) or any network/server failure. Blocking. */
    fun requestAd(format: String = "banner", country: String? = null, deviceId: String? = null, consent: Consent? = null,
                  placementId: String? = null, language: String? = null, deviceType: String? = null, osVersion: String? = null, connection: String? = null, userId: String? = null, test: Boolean = false): Ad? {
        val body = JSONObject().put("appId", appId).put("format", format)
        if (!country.isNullOrBlank()) body.put("country", country.uppercase().take(2))
        if (consent != null) body.put("consent", consent.toJson())
        if (!deviceId.isNullOrEmpty()) body.put("deviceId", deviceId) // the server ignores it unless consent and app settings allow
        // Targeting signals; for rewarded ads pass YOUR user id so the signed server-to-server reward callback can name the player.
        mapOf("placementId" to placementId, "language" to language, "deviceType" to deviceType, "osVersion" to osVersion, "connection" to connection, "userId" to userId).forEach { (k, v) -> if (!v.isNullOrEmpty()) body.put(k, v) }
        if (test) body.put("test", true) // test mode: canned ads, no auction, no billing
        val r = try { http("$baseUrl/v1/ad", "POST", body.toString()) } catch (e: Exception) { onError(e); return null }
        if (r.status == 204) return null
        if (r.status !in 200..299) { onError(RuntimeException("ad request failed: HTTP ${r.status}")); return null }
        return try { Ad(this, JSONObject(r.body)) } catch (e: Exception) { onError(e); null }
    }

    internal class Resp(val status: Int, val location: String?, val body: String)

    internal fun now(): Long = clock()
    internal fun pause(ms: Long) = sleeper(ms)

    // Retries network errors and 5xx with 200 ms, 400 ms, ... backoff. Redirects are not followed (the click answers 302).
    internal fun http(url: String, method: String, json: String? = null, attempt: Int = 0): Resp {
        var c: HttpURLConnection? = null
        try {
            c = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = method; connectTimeout = timeoutMs; readTimeout = timeoutMs; instanceFollowRedirects = false
                if (json != null) { doOutput = true; setRequestProperty("Content-Type", "application/json"); outputStream.use { it.write(json.toByteArray()) } }
            }
            val code = c.responseCode
            if (code >= 500 && attempt < retries) throw RuntimeException("server error $code")
            val text = (if (code in 200..399) c.inputStream else c.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return Resp(code, c.getHeaderField("Location"), text)
        } catch (e: Exception) {
            if (attempt >= retries) throw e
            pause(200L shl attempt)
            return http(url, method, json, attempt + 1)
        } finally { c?.disconnect() }
    }

    private fun Consent.toJson() = JSONObject().apply {
        put("gdpr", gdpr); put("coppa", coppa); put("limitAdTracking", limitAdTracking)
        gdprConsent?.let { put("gdprConsent", it) }; usPrivacy?.let { put("usPrivacy", it) }
    }
}

/** Minimal VAST reader: the playable file of a partner video ad (adaptive HLS preferred, then MP4/WebM). Returns null when the markup has no usable https/http MediaFile. */
object Vast {
    private val file = Regex("""<MediaFile((?: [^>]*)?)>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*</MediaFile>""", RegexOption.IGNORE_CASE)
    fun mediaUrl(vast: String): String? {
        val all = file.findAll(vast).map { it.groupValues[1].lowercase() to it.groupValues[2] }.filter { it.second.startsWith("https://") || it.second.startsWith("http://") }.toList()
        return (all.firstOrNull { it.first.contains("mpegurl") || it.second.substringBefore('?').endsWith(".m3u8") } ?: all.firstOrNull { it.first.contains("mp4") || it.second.substringBefore('?').endsWith(".mp4") } ?: all.firstOrNull())?.second
    }
}

class Ad internal constructor(private val sdk: MobiAd, j: JSONObject) {
    private val cj: JSONObject = j.optJSONObject("creative") ?: JSONObject()
    val title: String = cj.optString("title")
    val imageUrl: String = cj.optString("image")
    /** Partner demand (markup = "html" or "vast"): render ONLY in a sandboxed WebView; clicks are handled by the markup. */
    val externalMarkup: String? = j.optJSONObject("external")?.optString("markup")
    val externalAdm: String? = j.optJSONObject("external")?.optString("adm")
    val isExternal: Boolean get() = externalAdm != null
    /** Partner VAST video: the file to play (see [Vast]); null for other ads. */
    val vastMediaUrl: String? get() = if (j0.optJSONObject("external")?.optString("markup") == "vast") externalAdm?.let { Vast.mediaUrl(it) } else null
    private val j0: JSONObject = j
    /** Rewarded slots: grant only after YOUR server receives the signed reward callback. */
    val rewardAmount: Int = j.optJSONObject("reward")?.optInt("amount", 0) ?: 0
    val rewardItem: String? = j.optJSONObject("reward")?.optString("item")
    val isTest: Boolean = j.optBoolean("test", false)
    val body: String? = cj.optString("body").ifEmpty { null }
    val iconUrl: String? = cj.optString("iconUrl").ifEmpty { null }
    val sponsor: String? = cj.optString("sponsor").ifEmpty { null }
    val rating: Double = cj.optDouble("rating", 0.0)
    /** Video ads: https URL and length. Playable ads: render [playableUrl] ONLY in a WebView with JavaScript but no file/content access and no top-level navigation. */
    val videoUrl: String? = cj.optString("videoUrl").ifEmpty { null }
    val durationSec: Int = cj.optInt("durationSec", 0)
    val playableUrl: String? = cj.optString("playableUrl").ifEmpty { null }
    val cta: String? = cj.optString("cta").ifEmpty { null }
    private val videoCompleteUrl: String? = j.optString("videoCompleteUrl").ifEmpty { null }
    private var completed = false
    private val impressionUrl = j.getString("impressionUrl")
    private val clickUrl = j.optString("clickUrl")
    private val viewableUrl = j.optString("viewableUrl").ifEmpty { null }
    private var viewable = false
    private val installUrl = j.optString("installUrl")
    private var shownAt = 0L
    private var clicked = false

    /** Call when the ad is actually visible. Idempotent. Returns whether the server accepted the report. */
    @Synchronized fun onShown(): Boolean {
        if (shownAt != 0L) return true
        shownAt = sdk.now()
        return try { sdk.http(impressionUrl, "GET").status in 200..299 } catch (e: Exception) { sdk.onError(e); false }
    }

    /** Call when the user taps. Returns the landing-page URL to open, or null if the SDK refused the click. Blocking. */
    @Synchronized fun onClicked(): String? {
        if (isExternal) return null // partner ads handle their own clicks
        if (shownAt == 0L) { sdk.onError(IllegalStateException("onClicked() before onShown(): ignored")); return null }
        if (clicked) return null
        val wait = sdk.minClickDelayMs - (sdk.now() - shownAt)
        if (wait > 0) sdk.pause(wait)
        clicked = true
        return try { sdk.http(clickUrl, "GET").location ?: clickUrl } catch (e: Exception) { sdk.onError(e); null }
    }

    /** Video ads: call when playback reaches the end. Idempotent; never billed. */
    @Synchronized fun onVideoComplete(): Boolean {
        val u = videoCompleteUrl ?: return false
        if (shownAt == 0L || completed) return false
        completed = true
        return try { sdk.http(u, "GET").status in 200..299 } catch (e: Exception) { sdk.onError(e); false }
    }

    /** Viewability: call once >= 50% of the ad was on screen for 1 s in a row (ViewabilityTracker does this for you). Idempotent; never billed. */
    @Synchronized fun onViewable(): Boolean {
        val u = viewableUrl ?: return false
        if (shownAt == 0L || viewable) return false
        viewable = true
        return try { sdk.http(u, "GET").status in 200..299 } catch (e: Exception) { sdk.onError(e); false }
    }

    /** Report an install attributed to this ad (call from your first-open flow). */
    fun onInstalled(): Boolean = try { sdk.http(installUrl, "GET").status in 200..299 } catch (e: Exception) { sdk.onError(e); false }
}
