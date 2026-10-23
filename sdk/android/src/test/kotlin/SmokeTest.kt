// Smoke test against a running MobiAd server: kotlinc ... && java -cp ... SmokeTestKt <baseUrl> <appId>
import io.mobiad.sdk.*

fun check(c: Boolean, m: String) { if (!c) { println("FAIL: $m"); kotlin.system.exitProcess(1) } else println("ok: $m") }

fun main(a: Array<String>) {
    val errors = mutableListOf<Throwable>()
    val ads = MobiAd(appId = a[1], baseUrl = a[0], onError = { errors.add(it) })
    check(runCatching { MobiAd("", "https://x") }.isFailure, "empty appId rejected")
    check(runCatching { MobiAd("a", "ftp://x") }.isFailure, "non-http baseUrl rejected")
    val ad = ads.requestAd(country = "us", consent = Consent(gdpr = false))
    check(ad != null, "ad served (title=${ad?.title})")
    ad!!
    check(ad.onClicked() == null && errors.isNotEmpty(), "click before impression refused")
    val vast = "<VAST><Ad><InLine><Creatives><Creative><Linear><MediaFiles><MediaFile type=\"video/mp4\" width=\"640\"><![CDATA[https://cdn.example.com/a.mp4?x=1]]></MediaFile><MediaFile type=\"application/x-mpegURL\"><![CDATA[https://cdn.example.com/a/master.m3u8]]></MediaFile><MediaFile type=\"video/mp4\">javascript:alert(1)</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>"
    check(Vast.mediaUrl(vast) == "https://cdn.example.com/a/master.m3u8", "VAST: adaptive stream preferred")
    check(Vast.mediaUrl(vast.replace("application/x-mpegURL", "video/webm").replace("master.m3u8", "a.webm")) == "https://cdn.example.com/a.mp4?x=1", "VAST: mp4 next")
    check(Vast.mediaUrl("<VAST><MediaFile>javascript:alert(1)</MediaFile></VAST>") == null && Vast.mediaUrl("not xml") == null, "VAST: only http(s) files, no file => null")
    val t0 = System.currentTimeMillis()
    check(ad.onShown(), "impression accepted")
    check(ad.onShown(), "impression idempotent")
    val landing = ad.onClicked()
    check(System.currentTimeMillis() - t0 >= 390, "click delayed to human scale")
    check(landing != null && landing.startsWith("http"), "click returns landing url: $landing")
    check(ad.onClicked() == null, "second click ignored")
    check(ad.onInstalled(), "install reported")
    val v = ads.requestAd(format = "video")
    check(v != null && v.videoUrl == "https://cdn.example.com/a.mp4" && v.durationSec == 12 && v.cta == "Go", "video creative fields")
    v!!
    check(!v.onVideoComplete(), "video complete before impression ignored")
    v.onShown()
    check(v.onVideoComplete(), "video complete reported")
    check(!v.onVideoComplete(), "video complete only once")
    check(v.onViewable(), "viewable reported after the impression")
    check(!v.onViewable(), "viewable only once")
    val rw = ads.requestAd(format = "rewarded", test = true, userId = "player-1", language = "en", deviceType = "phone", osVersion = "17.2", connection = "wifi", placementId = null)
    check(rw != null && rw.isTest && rw.rewardAmount == 1 && rw.rewardItem == "reward" && rw.videoUrl != null, "test-mode rewarded ad exposes reward info")
    val nat = ads.requestAd(format = "native", test = true)
    check(nat != null && nat.body != null && nat.sponsor == "MobiAd", "native assets (body, sponsor)")
    check(nat!!.onShown() && nat.onClicked() != null, "test ad impression and click")
    check(MobiAd("app_nope", a[0]).requestAd() == null, "unknown app => null, no throw")
    check(MobiAd(a[1], "http://127.0.0.1:1", retries = 0).requestAd() == null, "network failure => null, no throw")
    println("ALL OK")
}
