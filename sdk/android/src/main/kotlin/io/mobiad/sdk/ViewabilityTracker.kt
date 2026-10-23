package io.mobiad.sdk

/**
 * Display viewability (the common industry rule): at least [minVisible] of the view's area on screen for [durationMs] without a break.
 * Call [start] once the ad view is attached; [onViewable] fires once, on the main thread, and you pass it to Ad.onViewable() (off the main thread).
 * Visibility is measured with getGlobalVisibleRect, so an ad scrolled away, covered by a window, or in a background app does not count.
 */
class ViewabilityTracker(private val view: android.view.View, private val minVisible: Float = 0.5f, private val durationMs: Long = 1000, private val onViewable: () -> Unit) {
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var visibleSince = 0L
    private var done = false
    private val tick = object : Runnable {
        override fun run() {
            if (done) return
            val now = android.os.SystemClock.uptimeMillis()
            if (visibleFraction() >= minVisible) {
                if (visibleSince == 0L) visibleSince = now
                if (now - visibleSince >= durationMs) { done = true; onViewable(); return }
            } else visibleSince = 0L
            handler.postDelayed(this, 100)
        }
    }
    fun start() { if (!done) { handler.removeCallbacks(tick); handler.post(tick) } }
    fun stop() { done = true; handler.removeCallbacks(tick) }
    fun visibleFraction(): Float {
        if (!view.isShown || view.width <= 0 || view.height <= 0 || !view.hasWindowFocus()) return 0f
        val r = android.graphics.Rect()
        if (!view.getGlobalVisibleRect(r)) return 0f
        return (r.width().toFloat() * r.height()) / (view.width.toFloat() * view.height)
    }
}
