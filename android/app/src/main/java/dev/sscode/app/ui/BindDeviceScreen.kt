package dev.sscode.app.ui

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.sscode.app.AppContainer
import dev.sscode.app.R
import dev.sscode.app.api.ApiException
import dev.sscode.app.api.PresetDto
import dev.sscode.app.api.SscodeApi
import dev.sscode.app.api.linkDevice
import dev.sscode.app.data.CredentialStore
import dev.sscode.app.ssh.SshSession
import kotlinx.coroutines.launch

/** /v1/models/presets 需要鉴权，未绑定时拿不到；内置一份与服务端一致的预设兜底。 */
private val BUILTIN_PRESETS = listOf(
    PresetDto(
        id = "kimi-cn",
        name = "Kimi（Moonshot 国内站）",
        baseUrl = "https://api.moonshot.cn/v1",
        models = listOf("kimi-k2.7-code", "kimi-k2.6", "moonshot-v1-128k"),
    ),
    PresetDto(
        id = "kimi-global",
        name = "Kimi（Moonshot 国际站）",
        baseUrl = "https://api.moonshot.ai/v1",
        models = listOf("kimi-k2.7-code", "kimi-k2.6"),
    ),
    PresetDto(
        id = "bailian",
        name = "阿里云百炼（按量付费）",
        baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models = listOf("qwen3-coder-plus", "qwen3.7-plus", "qwen-plus"),
    ),
    PresetDto(
        id = "bailian-coding-plan",
        name = "阿里云百炼 Coding Plan",
        baseUrl = "https://coding.dashscope.aliyuncs.com/v1",
        models = listOf("qwen3-coder-plus"),
    ),
    PresetDto(
        id = "custom",
        name = "自定义 OpenAI 兼容接口",
        baseUrl = "",
        models = emptyList(),
    ),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BindDeviceScreen(serverId: Long, onBack: () -> Unit, onBound: (Long) -> Unit) {
    val context = LocalContext.current
    val dao = remember { AppContainer.database(context).serverDao() }
    val credentials = remember { AppContainer.credentials(context) }
    val ssh = remember { AppContainer.ssh(context) }
    val sessionManager = remember { AppContainer.sessionManager(context, serverId) }
    val scope = rememberCoroutineScope()

    var sshSession by remember { mutableStateOf<SshSession?>(null) }
    var serverBaseUrl by remember { mutableStateOf<String?>(null) }
    var connecting by remember { mutableStateOf(true) }
    var connectError by remember { mutableStateOf<String?>(null) }

    var presets by remember { mutableStateOf(BUILTIN_PRESETS) }
    var deviceName by remember { mutableStateOf(Build.MODEL.ifBlank { "Android" }) }
    var presetName by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var presetMenu by remember { mutableStateOf(false) }
    var modelMenu by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        onDispose { sshSession?.close() }
    }

    LaunchedEffect(serverId) {
        connecting = true
        connectError = null
        try {
            val entity = dao.getById(serverId) ?: error("server not found")
            val s = ssh.connect(entity)
            sshSession = s
            val localPort = s.startLocalForward(localPort = 0, remotePort = 7823)
            val url = "http://127.0.0.1:$localPort/v1"
            serverBaseUrl = url
            // 有旧静态 token 时顺手拉服务端最新预设；失败则保留内置列表
            val staticToken = credentials.get(
                CredentialStore.apiTokenRef(serverId),
                CredentialStore.KEY_API_TOKEN,
            )
            if (staticToken != null) {
                try {
                    val fetched = SscodeApi(url, staticToken).getPresets()
                    if (fetched.isNotEmpty()) presets = fetched
                } catch (_: Exception) {
                }
            }
        } catch (e: Exception) {
            connectError = e.message
        } finally {
            connecting = false
        }
    }

    val rateLimited = stringResource(R.string.bind_rate_limited)
    val bindFailed = stringResource(R.string.bind_failed)

    fun submit() {
        val url = serverBaseUrl ?: return
        if (busy) return
        busy = true
        error = null
        // apiKey 只活在这个局部变量里，请求结束后连同输入框一起清空
        val key = apiKey.trim()
        scope.launch {
            try {
                val result = linkDevice(
                    serverBaseUrl = url,
                    deviceName = deviceName.trim(),
                    name = presetName.ifBlank { "custom" },
                    baseUrl = baseUrl.trim().trimEnd('/'),
                    model = model.trim(),
                    apiKey = key,
                )
                sessionManager.onLinked(url, result)
                onBound(serverId)
            } catch (e: ApiException) {
                error = if (e.httpStatus == 429) rateLimited else bindFailed + "\n" + e.message
            } catch (e: Exception) {
                error = bindFailed + "\n" + e.message.orEmpty()
            } finally {
                apiKey = ""
                busy = false
            }
        }
    }

    val presetModels = presets.firstOrNull { it.name == presetName }?.models.orEmpty()
    val canSubmit = !busy && !connecting && serverBaseUrl != null &&
        deviceName.isNotBlank() && baseUrl.isNotBlank() && model.isNotBlank() && apiKey.isNotBlank()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.bind_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .dismissKeyboardOnBackgroundTap()
                .verticalScroll(rememberScrollState())
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.bind_explanation), style = MaterialTheme.typography.bodySmall)
            if (connecting) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                Text(stringResource(R.string.connecting), style = MaterialTheme.typography.bodySmall)
            }
            connectError?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
                OutlinedButton(onClick = {
                    scope.launch {
                        connecting = true
                        connectError = null
                        try {
                            val entity = dao.getById(serverId) ?: error("server not found")
                            val s = ssh.connect(entity)
                            sshSession = s
                            val localPort = s.startLocalForward(localPort = 0, remotePort = 7823)
                            serverBaseUrl = "http://127.0.0.1:$localPort/v1"
                        } catch (e: Exception) {
                            connectError = e.message
                        } finally {
                            connecting = false
                        }
                    }
                }) { Text(stringResource(R.string.retry)) }
            }

            OutlinedTextField(
                value = deviceName,
                onValueChange = { deviceName = it },
                label = { Text(stringResource(R.string.bind_device_name)) },
                singleLine = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            )

            Box {
                OutlinedButton(onClick = { presetMenu = true }, enabled = !busy) {
                    Text(presetName.ifBlank { stringResource(R.string.agent_preset) })
                }
                DropdownMenu(expanded = presetMenu, onDismissRequest = { presetMenu = false }) {
                    presets.forEach { preset ->
                        DropdownMenuItem(
                            text = { Text(preset.name) },
                            onClick = {
                                presetName = preset.name
                                if (preset.baseUrl.isNotBlank()) baseUrl = preset.baseUrl
                                model = preset.models.firstOrNull().orEmpty()
                                presetMenu = false
                            },
                        )
                    }
                }
            }

            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                label = { Text("Base URL") },
                supportingText = { Text(stringResource(R.string.agent_url_hint)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                singleLine = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            )

            Box {
                OutlinedTextField(
                    value = model,
                    onValueChange = { model = it },
                    label = { Text(stringResource(R.string.agent_model)) },
                    singleLine = true,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (presetModels.isNotEmpty()) {
                    DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }) {
                        presetModels.forEach { id ->
                            DropdownMenuItem(text = { Text(id) }, onClick = { model = id; modelMenu = false })
                        }
                    }
                }
            }
            if (presetModels.isNotEmpty()) {
                OutlinedButton(onClick = { modelMenu = true }, enabled = !busy) {
                    Text(model.ifBlank { stringResource(R.string.agent_preset) })
                }
            }

            OutlinedTextField(
                value = apiKey,
                onValueChange = { apiKey = it },
                label = { Text("API Key") },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                singleLine = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(stringResource(R.string.bind_key_hint), style = MaterialTheme.typography.bodySmall)

            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }

            Button(onClick = { submit() }, enabled = canSubmit, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.bind_submit))
            }
            if (busy) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
            }
        }
    }
}
