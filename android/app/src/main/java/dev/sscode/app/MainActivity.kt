package dev.sscode.app

import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.runtime.*
import java.util.Locale
import dev.sscode.app.ui.dismissKeyboardOnBackgroundTap
import dev.sscode.app.ui.AppNav
import dev.sscode.app.ui.theme.AppTheme

class MainActivity : ComponentActivity() {

    override fun attachBaseContext(newBase: Context) {
        // 应用内语言覆盖必须落在 Activity 自身的 base context 上：
        // Dialog 另起 Window，其 View context 取自 Activity，不走 CompositionLocalProvider；
        // 只覆盖 LocalContext 还会让 rememberLauncherForActivityResult 找不到
        // ActivityResultRegistryOwner 而闪退。语言切换时由下面的监听触发 recreate() 生效。
        val prefs = newBase.getSharedPreferences("appearance", MODE_PRIVATE)
        val language = prefs.getString("language", "system") ?: "system"
        if (language == "system") {
            super.attachBaseContext(newBase)
        } else {
            val config = Configuration().apply { setLocale(Locale.forLanguageTag(language)) }
            super.attachBaseContext(newBase.createConfigurationContext(config))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("appearance", MODE_PRIVATE)
        setContent {
            var language by remember { mutableStateOf(prefs.getString("language", "system") ?: "system") }
            var theme by remember { mutableStateOf(prefs.getString("theme", "system") ?: "system") }
            DisposableEffect(Unit) {
                val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
                    val newLanguage = prefs.getString("language", "system") ?: "system"
                    if (newLanguage != language) {
                        recreate()
                        return@OnSharedPreferenceChangeListener
                    }
                    theme = prefs.getString("theme", "system") ?: "system"
                }
                prefs.registerOnSharedPreferenceChangeListener(listener)
                onDispose { prefs.unregisterOnSharedPreferenceChangeListener(listener) }
            }
            AppTheme(mode = theme) {
                Box(Modifier.fillMaxSize().dismissKeyboardOnBackgroundTap()) {
                    AppNav()
                }
            }
        }
    }
}
