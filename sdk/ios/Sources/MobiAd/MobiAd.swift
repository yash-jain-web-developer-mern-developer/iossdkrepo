// MobiAd iOS SDK (Swift 5.5+, no dependencies; URLSession + async/await).
//
//   let ads = try MobiAd(appId: "app_...", baseUrl: "https://ads.example.com")
//   if let ad = await ads.requestAd(country: "US", consent: Consent(gdpr: false)) {
//       render(ad.title, ad.imageUrl); await ad.onShown()   // when actually visible
//       // on tap:  if let url = await ad.onClicked() { open(url) }
//   }
//
// Same rules as the JS SDK: impression reported once and only via onShown(); a click is accepted only after the
// impression and not sooner than minClickDelay; no device id is sent unless you pass one AND consent allows it.
// Tracking calls retry with backoff; a failure never throws into your UI (it is passed to onError).
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct Consent: Sendable {
    public var gdpr = false, coppa = false, limitAdTracking = false
    public var gdprConsent: String?, usPrivacy: String?
    public init(gdpr: Bool = false, gdprConsent: String? = nil, coppa: Bool = false, usPrivacy: String? = nil, limitAdTracking: Bool = false) {
        self.gdpr = gdpr; self.gdprConsent = gdprConsent; self.coppa = coppa; self.usPrivacy = usPrivacy; self.limitAdTracking = limitAdTracking
    }
    var json: [String: Any] {
        var d: [String: Any] = ["gdpr": gdpr, "coppa": coppa, "limitAdTracking": limitAdTracking]
        if let g = gdprConsent { d["gdprConsent"] = g }
        if let u = usPrivacy { d["usPrivacy"] = u }
        return d
    }
}

public enum MobiAdError: Error { case invalidConfig(String), http(Int), badResponse, clickBeforeShown }

public final class MobiAd: @unchecked Sendable {
    public let appId: String, baseUrl: String
    let timeout: TimeInterval, retries: Int, minClickDelay: TimeInterval
    let onError: @Sendable (Error) -> Void
    let session: URLSession

    public init(appId: String, baseUrl: String, timeout: TimeInterval = 4, retries: Int = 2, minClickDelay: TimeInterval = 0.5,
                session: URLSession? = nil, onError: @escaping @Sendable (Error) -> Void = { _ in }) throws {
        guard !appId.isEmpty else { throw MobiAdError.invalidConfig("appId is required") }
        guard baseUrl.lowercased().hasPrefix("http://") || baseUrl.lowercased().hasPrefix("https://") else { throw MobiAdError.invalidConfig("baseUrl must be an http(s) URL") }
        self.appId = appId; self.baseUrl = baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl
        self.timeout = timeout; self.retries = retries; self.minClickDelay = minClickDelay; self.onError = onError
        if let s = session { self.session = s } else {
            let cfg = URLSessionConfiguration.ephemeral; cfg.timeoutIntervalForRequest = timeout
            self.session = URLSession(configuration: cfg, delegate: NoRedirect.shared, delegateQueue: nil)
        }
    }

    /// Returns an `Ad`, or nil on no fill (HTTP 204) or any network/server failure.
    public func requestAd(format: String = "banner", country: String? = nil, deviceId: String? = nil, consent: Consent? = nil,
                          placementId: String? = nil, language: String? = nil, deviceType: String? = nil, osVersion: String? = nil, connection: String? = nil, userId: String? = nil, test: Bool = false) async -> Ad? {
        var body: [String: Any] = ["appId": appId, "format": format]
        if let c = country, !c.isEmpty { body["country"] = String(c.uppercased().prefix(2)) }
        if let c = consent { body["consent"] = c.json }
        if let d = deviceId, !d.isEmpty { body["deviceId"] = d } // the server ignores it unless consent and app settings allow
        // Targeting signals; for rewarded ads pass YOUR user id so the signed server-to-server reward callback can name the player.
        for (k, v) in ["placementId": placementId, "language": language, "deviceType": deviceType, "osVersion": osVersion, "connection": connection, "userId": userId] { if let v = v, !v.isEmpty { body[k] = v } }
        if test { body["test"] = true } // test mode: canned ads, no auction, no billing
        do {
            let data = try JSONSerialization.data(withJSONObject: body)
            let (status, _, bytes) = try await http("\(baseUrl)/v1/ad", method: "POST", body: data)
            if status == 204 { return nil }
            guard (200..<300).contains(status) else { onError(MobiAdError.http(status)); return nil }
            guard let j = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], let ad = Ad(sdk: self, json: j) else { onError(MobiAdError.badResponse); return nil }
            return ad
        } catch { onError(error); return nil }
    }

    /// Retries network errors and 5xx with 200 ms, 400 ms, ... backoff. Redirects are not followed (the click answers 302).
    func http(_ url: String, method: String, body: Data? = nil, attempt: Int = 0) async throws -> (Int, String?, Data) {
        guard let u = URL(string: url) else { throw MobiAdError.badResponse }
        var req = URLRequest(url: u, timeoutInterval: timeout); req.httpMethod = method
        if let b = body { req.httpBody = b; req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        do {
            let (data, resp) = try await fetch(req)
            guard let h = resp as? HTTPURLResponse else { throw MobiAdError.badResponse }
            if h.statusCode >= 500 && attempt < retries { throw MobiAdError.http(h.statusCode) }
            return (h.statusCode, h.value(forHTTPHeaderField: "Location"), data)
        } catch {
            if attempt >= retries { throw error }
            try await Task.sleep(nanoseconds: UInt64(200_000_000) << UInt64(attempt))
            return try await http(url, method: method, body: body, attempt: attempt + 1)
        }
    }
}

