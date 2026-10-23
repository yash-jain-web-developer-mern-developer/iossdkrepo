plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "io.mobiad.demo"
    compileSdk = 34
    defaultConfig {
        applicationId = "io.mobiad.demo"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
    buildTypes { release { isMinifyEnabled = false } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
// The MobiAd SDK is two source files in io/mobiad/sdk with no dependencies; the UI uses plain Android views.

// The ad SDK itself has no dependencies. The demo app uses Media3 ExoPlayer to play ad videos (MP4 and adaptive HLS streams).
dependencies {
    implementation("androidx.media3:media3-exoplayer:1.2.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.2.1")
    implementation("androidx.media3:media3-ui:1.2.1")
}
