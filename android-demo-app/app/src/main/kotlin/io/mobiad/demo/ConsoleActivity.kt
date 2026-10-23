package io.mobiad.demo

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

// Opens the MobiAd dashboard for one role. It signs in with the fictional demo account, then hands the session token to the page,
// exactly as the dashboard's own login form would (the token lives in the page's sessionStorage).
class ConsoleActivity : Activity() {
    private var token: String? = null
    private var injected = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val base = intent.getStringExtra("base") ?: Config.DEFAULT_BASE
        val role = intent.getStringExtra("role") ?: "advertiser"
        val preset = Config.CREDS[role] ?: Config.CREDS.getValue("advertiser")
        // Optional extras let the same app sign in as any account (e.g. one created on the website during the demo).
        val email = intent.getStringExtra("email") ?: preset.first
        val pw = intent.getStringExtra("pw") ?: preset.second

        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Palette.bg) }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setBackgroundColor(Palette.surface); setPadding(dp(8), dp(34), dp(12), dp(8))
            addView(button("‹ Back", Palette.surface2) { finish() })
            addView(text("  " + role.replaceFirstChar { it.uppercase() } + " console", 17f, Palette.ink, true))
        }
        col.addView(bar)
        val web = WebView(this).apply {
            settings.javaScriptEnabled = true; settings.domStorageEnabled = true; setBackgroundColor(Palette.bg)
            webViewClient = object : WebViewClient() {
                override fun onPageStarted(v: WebView, u: String, f: Bitmap?) {}
                override fun onPageFinished(v: WebView, u: String) {
                    val t = token ?: return
                    if (!injected && u.contains("/app")) {
                        injected = true
                        v.evaluateJavascript("(function(){try{sessionStorage.setItem('t'," + JSONObject.quote(t) + ");}catch(e){} location.reload();})()", null)
                    }
                }
            }
        }
        col.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(col)

        Thread {
            try {
                val c = URL("$base/api/login").openConnection() as HttpURLConnection
                c.requestMethod = "POST"; c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.connectTimeout = 5000; c.readTimeout = 8000
                c.outputStream.use { it.write(JSONObject().put("email", email).put("password", pw).toString().toByteArray()) }
                val body = c.inputStream.bufferedReader().readText()
                token = JSONObject(body).getString("token")
            } catch (e: Exception) { runOnUiThread { web.loadData("<h3 style='font-family:sans-serif'>Cannot reach $base</h3><p>${e.message}</p>", "text/html", "utf-8") }; return@Thread }
            runOnUiThread { web.loadUrl("$base/app") }
        }.start()
    }
}
