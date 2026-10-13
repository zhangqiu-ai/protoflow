package dev.protoflow.examples.protoflow_tasks

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // ProtoFlow launch convention: the PROTOFLOW_SCREEN string extra opens a screen directly.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "dev.protoflow/launch").setMethodCallHandler { call, result ->
            if (call.method == "screen") result.success(intent.getStringExtra("PROTOFLOW_SCREEN")) else result.notImplemented()
        }
    }
}