extension MobiAd {
    // Continuation-based so it also works where URLSession has no async API (iOS 13, swift-corelibs on Linux).
    func fetch(_ req: URLRequest) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation { cont in
            session.dataTask(with: req) { d, r, e in
                if let e = e { cont.resume(throwing: e) } else if let r = r { cont.resume(returning: (d ?? Data(), r)) } else { cont.resume(throwing: MobiAdError.badResponse) }
            }.resume()
        }
    }
}

final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = NoRedirect()
    func urlSession(_ s: URLSession, task: URLSessionTask, willPerformHTTPRedirection r: HTTPURLResponse, newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Minimal VAST reader: the playable file of a partner video ad (adaptive HLS preferred, then MP4/WebM). http(s) files only; nil when there is none.
public enum Vast {
    public static func mediaUrl(_ vast: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: #"<MediaFile((?: [^>]*)?)>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*</MediaFile>"#, options: [.caseInsensitive]) else { return nil }
        let ns = vast as NSString
        let files: [(String, String)] = re.matches(in: vast, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            let attrs = ns.substring(with: m.range(at: 1)).lowercased(), url = ns.substring(with: m.range(at: 2))
            return url.hasPrefix("https://") || url.hasPrefix("http://") ? (attrs, url) : nil
        }
        func ext(_ u: String) -> String { (u.split(separator: "?").first.map(String.init) ?? u).lowercased() }
        return (files.first { $0.0.contains("mpegurl") || ext($0.1).hasSuffix(".m3u8") } ?? files.first { $0.0.contains("mp4") || ext($0.1).hasSuffix(".mp4") } ?? files.first)?.1
    }
}


public actor Ad {
    public nonisolated let title: String, imageUrl: String
    /// Video ads: https URL and length. Playable ads: render `playableUrl` ONLY in a WKWebView without file access and without top-level navigation.
    public nonisolated let videoUrl: String?, playableUrl: String?, cta: String?, durationSec: Int
    private let videoCompleteUrl: String?, viewableUrl: String?
    private var completed = false, viewableSent = false
    /// Partner demand (markup "html" or "vast"): render ONLY in a sandboxed WKWebView; clicks are handled by the markup.
    public nonisolated let externalMarkup: String?, externalAdm: String?
    public nonisolated var isExternal: Bool { externalAdm != nil }
    /// Partner VAST video: the file to play (see `Vast`); nil for other ads.
    public nonisolated var vastMediaUrl: String? { externalMarkup == "vast" ? externalAdm.flatMap(Vast.mediaUrl) : nil }
    /// Rewarded slots: grant only after YOUR server receives the signed reward callback.
    public nonisolated let rewardAmount: Int, rewardItem: String?
    public nonisolated let isTest: Bool, body: String?, iconUrl: String?, sponsor: String?
    private let sdk: MobiAd
    private let impressionUrl: String, clickUrl: String, installUrl: String
    private var shownAt: Date?, clicked = false

    init?(sdk: MobiAd, json j: [String: Any]) {
        let c = j["creative"] as? [String: Any] ?? [:]
        guard let i = j["impressionUrl"] as? String, j["creative"] != nil || j["external"] != nil else { return nil }
        let k = j["clickUrl"] as? String ?? "", x = j["installUrl"] as? String ?? ""
        let ext = j["external"] as? [String: Any], rw = j["reward"] as? [String: Any]
        externalMarkup = ext?["markup"] as? String; externalAdm = ext?["adm"] as? String; rewardAmount = rw?["amount"] as? Int ?? 0; rewardItem = rw?["item"] as? String
        isTest = j["test"] as? Bool ?? false; body = c["body"] as? String; iconUrl = c["iconUrl"] as? String; sponsor = c["sponsor"] as? String
        self.sdk = sdk; title = c["title"] as? String ?? ""; imageUrl = c["image"] as? String ?? ""
        videoUrl = c["videoUrl"] as? String; playableUrl = c["playableUrl"] as? String; cta = c["cta"] as? String; durationSec = c["durationSec"] as? Int ?? 0
        videoCompleteUrl = j["videoCompleteUrl"] as? String; viewableUrl = j["viewableUrl"] as? String
        impressionUrl = i; clickUrl = k; installUrl = x
    }

    /// Call when the ad is actually visible. Idempotent.
    @discardableResult public func onShown() async -> Bool {
        if shownAt != nil { return true }
        shownAt = Date()
        do { return (200..<300).contains(try await sdk.http(impressionUrl, method: "GET").0) } catch { sdk.onError(error); return false }
    }

    /// Call when the user taps. Returns the landing-page URL to open, or nil if the SDK refused the click.
    public func onClicked() async -> String? {
        if isExternal { return nil } // partner ads handle their own clicks
        guard let shown = shownAt else { sdk.onError(MobiAdError.clickBeforeShown); return nil }
        if clicked { return nil }
        clicked = true // claimed before any suspension so concurrent taps report once
        let wait = sdk.minClickDelay - Date().timeIntervalSince(shown)
        if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1e9)) }
        do { return try await sdk.http(clickUrl, method: "GET").1 ?? clickUrl } catch { sdk.onError(error); return nil }
    }

    /// Video ads: call when playback reaches the end. Idempotent; never billed.
    public func onVideoComplete() async -> Bool {
        guard let u = videoCompleteUrl, shownAt != nil, !completed else { return false }
        completed = true
        do { return (200..<300).contains(try await sdk.http(u, method: "GET").0) } catch { sdk.onError(error); return false }
    }

    /// Viewability: call once >= 50% of the ad was on screen for 1 s in a row (see `ViewabilityTracker`). Idempotent; never billed.
    public func onViewable() async -> Bool {
        guard let u = viewableUrl, shownAt != nil, !viewableSent else { return false }
        viewableSent = true
        do { return (200..<300).contains(try await sdk.http(u, method: "GET").0) } catch { sdk.onError(error); return false }
    }

    /// Report an install attributed to this ad (call from your first-open flow).
    public func onInstalled() async -> Bool {
        do { return (200..<300).contains(try await sdk.http(installUrl, method: "GET").0) } catch { sdk.onError(error); return false }
    }
}

