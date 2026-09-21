package dev.sscode.app.ui

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController

/** Handle unconsumed background taps, leaving text selection, buttons and scrolling intact. */
fun Modifier.dismissKeyboardOnBackgroundTap(): Modifier = composed {
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    pointerInput(focusManager, keyboard) {
        detectTapGestures(onTap = {
            focusManager.clearFocus()
            keyboard?.hide()
        })
    }
}
