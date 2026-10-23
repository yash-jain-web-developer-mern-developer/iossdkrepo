package io.mobiad.demo

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

// Tiny view helpers so the demo needs no layout XML or third-party UI libraries.
object Palette {
    val bg = Color.parseColor("#0B0D1C"); val surface = Color.parseColor("#141730"); val surface2 = Color.parseColor("#1B1F3D")
    val ink = Color.parseColor("#EEF0FF"); val muted = Color.parseColor("#A2A8C8"); val brand = Color.parseColor("#5B3DF5"); val accent = Color.parseColor("#00C2B8")
    val ok = Color.parseColor("#3DDC9A"); val warn = Color.parseColor("#FFBF5E")
}

fun Context.dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

fun round(color: Int, radiusDp: Float, ctx: Context, strokeColor: Int? = null): GradientDrawable = GradientDrawable().apply {
    setColor(color); cornerRadius = radiusDp * ctx.resources.displayMetrics.density
    if (strokeColor != null) setStroke(ctx.dp(1), strokeColor)
}

fun Context.text(s: String, sizeSp: Float = 16f, color: Int = Palette.ink, bold: Boolean = false): TextView = TextView(this).apply {
    text = s; textSize = sizeSp; setTextColor(color); if (bold) setTypeface(typeface, Typeface.BOLD)
}

fun Context.button(label: String, bg: Int = Palette.brand, onClick: () -> Unit): Button = Button(this).apply {
    text = label; isAllCaps = false; textSize = 15f; setTextColor(Color.WHITE); background = round(bg, 24f, this@button)
    setPadding(dp(18), dp(10), dp(18), dp(10)); setOnClickListener { onClick() }
}

fun Context.card(vararg kids: View, pad: Int = 16): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL; background = round(Palette.surface, 18f, this@card, Palette.surface2); setPadding(dp(pad), dp(pad), dp(pad), dp(pad))
    kids.forEach { addView(it) }
}

fun Context.lp(w: Int = ViewGroup.LayoutParams.MATCH_PARENT, h: Int = ViewGroup.LayoutParams.WRAP_CONTENT, top: Int = 0, bottom: Int = 0): LinearLayout.LayoutParams =
    LinearLayout.LayoutParams(w, h).apply { topMargin = dp(top); bottomMargin = dp(bottom) }

fun Activity.root(): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL; setBackgroundColor(Palette.bg); setPadding(dp(18), dp(40), dp(18), dp(12)); gravity = Gravity.START
}

fun Context.pill(label: String, color: Int): TextView = text(label, 11f, Color.WHITE, true).apply {
    background = round(color, 10f, this@pill); setPadding(dp(8), dp(2), dp(8), dp(2))
}
