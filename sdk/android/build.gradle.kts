// MobiAd Android SDK as a library (AAR): ./gradlew assembleRelease   ->   build/outputs/aar/mobiad-sdk-release.aar
// Built and checked with Gradle 8.5 / AGP 8.2.2 / Kotlin 1.9.22 (the same toolchain as the demo app). No third-party dependencies.
plugins {
    id("com.android.library") version "8.2.2"
    id("org.jetbrains.kotlin.android") version "1.9.22"
    id("maven-publish")
}
android {
    namespace = "io.mobiad.sdk"
    compileSdk = 34
    defaultConfig { minSdk = 21 }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].java.srcDir("src/main/kotlin")
    publishing { singleVariant("release") { withSourcesJar() } }
}
afterEvaluate {
    publishing {
        publications { register<MavenPublication>("release") { from(components["release"]); groupId = "io.mobiad"; artifactId = "mobiad-sdk"; version = "1.0.0" } }
    }
}
