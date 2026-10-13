package dev.protoflow.examples.tasks

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The app's own functional tests (ProtoFlow `functional` for the android target), on the JVM. */
@RunWith(RobolectricTestRunner::class)
class TasksAppTest {
    @get:Rule val compose = createComposeRule()

    @Test fun addingATaskAppendsIt() {
        compose.setContent { TasksApp("tasks") }
        compose.onNodeWithTag("tasks.input").performTextInput("Write tests")
        compose.onNodeWithTag("tasks.add").performClick()
        compose.onAllNodesWithTag("tasks.item").assertCountEquals(3)
        compose.onNodeWithText("Write tests").assertIsDisplayed()
        compose.onAllNodesWithTag("tasks.error").assertCountEquals(0)
    }

    @Test fun addingAnEmptyTaskShowsTheError() {
        compose.setContent { TasksApp("tasks") }
        compose.onNodeWithTag("tasks.add").performClick()
        compose.onNodeWithTag("tasks.error").assertIsDisplayed()
        compose.onAllNodesWithTag("tasks.item").assertCountEquals(2)
    }

    @Test fun settingsSaveAndNavigation() {
        compose.setContent { TasksApp("settings") }
        compose.onNodeWithTag("settings.notify-toggle").performClick()
        compose.onNodeWithTag("settings.save").performClick()
        compose.onNodeWithTag("settings.saved").assertIsDisplayed()
        compose.onNodeWithTag("settings.back").performClick()
        compose.onNodeWithTag("tasks.title").assertIsDisplayed()
    }
}
