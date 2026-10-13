// ProtoFlow Android capture runner: a self-instrumenting APK. The app part only measures system bar insets;
// the instrumentation test (CaptureTest) drives the target app by package through UiAutomator.
plugins {
    id("com.android.application")
}

android {
    namespace = "dev.protoflow.driver"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.protoflow.driver"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.4.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
