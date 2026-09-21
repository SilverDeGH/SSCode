package dev.sscode.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.sscode.app.R
import dev.sscode.app.api.*
import kotlinx.coroutines.launch
import java.net.URI

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentSettingsScreen(api: SscodeApi, selectedId: String?, onSelect: (AgentConfigDto) -> Unit, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var agents by remember { mutableStateOf<List<AgentConfigDto>>(emptyList()) }
    var presets by remember { mutableStateOf<List<PresetDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var form by remember { mutableStateOf(false) }
    var keyTarget by remember { mutableStateOf<AgentConfigDto?>(null) }
    var name by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var protocol by remember { mutableStateOf("auto") }
    var key by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var catalogTarget by remember { mutableStateOf<AgentConfigDto?>(null) }
    var catalog by remember { mutableStateOf<List<String>>(emptyList()) }
    var modelChoice by remember { mutableStateOf("") }
    val catalogFailed = stringResource(R.string.catalog_failed)
    val failed = stringResource(R.string.agent_failed)
    val saved = stringResource(R.string.agent_saved)
    val testOk = stringResource(R.string.agent_test_ok)
    val testFailed = stringResource(R.string.agent_test_failed)

    fun refresh() {
        scope.launch {
            loading = true
            message = null
            try {
                agents = api.listAgents()
                presets = api.getPresets()
            } catch (e: Exception) { message = failed + "\n" + e.message.orEmpty() }
            finally { loading = false }
        }
    }
    LaunchedEffect(api) { refresh() }
    fun back() {
        if (busy) return
        if (catalogTarget != null) { catalogTarget = null; message = null }
        else if (form) { form = false; key = ""; keyTarget = null } else onBack()
    }
    BackHandler { back() }
    val validUrl = runCatching {
        val uri = URI(baseUrl.trim())
        uri.scheme in listOf("https", "http") && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null
    }.getOrDefault(false)

    Scaffold(
        modifier = Modifier.imePadding(),
        topBar = { TopAppBar(
            title = { Text(stringResource(R.string.agent_settings)) },
            navigationIcon = { IconButton(onClick = { back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
        ) },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = loading,
            onRefresh = { refresh() },
            modifier = Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding),
        ) {
        Column(Modifier.fillMaxSize()
            .dismissKeyboardOnBackgroundTap().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.agent_explanation), style = MaterialTheme.typography.bodySmall)
            if (loading || busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
            if (catalogTarget != null) {
                Text(catalogTarget!!.name, style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.catalog_hint), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(modelChoice, { modelChoice = it }, label = { Text(stringResource(R.string.agent_model)) }, enabled = !busy, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button(enabled = !busy && modelChoice.isNotBlank(), onClick = {
                    val target = catalogTarget ?: return@Button
                    busy = true
                    scope.launch {
                        try {
                            val chosen = api.selectModel(target.id, modelChoice.trim())
                            onSelect(chosen); catalogTarget = null; onBack()
                        } catch (e: Exception) { message = failed + "\n" + e.message.orEmpty() }
                        finally { busy = false }
                    }
                }) { Text(stringResource(R.string.agent_use)) }
                catalog.filter { modelChoice.isBlank() || it.contains(modelChoice, ignoreCase = true) }.forEach { id ->
                    OutlinedButton(onClick = { modelChoice = id }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(id) }
                }
            } else if (form) {
                if (keyTarget == null) {
                    Box {
                        OutlinedButton(onClick = { menu = true }, enabled = !busy) { Text(stringResource(R.string.agent_preset)) }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            presets.forEach { preset -> DropdownMenuItem(text = { Text(preset.name) }, onClick = {
                                name = preset.name; baseUrl = preset.baseUrl; model = preset.models.firstOrNull().orEmpty(); menu = false
                            }) }
                        }
                    }
                    OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.agent_name)) }, singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(baseUrl, { baseUrl = it }, label = { Text("Base URL") }, supportingText = { Text(stringResource(R.string.agent_url_hint)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
                    Row {
                        listOf("auto", "responses", "chat/completions").forEach { value ->
                            FilterChip(selected = protocol == value, onClick = { protocol = value }, label = { Text(value) })
                        }
                    }
                    Text(stringResource(R.string.agent_protocol_hint), style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(model, { model = it }, label = { Text(stringResource(R.string.agent_model)) }, singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
                } else Text(keyTarget!!.name, style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(key, { key = it }, label = { Text("API Key") }, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
                Text(stringResource(R.string.agent_key_hint), style = MaterialTheme.typography.bodySmall)
                Button(enabled = !busy && key.isNotBlank() && (keyTarget != null || (name.isNotBlank() && model.isNotBlank() && validUrl)), onClick = {
                    busy = true; message = null
                    scope.launch {
                        try {
                            val target = keyTarget
                            if (target != null) api.updateAgentKey(target.id, key.trim())
                            else {
                                val created = api.createAgent(name.trim(), baseUrl.trim().trimEnd('/').removeSuffix("/responses").removeSuffix("/chat/completions") + (if (protocol == "auto") "" else "/$protocol"), model.trim(), key.trim())
                                onSelect(created)
                            }
                            key = ""; form = false; keyTarget = null
                            agents = api.listAgents(); message = saved
                        } catch (e: Exception) { message = failed + "\n" + e.message.orEmpty() }
                        finally { busy = false }
                    }
                }) { Text(stringResource(R.string.save)) }
            } else {
                Button(onClick = { name = ""; baseUrl = ""; model = ""; key = ""; keyTarget = null; form = true; message = null }, enabled = !busy && !loading) { Text(stringResource(R.string.agent_add)) }
                if (agents.isEmpty() && !loading) Text(stringResource(R.string.agent_empty))
                agents.forEach { agent ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(agent.name, style = MaterialTheme.typography.titleMedium)
                            Text(agent.model, style = MaterialTheme.typography.bodySmall)
                            Text(agent.baseUrl, style = MaterialTheme.typography.bodySmall)
                            OutlinedButton(enabled = !busy, onClick = {
                                catalogTarget = agent; modelChoice = ""; catalog = emptyList(); message = null; busy = true
                                scope.launch {
                                    try { catalog = api.modelCatalog(agent.id).models; if (catalog.isEmpty()) message = catalogFailed }
                                    catch (_: Exception) { message = catalogFailed }
                                    finally { busy = false }
                                }
                            }) { Text(stringResource(R.string.catalog_choose)) }
                            Row {
                                TextButton(onClick = { onSelect(agent); onBack() }, enabled = !busy) { Text(stringResource(if (selectedId == agent.id) R.string.agent_selected else R.string.agent_use)) }
                                TextButton(onClick = {
                                    busy = true; message = null
                                    scope.launch {
                                        try { val result = api.testAgent(agent.id); message = (if (result.ok) testOk else testFailed) + "\n" + result.detail }
                                        catch (e: Exception) { message = testFailed + "\n" + e.message.orEmpty() }
                                        finally { busy = false }
                                    }
                                }, enabled = !busy) { Text(stringResource(R.string.agent_test)) }
                                TextButton(onClick = { keyTarget = agent; key = ""; form = true; message = null }, enabled = !busy) { Text(stringResource(R.string.agent_update_key)) }
                            }
                        }
                    }
                }
                TextButton(onClick = { refresh() }, enabled = !busy && !loading) { Text(stringResource(R.string.retry)) }
            }
        }
        }
    }
}
