package dev.sscode.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.sscode.app.R

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppearanceScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("appearance", 0) }
    var language by remember { mutableStateOf(prefs.getString("language", "system")) }
    var theme by remember { mutableStateOf(prefs.getString("theme", "system")) }
    BackHandler { onBack() }
    Scaffold(topBar = {
        TopAppBar(title = { Text(stringResource(R.string.appearance_title)) }, navigationIcon = {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) }
        })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text(stringResource(R.string.appearance_hint), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(stringResource(R.string.language_title), style = MaterialTheme.typography.titleMedium)
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                listOf("system" to stringResource(R.string.follow_system), "zh-CN" to "简体中文", "en" to "English").forEach { (value, label) ->
                    SettingChoice(label, language == value) { language = value; prefs.edit().putString("language", value).apply() }
                }
            }
            Text(stringResource(R.string.theme_title), style = MaterialTheme.typography.titleMedium)
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                listOf("system" to stringResource(R.string.follow_system), "light" to stringResource(R.string.theme_light), "dark" to stringResource(R.string.theme_dark)).forEach { (value, label) ->
                    SettingChoice(label, theme == value) { theme = value; prefs.edit().putString("theme", value).apply() }
                }
            }
        }
    }
}

@Composable
private fun SettingChoice(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            RadioButton(selected = selected, onClick = null)
            Text(label, modifier = Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodyLarge)
        }
    }
}
