package dev.protoflow.examples.tasksrn

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "ProtoFlowTasksRN"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
        // ProtoFlow launch convention: PROTOFLOW_* intent extras become initial props of the root component.
        override fun getLaunchOptions(): Bundle? =
            intent.extras?.let { extras ->
              Bundle().apply {
                for (key in listOf("PROTOFLOW_SCREEN", "PROTOFLOW_STATE", "PROTOFLOW_FIXTURE")) extras.getString(key)?.let { putString(key, it) }
              }
            }
      }
}
