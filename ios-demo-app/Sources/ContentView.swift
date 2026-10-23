import SwiftUI
import AVKit
import MobiAd

// "Puzzle Quest": the END USER's app. It shows how a real iOS app uses the MobiAd Swift SDK:
// banner + native with viewability measurement, interstitial every second level, rewarded video that really plays
// and only offers the reward after the player reaches the end of the file. Everything the SDK does is listed in the activity log.
// Same behaviour as the Android demo app. Server and App ID come from the fields below (the iOS simulator reaches the host as localhost).
@MainActor final class Game: ObservableObject {
    @Published var server = "http://localhost:8080", appId = "", level = 1, coins = 120, log: [String] = []
    @Published var banner: Ad?, native: Ad?, interstitial: Ad?, rewarded: Ad?
    @Published var testMode = false
    private var plays = 0
    private var sdk: MobiAd?

    func note(_ s: String) { let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; log.insert("\(f.string(from: Date()))  \(s)", at: 0); if log.count > 9 { log.removeLast() } }

    func connect() async {
        do { sdk = try MobiAd(appId: appId, baseUrl: server, onError: { [weak self] e in Task { @MainActor in self?.note("SDK error: \(e)") } }) } catch { note("bad settings: \(error)"); return }
        note("MobiAd SDK ready (app \(appId))")
        banner = await request("banner"); native = await request("native")
    }
    func request(_ format: String) async -> Ad? {
        guard let sdk else { return nil }
        let ad = await sdk.requestAd(format: format, country: "US", language: "en", deviceType: "phone", osVersion: UIDevice.current.systemVersion, connection: "wifi",
                                     userId: format == "rewarded" ? "player-42" : nil, consent: Consent(gdpr: false), test: testMode)
        note("request \(format) -> " + (ad == nil ? "no fill" : "\"\(ad!.title)\""))
        return ad
    }
    func playLevel() async { level += 1; plays += 1; note("level cleared"); if plays % 2 == 0 { interstitial = await request("interstitial") } }
    func freeCoins() async { rewarded = await request("rewarded") }
    func impression(_ ad: Ad) { Task { let ok = await ad.onShown(); note("impression " + (ok ? "reported ✓" : "failed")) } }
    func viewable(_ ad: Ad) { Task { let ok = await ad.onViewable(); note("viewable (50% for 1 s) " + (ok ? "reported ✓" : "not applicable")) } }
    func click(_ ad: Ad) { Task { let url = await ad.onClicked(); note(url == nil ? "click ignored" : "click reported ✓ → \(url!.prefix(40))"); if let u = url, let link = URL(string: u) { await UIApplication.shared.open(link) } } }
}

struct ContentView: View {
    @StateObject private var g = Game()
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("Puzzle Quest").font(.title.bold()); Spacer(); Text("● \(g.coins) coins").padding(8).background(Color.yellow).cornerRadius(10) }
                GroupBox { VStack(alignment: .leading, spacing: 8) {
                    TextField("Server", text: $g.server).textFieldStyle(.roundedBorder).autocapitalization(.none).disableAutocorrection(true)
                    TextField("App ID (app_…)", text: $g.appId).textFieldStyle(.roundedBorder).autocapitalization(.none).disableAutocorrection(true)
                    Toggle("Test mode (canned ads, no billing)", isOn: $g.testMode)
                    Button("Connect and load ads") { Task { await g.connect() } }.buttonStyle(.borderedProminent)
                } }
                GroupBox { VStack(alignment: .leading, spacing: 8) {
                    Text("Level \(g.level)").font(.largeTitle.bold())
                    Text("Match three gems to clear the board.").foregroundColor(.secondary)
                    HStack { Button("Play level") { Task { await g.playLevel() } }.buttonStyle(.borderedProminent); Button("Free coins") { Task { await g.freeCoins() } }.buttonStyle(.bordered) }
                } }
                if let ad = g.native { AdCard(ad: ad, game: g, compact: false) }
                GroupBox(label: Text("SDK activity")) { Text(g.log.joined(separator: "\n")).font(.system(size: 11, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading) }
                if let ad = g.banner { AdCard(ad: ad, game: g, compact: true) }
            }.padding()
        }
        .sheet(item: Binding(get: { g.interstitial.map(AdBox.init) }, set: { if $0 == nil { g.interstitial = nil } })) { box in
            VStack(spacing: 18) { AdCard(ad: box.ad, game: g, compact: false); Button("Close") { g.interstitial = nil }.buttonStyle(.bordered) }.padding()
        }
        .fullScreenCover(item: Binding(get: { g.rewarded.map(AdBox.init) }, set: { if $0 == nil { g.rewarded = nil } })) { box in RewardedView(ad: box.ad, game: g) }
    }
}

