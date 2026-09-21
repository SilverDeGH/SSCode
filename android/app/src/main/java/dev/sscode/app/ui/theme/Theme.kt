package dev.sscode.app.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

private val LightColors = lightColorScheme(
    primary = Color(0xFF315DA8), onPrimary = Color.White,
    primaryContainer = Color(0xFFDFEAFE), onPrimaryContainer = Color(0xFF18345F),
    secondary = Color(0xFF42665E), secondaryContainer = Color(0xFFDDEFE8),
    background = Color(0xFFF5F7FB), surface = Color(0xFFFAFBFE),
    surfaceVariant = Color(0xFFE9EEF6), onSurface = Color(0xFF1C293B),
    surfaceContainer = Color(0xFFEDF2F9), surfaceContainerLow = Color(0xFFF0F4FA),
    surfaceContainerHigh = Color(0xFFE6EDF7), surfaceContainerHighest = Color(0xFFE0E8F3),
    surfaceTint = Color(0xFF315DA8),
    onSurfaceVariant = Color(0xFF536174), outline = Color(0xFF78869A),
)
private val DarkColors = darkColorScheme(
    primary = Color(0xFFA8C7FF), onPrimary = Color(0xFF17345F),
    primaryContainer = Color(0xFF284775), onPrimaryContainer = Color(0xFFDCE8FF),
    secondary = Color(0xFFA0D1BF), secondaryContainer = Color(0xFF284D43),
    background = Color(0xFF101720), surface = Color(0xFF151E2B),
    surfaceVariant = Color(0xFF253245), onSurface = Color(0xFFE4EBF7),
    surfaceContainer = Color(0xFF1B2737), surfaceContainerLow = Color(0xFF172232),
    surfaceContainerHigh = Color(0xFF223044), surfaceContainerHighest = Color(0xFF2A3B50),
    surfaceTint = Color(0xFFA8C7FF),
    onSurfaceVariant = Color(0xFFB6C3D6), outline = Color(0xFF7E8EA5),
)

@Composable
fun AppTheme(mode: String = "system", content: @Composable () -> Unit) {
    val dark = when (mode) { "dark" -> true; "light" -> false; else -> isSystemInDarkTheme() }
    val colors = if (dark) DarkColors else LightColors
    val view = LocalView.current
    SideEffect {
        val window = (view.context as? Activity)?.window
        if (window != null) {
            window.statusBarColor = colors.background.toArgb()
            window.navigationBarColor = colors.background.toArgb()
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }
    MaterialTheme(
        colorScheme = colors,
        shapes = Shapes(small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(16.dp), large = RoundedCornerShape(22.dp)),
        content = content,
    )
}
