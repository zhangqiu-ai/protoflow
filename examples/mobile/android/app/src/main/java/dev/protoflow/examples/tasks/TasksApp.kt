package dev.protoflow.examples.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Accent = Color(0xFF0D766E)
private val Ink = Color(0xFF18323C)
private val Canvas = Color(0xFFF2F5F7)
private val Border = Color(0xFFD9E2E5)
private val Danger = Color(0xFFAD3F3C)
private val Placeholder = Color(0xFFA3AEB3)

@Composable
fun TasksApp(initial: String) {
    var screen by remember { mutableStateOf(initial) }
    Box(Modifier.fillMaxSize().background(Canvas).safeDrawingPadding()) {
        when (screen) {
            "settings" -> SettingsScreen { screen = it }
            else -> TasksScreen { screen = it }
        }
    }
}

/** A screen root fills the content area and exposes test tags as resource ids for UiAutomator. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun ScreenRoot(id: String, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }.testTag(id).padding(start = 20.dp, end = 20.dp, top = 16.dp)
    ) { content() }
}

@Composable
private fun Header(prefix: String, title: String, action: String, onAction: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(44.dp).testTag("$prefix.header"), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.testTag("$prefix.title"), fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Ink)
        Spacer(Modifier.weight(1f))
        Text(action, Modifier.testTag(if (action == "Back") "$prefix.back" else "$prefix.settings").clickable(role = Role.Button, onClick = onAction), fontSize = 17.sp, color = Accent)
    }
    Spacer(Modifier.height(16.dp))
}

@Composable
private fun PrimaryButton(tag: String, title: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier.height(44.dp).background(Accent, RoundedCornerShape(10.dp)).testTag(tag).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 20.dp),
        contentAlignment = Alignment.Center
    ) { Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = Color.White) }
}

@Composable
fun TasksScreen(open: (String) -> Unit) {
    val items = remember { mutableStateListOf("Review prototype", "Ship version") }
    var draft by remember { mutableStateOf("") }
    var showError by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val add = {
        focus.clearFocus()
        val text = draft.trim()
        if (text.isEmpty()) showError = true else { showError = false; items.add(text); draft = "" }
    }
    ScreenRoot("tasks") {
        Header("tasks", "Today", "Settings") { open("settings") }
        Column(Modifier.fillMaxWidth().testTag("tasks.list"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items.forEach { item ->
                Box(Modifier.fillMaxWidth().height(48.dp).background(Color.White, RoundedCornerShape(12.dp)).testTag("tasks.item").padding(horizontal = 16.dp), contentAlignment = Alignment.CenterStart) {
                    Text(item, fontSize = 17.sp, color = Ink)
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth().testTag("tasks.form"), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            BasicTextField(
                value = draft, onValueChange = { draft = it }, singleLine = true,
                textStyle = TextStyle(fontSize = 17.sp, color = Ink),
                modifier = Modifier.weight(1f).height(44.dp).background(Color.White, RoundedCornerShape(10.dp)).border(1.dp, Border, RoundedCornerShape(10.dp)).testTag("tasks.input"),
                decorationBox = { field ->
                    Box(Modifier.padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
                        if (draft.isEmpty()) Text("New task", fontSize = 17.sp, color = Placeholder)
                        field()
                    }
                }
            )
            PrimaryButton("tasks.add", "Add", onClick = add)
        }
        if (showError) Text("Enter a task first.", Modifier.padding(top = 12.dp).testTag("tasks.error"), fontSize = 15.sp, color = Danger)
    }
}

@Composable
fun SettingsScreen(open: (String) -> Unit) {
    var notify by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }
    ScreenRoot("settings") {
        Header("settings", "Settings", "Back") { open("tasks") }
        Row(
            Modifier.fillMaxWidth().height(52.dp).background(Color.White, RoundedCornerShape(12.dp)).testTag("settings.notify").padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Daily reminder", fontSize = 17.sp, color = Ink)
            Spacer(Modifier.weight(1f))
            Switch(checked = notify, onCheckedChange = { notify = it }, modifier = Modifier.testTag("settings.notify-toggle"), colors = SwitchDefaults.colors(checkedTrackColor = Accent))
        }
        Spacer(Modifier.height(16.dp))
        PrimaryButton("settings.save", "Save", Modifier.fillMaxWidth()) { saved = true }
        if (saved) Text("Saved.", Modifier.padding(top = 12.dp).testTag("settings.saved"), fontSize = 15.sp, color = Accent)
    }
}
