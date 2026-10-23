// Smoke test against a running MobiAd server: swiftc Sources/MobiAd/MobiAd.swift Tests/smoke.swift -o smoke && ./smoke <baseUrl> <appId>
import Foundation

func check(_ c: Bool, _ m: String) { if !c { print("FAIL: \(m)"); exit(1) } else { print("ok: \(m)") } }

@main struct Smoke {
    static func main() async throws {
        let a = CommandLine.arguments
        let errs = ErrBox()
        let ads = try MobiAd(appId: a[2], baseUrl: a[1], onError: { e in errs.add(e) })
        check((try? MobiAd(appId: "", baseUrl: "https://x")) == nil, "empty appId rejected")
        check((try? MobiAd(appId: "a", baseUrl: "ftp://x")) == nil, "non-http baseUrl rejected")
        guard let ad = await ads.requestAd(country: "us", consent: Consent(gdpr: false)) else { print("FAIL: no ad"); exit(1) }
        print("ok: ad served (title=\(ad.title))")
        check(await ad.onClicked() == nil && errs.count > 0, "click before impression refused")
        let vast = "<VAST><MediaFiles><MediaFile type=\"video/mp4\"><![CDATA[https://cdn.example.com/a.mp4?x=1]]></MediaFile><MediaFile type=\"application/x-mpegURL\"><![CDATA[https://cdn.example.com/a/master.m3u8]]></MediaFile><MediaFile type=\"video/mp4\">javascript:alert(1)</MediaFile></MediaFiles></VAST>"
        check(Vast.mediaUrl(vast) == "https://cdn.example.com/a/master.m3u8", "VAST: adaptive stream preferred")
        check(Vast.mediaUrl("<VAST><MediaFile>javascript:alert(1)</MediaFile></VAST>") == nil && Vast.mediaUrl("not xml") == nil, "VAST: only http(s) files")
        let t0 = Date()
        check(await ad.onShown(), "impression accepted")
        check(await ad.onShown(), "impression idempotent")
        let landing = await ad.onClicked()
        check(Date().timeIntervalSince(t0) >= 0.39, "click delayed to human scale")
        check(landing?.hasPrefix("http") == true, "click returns landing url: \(landing ?? "nil")")
        check(await ad.onClicked() == nil, "second click ignored")
        check(await ad.onInstalled(), "install reported")
        guard let v = await ads.requestAd(format: "video") else { print("FAIL: no video ad"); exit(1) }
        check(v.videoUrl == "https://cdn.example.com/a.mp4" && v.durationSec == 12 && v.cta == "Go", "video creative fields")
        check(await v.onVideoComplete() == false, "video complete before impression ignored")
        await v.onShown()
        check(await v.onVideoComplete(), "video complete reported")
        check(await v.onVideoComplete() == false, "video complete only once")
        check(await v.onViewable(), "viewable reported after the impression")
        check(await v.onViewable() == false, "viewable only once")
        guard let rw = await ads.requestAd(format: "rewarded", language: "en", deviceType: "phone", osVersion: "17.2", connection: "wifi", userId: "player-1", test: true) else { print("FAIL: no rewarded test ad"); exit(1) }
        check(rw.isTest && rw.rewardAmount == 1 && rw.rewardItem == "reward" && rw.videoUrl != nil, "test-mode rewarded ad exposes reward info")
        guard let nat = await ads.requestAd(format: "native", test: true) else { print("FAIL: no native test ad"); exit(1) }
        check(nat.body != nil && nat.sponsor == "MobiAd", "native assets (body, sponsor)")
        check(await nat.onShown(), "test ad impression")
        check(await (try MobiAd(appId: "app_nope", baseUrl: a[1])).requestAd() == nil, "unknown app => nil, no throw")
        check(await (try MobiAd(appId: a[2], baseUrl: "http://127.0.0.1:1", retries: 0)).requestAd() == nil, "network failure => nil, no throw")
        print("ALL OK")
    }
}
final class ErrBox: @unchecked Sendable { private let l = NSLock(); private var n = 0; func add(_ e: Error) { l.lock(); n += 1; l.unlock() }; var count: Int { l.lock(); defer { l.unlock() }; return n } }
