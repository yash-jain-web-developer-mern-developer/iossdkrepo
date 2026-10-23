package io.mobiad.demo

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import io.mobiad.sdk.Ad
import io.mobiad.sdk.Consent
import io.mobiad.sdk.MobiAd
import io.mobiad.sdk.ViewabilityTracker
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

// "Puzzle Quest": a tiny game whose only job is to show how a real app uses the MobiAd Kotlin SDK as the END USER's app.
// Everything the SDK does (request, impression, click, video completion) is listed in the on-screen "SDK activity" log.
class EndUserActivity : Activity() {
    private lateinit var sdk: MobiAd
    private val io = Executors.newCachedThreadPool()
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var coinsView: TextView
    private lateinit var levelView: TextView
    private lateinit var bannerSlot: FrameLayout
    private lateinit var nativeSlot: LinearLayout
    private lateinit var logView: TextView
    private lateinit var testMode: Switch
    private val logLines = ArrayDeque<String>()
    private var coins = 120
    private var level = 1
    private var plays = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val base = intent.getStringExtra("base") ?: Config.DEFAULT_BASE
        val appId = intent.getStringExtra("app") ?: Config.APP_ID
        sdk = MobiAd(appId = appId, baseUrl = base, onError = { log("SDK error: " + (it.message ?: it.javaClass.simpleName)) })

        val col = root().apply { setPadding(dp(16), dp(34), dp(16), dp(10)) }
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        head.addView(button("‹", Palette.surface2) { finish() })
        val gameTitle = intent.getStringExtra("title") ?: "Puzzle Quest"
        head.addView(text("  $gameTitle", if (gameTitle.length > 11) 17f else 22f, Palette.ink, true), LinearLayout.LayoutParams(0, -2, 1f))
        coinsView = pill("● 120 coins", Palette.warn).apply { setTextColor(Color.BLACK) }
        head.addView(coinsView)
        col.addView(head, lp(bottom = 8))

