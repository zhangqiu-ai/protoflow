package dev.protoflow.examples.tasks

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge

/**
 * ProtoFlow launch convention: the PROTOFLOW_SCREEN string extra opens a screen directly; PROTOFLOW_FIXTURE carries the
 * scene's fixture data as JSON (unused by this example).
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val screen = intent.getStringExtra("PROTOFLOW_SCREEN") ?: "tasks"
        setContent { TasksApp(screen) }
    }
}
