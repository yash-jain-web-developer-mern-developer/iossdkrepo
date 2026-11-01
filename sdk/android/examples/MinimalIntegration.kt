package io.mobiad.demo

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import io.mobiad.sdk.MobiAd

// The smallest possible integration: show one banner ad in your own screen. A reference to copy from; it is not built by CI
// and not registered in any manifest. Change the package to your own.
//   1. Copy sdk/android/src/main/kotlin/io/mobiad/sdk/MobiAd.kt into your app (keep the package io.mobiad.sdk).
//   2. Add <uses-permission android:name="android.permission.INTERNET" /> to AndroidManifest.xml.
//   3. For a plain-http demo server also add android:usesCleartextTraffic="true" on <application> (use https in production).
class MinimalIntegration : Activity() {
    // Your App ID is on the website: Publisher > Apps. The address: http://localhost:8080 with "adb reverse tcp:8080 tcp:8080", or your computer's Wi-Fi address (see docs/CONNECT_YOUR_APP.md).
    private val ads = MobiAd(appId = "PASTE_YOUR_APP_ID", baseUrl = "http://192.168.1.20:8080")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val headline = TextView(this).apply { text = "Loading ad..." }
        val button = Button(this).apply { visibility = View.GONE }
        setContentView(LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; addView(headline); addView(button) })

        Thread {                                                       // SDK calls block: never run them on the main thread
            val ad = ads.requestAd(format = "banner", country = "US")  // asks MobiAd to run the auction; null = no ad right now
            runOnUiThread {
                if (ad == null) { headline.text = "No ad right now"; return@runOnUiThread }
                headline.text = ad.title
                button.text = ad.cta ?: "Learn more"
                button.visibility = View.VISIBLE
                Thread { ad.onShown() }.start()                        // tell MobiAd the ad is really on screen: billing happens here, once
                button.setOnClickListener {
                    Thread {
                        val landing = ad.onClicked()                   // records the click and returns the advertiser's page (null if rejected)
                        runOnUiThread { landing?.let { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) } }
                    }.start()
                }
            }
        }.start()
    }
}