        val feed = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        levelView = text("Level 1", 28f, Palette.ink, true)
        feed.addView(card(levelView, text("Match three gems to clear the board.", 14f, Palette.muted),
            LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(button("Play level") { playLevel() }, lp(w = 0).also { (it as LinearLayout.LayoutParams).weight = 1f })
                addView(button("Free coins", Palette.accent) { rewarded() }, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(8) })
            }.also { it.setPadding(0, dp(12), 0, 0) }), lp(bottom = 10))
        nativeSlot = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        feed.addView(nativeSlot, lp(bottom = 10))
        testMode = Switch(this).apply { text = "Test mode (canned ads, no billing)"; setTextColor(Palette.muted); textSize = 13f }
        feed.addView(testMode, lp(bottom = 6))
        logView = text("", 11f, Palette.muted).apply { typeface = android.graphics.Typeface.MONOSPACE }
        feed.addView(card(text("SDK activity", 13f, Palette.accent, true), logView, pad = 12), lp(bottom = 8))
        col.addView(ScrollView(this).apply { addView(feed) }, LinearLayout.LayoutParams(-1, 0, 1f))

        bannerSlot = FrameLayout(this).apply { minimumHeight = dp(76) }
        col.addView(bannerSlot, lp(top = 6))
        setContentView(col)

        log("MobiAd SDK ready (app $appId)")
        loadBanner(); loadNative()
    }

    // ---- ad requests ------------------------------------------------------------------------------------------------
    private fun request(format: String, then: (Ad?) -> Unit) = io.execute {
        val ad = sdk.requestAd(format = format, country = "US", language = "en", deviceType = "phone", osVersion = Build.VERSION.RELEASE, connection = "wifi",
            userId = if (format == "rewarded") "player-42" else null, consent = Consent(gdpr = false), test = testMode.isChecked)
        log("request $format -> " + if (ad == null) "no fill" else if (ad.isExternal) "partner ad" else "\"" + ad.title + "\"" + if (ad.isTest) " (test)" else "")
        ui.post { then(ad) }
    }
    private val trackers = mutableListOf<ViewabilityTracker>()
    // Impression when the ad is on screen; "viewable" only once >= 50% of it stayed visible for 1 s (measured by the SDK's ViewabilityTracker).
    private fun shown(ad: Ad, view: View? = null) {
        io.execute { log("impression " + if (ad.onShown()) "reported ✓" else "failed") }
        if (view != null) trackers += ViewabilityTracker(view) { io.execute { log("viewable (50% for 1 s) " + if (ad.onViewable()) "reported ✓" else "not applicable") } }.also { it.start() }
    }
    override fun onDestroy() { trackers.forEach { it.stop() }; super.onDestroy() }

    private fun loadBanner() = request("banner") { ad ->
        bannerSlot.removeAllViews()
        if (ad == null) { bannerSlot.addView(text("No ad available", 13f, Palette.muted)); return@request }
        val v = adCard(ad, compact = true); bannerSlot.addView(v); shown(ad, v)
    }
    private fun loadNative() = request("native") { ad ->
        nativeSlot.removeAllViews()
        if (ad == null) return@request
        val v = adCard(ad, compact = false); nativeSlot.addView(v); shown(ad, v)
    }

    private fun playLevel() {
        level++; plays++; levelView.text = "Level $level"
        log("level cleared")
        if (plays % 2 == 0) interstitial() else Toast.makeText(this, "Level cleared!", Toast.LENGTH_SHORT).show()
    }

    private fun interstitial() = request("interstitial") { ad ->
        if (ad == null) return@request
        val d = Dialog(this, android.R.style.Theme_Material_NoActionBar_Fullscreen)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Palette.bg); gravity = Gravity.CENTER; setPadding(dp(24), dp(24), dp(24), dp(24)) }
        val adView = adCard(ad, compact = false); col.addView(adView, lp(bottom = 18))
        val close = button("Close in 3", Palette.surface2) {}.apply { isEnabled = false }
        col.addView(close)
        d.setContentView(col); d.show(); shown(ad, adView)
        object : Runnable { var n = 3
            override fun run() { if (n <= 0) { close.text = "Close ✕"; close.isEnabled = true; close.setOnClickListener { d.dismiss() } } else { close.text = "Close in $n"; n--; ui.postDelayed(this, 1000) } } }.run()
    }

    private fun rewarded() = request("rewarded") { ad ->
        if (ad == null) { Toast.makeText(this, "No reward ad available", Toast.LENGTH_SHORT).show(); return@request }
        val d = Dialog(this, android.R.style.Theme_Material_NoActionBar_Fullscreen)
        val seconds = if (ad.durationSec > 0) ad.durationSec else 5
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.BLACK); gravity = Gravity.CENTER; setPadding(dp(28), dp(28), dp(28), dp(28)) }
        col.addView(pill("REWARDED VIDEO", Palette.brand))
        col.addView(text(if (ad.isExternal) "Partner video ad" else ad.title, 24f, Color.WHITE, true).apply { gravity = Gravity.CENTER }, lp(top = 14))
        val video = PlayerView(this).apply { useController = false; setBackgroundColor(Color.BLACK) }
        val player = ExoPlayer.Builder(this).build().also { video.player = it }
        col.addView(video, LinearLayout.LayoutParams(-1, dp(200)).apply { topMargin = dp(10); bottomMargin = dp(12) })
        val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = seconds * 10 }
        col.addView(bar, lp(bottom = 8))
        val status = text("Watch to the end to earn ${ad.rewardAmount.takeIf { it > 0 } ?: 1} ${ad.rewardItem ?: "reward"}", 14f, Palette.ink).apply { gravity = Gravity.CENTER }
        col.addView(status)
        val claim = button("Claim reward", Palette.ok) {}.apply { isEnabled = false; visibility = View.INVISIBLE }
        col.addView(claim, lp(top = 16))
        d.setCancelable(false); d.setContentView(col); d.show(); shown(ad, video)
        var finished = false
        val finish = {
            if (!finished) {
                finished = true; status.text = "Video finished"
                io.execute { log("video completion " + if (ad.onVideoComplete()) "reported ✓" else "not applicable") }
                claim.visibility = View.VISIBLE; claim.isEnabled = true
                claim.setOnClickListener {
                    val n = ad.rewardAmount.takeIf { it > 0 } ?: 1; coins += n; coinsView.text = "● $coins coins"; log("reward granted: +$n (a real app waits for the signed server callback)"); d.dismiss()
                }
            }
        }
        val url = ad.vastMediaUrl ?: ad.videoUrl // partner VAST: the file named inside the markup; own ads: the creative's video
        d.setOnDismissListener { player.release() }
        if (url != null) { // real playback with ExoPlayer (MP4 or adaptive HLS): the reward is only offered after the player reports the end
            log((if (url.substringBefore('?').endsWith(".m3u8")) "playing HLS stream " else "playing video ") + url.takeLast(28))
            player.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_READY && bar.max != player.duration.toInt().coerceAtLeast(1) && player.duration > 0) { bar.max = player.duration.toInt(); log("video ready, ${player.duration / 1000.0}s"); object : Runnable { override fun run() { if (!finished) { bar.progress = player.currentPosition.toInt(); ui.postDelayed(this, 100) } } }.run() }
                    if (state == Player.STATE_ENDED) { bar.progress = bar.max; finish() }
                }
                override fun onPlayerError(e: PlaybackException) { log("video error ${e.errorCodeName}: cannot play"); status.text = "Video could not be played: no reward"; claim.visibility = View.VISIBLE; claim.text = "Close"; claim.isEnabled = true; claim.setOnClickListener { d.dismiss() } }
            })
            player.setMediaItem(MediaItem.fromUri(url)); player.prepare(); player.playWhenReady = true
        } else { // partner VAST markup has no direct file: simulated timer
            video.visibility = View.GONE
            var t = 0
            object : Runnable { override fun run() { t++; bar.progress = t; if (t >= seconds * 10) finish() else ui.postDelayed(this, 100) } }.run()
        }
    }

    // ---- ad rendering -----------------------------------------------------------------------------------------------
    private fun adCard(ad: Ad, compact: Boolean): View {
        if (ad.isExternal) { // partner markup is third-party code: render it in a locked-down WebView (no JavaScript)
            val w = WebView(this).apply { settings.javaScriptEnabled = false; setBackgroundColor(Palette.surface); loadDataWithBaseURL(null, ad.externalAdm ?: "", "text/html", "utf-8", null) }
            return card(pill("AD · PARTNER", Palette.muted), FrameLayout(this).apply { addView(w, FrameLayout.LayoutParams(-1, dp(60))) }, pad = 10)
        }
        val badge = TextView(this).apply { text = (ad.title.firstOrNull() ?: 'A').toString(); textSize = 22f; setTextColor(Color.WHITE); gravity = Gravity.CENTER; background = round(Palette.brand, 14f, this@EndUserActivity) }
        val info = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(LinearLayout(this@EndUserActivity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                addView(pill(if (ad.isTest) "TEST AD" else "AD", Palette.muted)); if (ad.sponsor != null) addView(text("  " + ad.sponsor, 12f, Palette.muted)) })
            addView(text(ad.title, if (compact) 15f else 18f, Palette.ink, true))
            if (!compact && ad.body != null) addView(text(ad.body!!, 13f, Palette.muted))
            if (!compact && ad.rating > 0) addView(text("★ " + ad.rating, 13f, Palette.warn))
        }
        val cta = button(ad.cta ?: "Learn more") {
            io.execute { val url = ad.onClicked(); log(if (url == null) "click ignored" else "click reported ✓ → " + url.take(48)); if (url != null) ui.post { Toast.makeText(this, "Opens: " + url.take(60), Toast.LENGTH_SHORT).show() } }
        }
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        row.addView(badge, LinearLayout.LayoutParams(dp(54), dp(54)).apply { rightMargin = dp(12) })
        row.addView(info, LinearLayout.LayoutParams(0, -2, 1f)); if (compact) row.addView(cta)
        return card(*(if (compact) arrayOf<View>(row) else arrayOf<View>(row, cta.also { (it.layoutParams as? ViewGroup.MarginLayoutParams) })), pad = 12)
    }

    private fun log(line: String) {
        val stamp = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        ui.post { logLines.addFirst("$stamp  $line"); while (logLines.size > 9) logLines.removeLast(); logView.text = logLines.joinToString("\n") }
    }
}