struct AdBox: Identifiable { let ad: Ad; var id: ObjectIdentifier { ObjectIdentifier(ad) } }

// One ad card. The impression is reported when the card appears; "viewable" only once >= 50% of it stayed visible for 1 s.
struct AdCard: View {
    let ad: Ad; let game: Game; let compact: Bool
    var body: some View {
        GroupBox { VStack(alignment: .leading, spacing: 6) {
            Text(ad.isTest ? "TEST AD" : "AD").font(.caption2.bold()).foregroundColor(.secondary)
            Text(ad.title).font(compact ? .headline : .title3.bold())
            if !compact, let b = ad.body { Text(b).font(.footnote).foregroundColor(.secondary) }
            Button(ad.cta ?? "Learn more") { game.click(ad) }.buttonStyle(.borderedProminent)
        }.frame(maxWidth: .infinity, alignment: .leading) }
        .background(ViewabilityProbe { game.viewable(ad) })
        .onAppear { game.impression(ad) }
    }
}

// Invisible UIView behind the card that runs the SDK's ViewabilityTracker on exactly the card's frame.
struct ViewabilityProbe: UIViewRepresentable {
    let onViewable: () -> Void
    func makeUIView(context: Context) -> UIView { let v = UIView(); v.backgroundColor = .clear; v.isUserInteractionEnabled = false; context.coordinator.attach(v, onViewable); return v }
    func updateUIView(_ v: UIView, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator() }
    @MainActor final class Coordinator { var tracker: ViewabilityTracker?
        func attach(_ v: UIView, _ cb: @escaping () -> Void) { tracker = ViewabilityTracker(view: v, onViewable: cb); tracker?.start() }
        deinit { MainActor.assumeIsolated { tracker?.stop() } } }
}

// Rewarded video: a real AVPlayer; the reward button only appears after the player reports the end of the file.
struct RewardedView: View {
    let ad: Ad; let game: Game
    @State private var player: AVPlayer?, finished = false, failed = false
    var body: some View {
        VStack(spacing: 14) {
            Text("REWARDED VIDEO").font(.caption.bold()).padding(6).background(Color.blue).cornerRadius(8)
            Text(ad.title).font(.title2.bold())
            if let p = player { VideoPlayer(player: p).frame(height: 220) }
            if finished { Button("Claim \(max(ad.rewardAmount, 1)) \(ad.rewardItem ?? "reward")") { game.coins += max(ad.rewardAmount, 1); game.note("reward granted (a real app waits for the signed server callback)"); game.rewarded = nil }.buttonStyle(.borderedProminent) }
            else if failed { Button("Close") { game.rewarded = nil }.buttonStyle(.bordered); Text("Video could not be played: no reward").foregroundColor(.secondary) }
            else { Text("Watch to the end to earn the reward").foregroundColor(.secondary) }
        }
        .padding().preferredColorScheme(.dark)
        .onAppear {
            game.impression(ad)
            guard let s = ad.videoUrl, let url = URL(string: s) else { failed = true; return }
            let item = AVPlayerItem(url: url); let p = AVPlayer(playerItem: item); player = p
            NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { _ in
                finished = true; Task { let ok = await ad.onVideoComplete(); game.note("video completion " + (ok ? "reported ✓" : "not applicable")) } }
            NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { _ in failed = true; game.note("video error: cannot play") }
            p.play()
        }
        .onDisappear { player?.pause() }
    }
}