#if canImport(UIKit)
import UIKit
/// Display viewability: at least `minVisible` of the view's area on screen (inside its window, not hidden) for `duration` seconds in a row.
/// `onViewable` fires once on the main actor; pass it to `Ad.onViewable()`.
@MainActor public final class ViewabilityTracker {
    private weak var view: UIView?
    private let minVisible: CGFloat, duration: TimeInterval, onViewable: () -> Void
    private var timer: Timer?, since: Date?
    public init(view: UIView, minVisible: CGFloat = 0.5, duration: TimeInterval = 1.0, onViewable: @escaping () -> Void) { self.view = view; self.minVisible = minVisible; self.duration = duration; self.onViewable = onViewable }
    public func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
    }
    public func stop() { timer?.invalidate(); timer = nil }
    public func visibleFraction() -> CGFloat {
        guard let v = view, let w = v.window, !v.isHidden, v.alpha > 0.01, v.bounds.width > 0, v.bounds.height > 0, UIApplication.shared.applicationState == .active else { return 0 }
        let r = v.convert(v.bounds, to: w).intersection(w.bounds)
        return r.isNull ? 0 : (r.width * r.height) / (v.bounds.width * v.bounds.height)
    }
    private func tick() {
        if visibleFraction() >= minVisible {
            let s = since ?? Date(); since = s
            if Date().timeIntervalSince(s) >= duration { stop(); onViewable() }
        } else { since = nil }
    }
}
#endif
