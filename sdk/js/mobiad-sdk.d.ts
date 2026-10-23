export interface Consent { gdpr?: boolean; gdprConsent?: string; coppa?: boolean; usPrivacy?: string; limitAdTracking?: boolean }
export interface AdRequest { format?: 'banner' | 'interstitial' | 'native' | 'video' | 'playable' | 'rewarded'; country?: string; deviceId?: string; consent?: Consent; placementId?: string; language?: string; deviceType?: 'phone' | 'tablet'; osVersion?: string; connection?: 'wifi' | 'cellular'; userId?: string; test?: boolean }
export interface Creative { title: string; image: string; videoUrl?: string; durationSec?: number; /** Render only in a sandboxed iframe/WebView. */ playableUrl?: string; cta?: string; body?: string; iconUrl?: string; sponsor?: string; rating?: number }
export interface ExternalCreative { markup: 'html' | 'vast'; adm: string; width?: number; height?: number }
export interface MobiAdOptions {
  appId: string; baseUrl: string; fetch?: typeof fetch; timeoutMs?: number; retries?: number; minClickDelayMs?: number; onError?: (e: Error) => void;
}
export class Ad {
  readonly creative: Creative | null;
  /** Partner demand: render in a sandboxed iframe/WebView only. When set, `creative` is null and clicks are handled by the markup. */
  readonly external: ExternalCreative | null;
  readonly reward: { amount: number; item: string } | null;
  readonly test: boolean;
  /** Partner VAST video: the file to play (HLS preferred), or null. */
  readonly vastMediaUrl: string | null;
  /** Report the impression once >= threshold of the element is visible for durationMs. Resolves true after onShown(); cancel() resolves false. */
  reportWhenViewable(element: unknown, opts?: { threshold?: number; durationMs?: number; IntersectionObserver?: unknown }): Promise<boolean> & { cancel(): void };
  /** Call when the ad is actually visible. Idempotent. Resolves true when the server accepted it. */
  onShown(): Promise<boolean>;
  /** Call on tap. Resolves to the landing URL to open, or null when the SDK refused/failed. */
  onClicked(): Promise<string | null>;
  /** Viewability: call once >= 50% of the ad was visible for 1 s in a row (after onShown). Never billed. */
  onViewable(): Promise<boolean>;
  /** Video ads: call when playback reaches the end. Never billed. */
  onVideoComplete(): Promise<boolean>;
  onInstalled(): Promise<boolean>;
}
export class MobiAd {
  constructor(opts: MobiAdOptions);
  /** Resolves to null on no-fill or network failure. */
  requestAd(req?: AdRequest): Promise<Ad | null>;
}
/** The playable file inside VAST markup (HLS preferred, then MP4/WebM; http(s) only), or null. */
export function vastMediaUrl(vast: string): string | null;
