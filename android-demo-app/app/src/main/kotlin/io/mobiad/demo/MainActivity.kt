package io.mobiad.demo

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

// Role picker. One small app that plays all four roles of the platform:
//   End user      -> a native game ("Puzzle Quest") that shows ads through the MobiAd Kotlin SDK
//   Advertiser / Publisher -> the web dashboard, signed in automatically with the fictional demo accounts (admin is web-only)
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("demo", Context.MODE_PRIVATE)
        val col = root()
        col.addView(text("MobiAd Demo", 30f, Palette.ink, true))
        col.addView(text("One app, four roles. Pick who you want to be.", 15f, Palette.muted), lp(top = 4, bottom = 14))

        val url = EditText(this).apply {
            setText(prefs.getString("base", Config.DEFAULT_BASE)); setTextColor(Palette.ink); setHintTextColor(Palette.muted); textSize = 14f
            inputType = InputType.TYPE_TEXT_VARIATION_URI; setSingleLine(true); background = round(Palette.surface, 12f, this@MainActivity, Palette.surface2); setPadding(dp(12), dp(10), dp(12), dp(10))
            contentDescription = "Server URL"; setSelectAllOnFocus(true) // tapping selects the old address, so typing replaces it
        }
        col.addView(text("Server", 12f, Palette.muted, true))
        col.addView(url, lp(bottom = 12))
        val appField = EditText(this).apply {
            setText(prefs.getString("app", Config.APP_ID)); setTextColor(Palette.ink); setHintTextColor(Palette.muted); textSize = 14f
            setSingleLine(true); background = round(Palette.surface, 12f, this@MainActivity, Palette.surface2); setPadding(dp(12), dp(10), dp(12), dp(10))
            contentDescription = "App ID"; setSelectAllOnFocus(true)
        }
        col.addView(text("App ID (website: Publisher > Apps; used by the End user game)", 12f, Palette.muted, true))
        col.addView(appField, lp(bottom = 12))
        fun go(cls: Class<*>, role: String) {
            val base = url.text.toString().trim().trimEnd('/')
            if (!Regex("^https?://[^/\\s:]+(:\\d{1,5})?$").matches(base)) { url.error = "Should look like http://192.168.1.20:8080 (the phone address the demo prints)"; url.requestFocus(); return }
            val app = appField.text.toString().trim().ifEmpty { Config.APP_ID }
            prefs.edit().putString("base", base).putString("app", app).apply()
            startActivity(Intent(this, cls).putExtra("base", base).putExtra("role", role).putExtra("app", app).putExtra("title", if (app == Config.APP_ID) "Puzzle Quest" else "Your app"))
        }
        fun roleCard(title: String, sub: String, tag: String, tagColor: Int, onClick: () -> Unit): View = card(
            LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; addView(text(title, 18f, Palette.ink, true), LinearLayout.LayoutParams(0, -2, 1f)); addView(pill(tag, tagColor)) },
            text(sub, 13f, Palette.muted).apply { setPadding(0, dp(4), 0, 0) },
        ).apply { setOnClickListener { onClick() }; isClickable = true }

        col.addView(roleCard("End user", "Play Puzzle Quest, a game that shows ads through the MobiAd SDK: banner, interstitial, native and rewarded.", "NATIVE", Palette.accent) { go(EndUserActivity::class.java, "enduser") }, lp(bottom = 10))
        col.addView(roleCard("Advertiser", "Create campaigns, track spend, conversions and invoices.", "DASHBOARD", Palette.brand) { go(ConsoleActivity::class.java, "advertiser") }, lp(bottom = 10))
        col.addView(roleCard("Publisher", "Manage apps, placements, rewarded video and payouts.", "DASHBOARD", Palette.brand) { go(ConsoleActivity::class.java, "publisher") }, lp(bottom = 10))
        col.addView(text("Admin is website-only by design: MobiAd staff use the web console, never a phone app. Demo build: fictional accounts and simulated data; the emulator reaches your computer at 10.0.2.2.", 12f, Palette.muted), lp(top = 6))

        setContentView(ScrollView(this).apply { setBackgroundColor(Palette.bg); addView(col) })
    }
}

object Config {
    const val DEFAULT_BASE = "http://10.0.2.2:8080"
    const val APP_ID = "app_puzzlequest"   // the publisher app registered by the demo server
    val CREDS = mapOf(
        "advertiser" to ("demo-advertiser@mobiad.test" to "Demo-Pass-Phrase-2026"),
        "publisher" to ("demo-publisher@mobiad.test" to "Demo-Pass-Phrase-2026"),
    )
}
