import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    // ProtoFlow launch convention: -PROTOFLOW_SCREEN <screen> (launch argument, read through UserDefaults).
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "ProtoFlowLaunch") {
      FlutterMethodChannel(name: "dev.protoflow/launch", binaryMessenger: registrar.messenger()).setMethodCallHandler { call, result in
        result(call.method == "screen" ? UserDefaults.standard.string(forKey: "PROTOFLOW_SCREEN") : FlutterMethodNotImplemented)
      }
    }
  }
}
