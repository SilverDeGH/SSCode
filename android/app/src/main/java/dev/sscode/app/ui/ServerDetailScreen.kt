package dev.sscode.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import dev.sscode.app.AppContainer
import dev.sscode.app.R
import dev.sscode.app.data.CredentialStore
import dev.sscode.app.data.ServerEntity
import dev.sscode.app.deploy.DeployException
import dev.sscode.app.deploy.DeployStage
import dev.sscode.app.deploy.Deployer
import dev.sscode.app.deploy.EnvDetector
import dev.sscode.app.deploy.EnvReport
import dev.sscode.app.ssh.AuthenticationException
import dev.sscode.app.ssh.HostKeyChangedException
import dev.sscode.app.ssh.NetworkException
import dev.sscode.app.ssh.SshSession
import kotlinx.coroutines.launch

private fun formatBytes(bytes: Long): String {
    val gb = bytes / (1024.0 * 1024.0 * 1024.0)
    return if (gb >= 1) "%.1f GB".format(gb) else "%.0f MB".format(bytes / (1024.0 * 1024.0))
}

private fun stageLabel(stage: DeployStage): Int = when (stage) {
    DeployStage.CHECK -> R.string.stage_check
    DeployStage.NODE -> R.string.stage_node
    DeployStage.UPLOAD -> R.string.stage_upload
    DeployStage.SERVICE -> R.string.stage_service
    DeployStage.START -> R.string.stage_start
    DeployStage.TOKEN -> R.string.stage_token
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerDetailScreen(
    serverId: Long,
    onBack: () -> Unit,
    onOpenProjects: (Long) -> Unit,
    onBind: (Long) -> Unit,
    onOpenDevices: (Long) -> Unit,
) {
    val context = LocalContext.current
    val dao = remember { AppContainer.database(context).serverDao() }
    val credentials = remember { AppContainer.credentials(context) }
    val ssh = remember { AppContainer.ssh(context) }
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()

    var server by remember { mutableStateOf<ServerEntity?>(null) }
    var session by remember { mutableStateOf<SshSession?>(null) }
    var connecting by remember { mutableStateOf(false) }
    var connected by remember { mutableStateOf(false) }
    var authError by remember { mutableStateOf<String?>(null) }
    var networkError by remember { mutableStateOf<String?>(null) }
    var hostKeyChanged by remember { mutableStateOf<HostKeyChangedException?>(null) }
    var env by remember { mutableStateOf<EnvReport?>(null) }
    var deploying by remember { mutableStateOf(false) }
    var deployStages by remember { mutableStateOf<List<DeployStage>>(emptyList()) }
    var deployError by remember { mutableStateOf<String?>(null) }
    var tokenReady by remember { mutableStateOf(false) }
    var sessionBound by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        onDispose { session?.close() }
    }

    val connectingText = stringResource(R.string.connecting)
    val connectedText = stringResource(R.string.connected)

    fun connect(trustNewHostKey: Boolean) {
        if (connecting) return
        scope.launch {
            connecting = true
            connected = false
            authError = null
            networkError = null
            hostKeyChanged = null
            env = null
            deployError = null
            dao.updateStatus(serverId, connectingText)
            try {
                val entity = dao.getById(serverId) ?: error("server not found")
                server = entity
                session?.close()
                val s = ssh.connect(entity, trustNewHostKey = trustNewHostKey)
                session = s
                if (entity.hostFingerprint == null || trustNewHostKey) {
                    dao.updateFingerprint(serverId, s.hostFingerprint)
                }
                env = EnvDetector().detect(s)
                connected = true
                tokenReady = credentials.get(
                    CredentialStore.apiTokenRef(serverId),
                    CredentialStore.KEY_API_TOKEN,
                ) != null
                sessionBound = credentials.get(
                    CredentialStore.refreshTokenRef(serverId),
                    CredentialStore.KEY_REFRESH_TOKEN,
                ) != null
                dao.updateStatus(serverId, connectedText)
            } catch (e: HostKeyChangedException) {
                hostKeyChanged = e
                dao.updateStatus(serverId, "host key changed")
            } catch (e: AuthenticationException) {
                authError = e.message
                dao.updateStatus(serverId, "auth failed")
            } catch (e: NetworkException) {
                networkError = e.message
                dao.updateStatus(serverId, "network failed")
            } catch (e: Exception) {
                networkError = e.message
                dao.updateStatus(serverId, "failed")
            } finally {
                connecting = false
            }
        }
    }

    fun deploy() {
        val s = session ?: return
        if (deploying) return
        scope.launch {
            deploying = true
            deployStages = emptyList()
            deployError = null
            try {
                val token = Deployer(context).deploy(s) { stage, _ ->
                    if (!deployStages.contains(stage)) deployStages = deployStages + stage
                }
                credentials.set(CredentialStore.apiTokenRef(serverId), CredentialStore.KEY_API_TOKEN, token)
                tokenReady = true
                env = EnvDetector().detect(s)
            } catch (e: DeployException) {
                deployError = e.message
            } catch (e: Exception) {
                deployError = e.message
            } finally {
                deploying = false
            }
        }
    }

    fun connectExisting() {
        val s = session ?: return
        if (deploying) return
        scope.launch {
            deploying = true
            deployError = null
            deployStages = listOf(DeployStage.TOKEN)
            try {
                val token = Deployer(context).connectExisting(s)
                credentials.set(CredentialStore.apiTokenRef(serverId), CredentialStore.KEY_API_TOKEN, token)
                tokenReady = true
            } catch (e: Exception) {
                deployError = context.getString(R.string.existing_service_failed)
            } finally {
                deploying = false
            }
        }
    }

    LaunchedEffect(serverId) {
        server = dao.getById(serverId)
        connect(trustNewHostKey = false)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(server?.name ?: stringResource(R.string.loading)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
    ) { padding ->
        val pullRefreshState = rememberPullToRefreshState()
        PullToRefreshBox(
            isRefreshing = connecting,
            state = pullRefreshState,
            indicator = {
                // The connection row owns the loading indicator once a connection starts.
                if (!connecting) {
                    PullToRefreshDefaults.Indicator(
                        state = pullRefreshState,
                        isRefreshing = false,
                        modifier = Modifier.align(Alignment.TopCenter),
                    )
                }
            },
            onRefresh = { connect(trustNewHostKey = false) },
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            when {
                connecting -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.padding(end = 12.dp))
                        Text(stringResource(R.string.connecting))
                    }
                }
                hostKeyChanged != null -> {
                    val e = hostKeyChanged!!
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(
                                stringResource(R.string.host_key_changed_title),
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                            Text(
                                stringResource(R.string.host_key_changed_message, e.expectedFingerprint, e.actualFingerprint),
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                            Row(modifier = Modifier.padding(top = 8.dp)) {
                                TextButton(onClick = { connect(trustNewHostKey = true) }) {
                                    Text(stringResource(R.string.trust_again))
                                }
                                TextButton(onClick = { connect(trustNewHostKey = false) }) {
                                    Text(stringResource(R.string.retry))
                                }
                            }
                        }
                    }
                }
                authError != null || networkError != null -> {
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(
                                if (authError != null) {
                                    stringResource(R.string.error_auth)
                                } else {
                                    stringResource(R.string.error_network, networkError ?: "")
                                },
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                            // 具体原因（区分私钥解析失败与服务端拒绝，需求 13）
                            val detail = authError ?: networkError
                            if (!detail.isNullOrBlank()) {
                                Text(
                                    detail,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onErrorContainer,
                                    modifier = Modifier.padding(top = 6.dp),
                                )
                            }
                            TextButton(onClick = { connect(trustNewHostKey = false) }) {
                                Text(stringResource(R.string.retry))
                            }
                        }
                    }
                }
            }

            env?.let { report ->
                Text(stringResource(R.string.env_report_title), style = MaterialTheme.typography.titleMedium)
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        val missing = stringResource(R.string.value_missing)
                        val inactive = stringResource(R.string.value_inactive)
                        val unknown = stringResource(R.string.value_unknown)
                        val available = stringResource(R.string.value_available)
                        EnvRow(stringResource(R.string.env_os), report.osPrettyName ?: unknown)
                        // health 上报的宿主平台（Windows 直连场景的判定依据）
                        EnvDetector().platformName(report.platform)?.let { name ->
                            EnvRow(stringResource(R.string.env_platform), name)
                        }
                        report.terminalBackend?.let { backend ->
                            EnvRow(stringResource(R.string.env_terminal_backend), backend)
                        }
                        EnvRow(stringResource(R.string.env_arch), report.arch ?: unknown)
                        EnvRow(stringResource(R.string.env_cpu), report.cpuCores?.toString() ?: unknown)
                        EnvRow(stringResource(R.string.env_memory), report.memTotalBytes?.let(::formatBytes) ?: unknown)
                        EnvRow(stringResource(R.string.env_disk_free), report.diskFreeHomeBytes?.let(::formatBytes) ?: unknown)
                        EnvRow(stringResource(R.string.env_node), report.nodeVersion ?: missing)
                        EnvRow(stringResource(R.string.env_git), if (report.gitOk) available else missing)
                        if (!report.isWindowsHost) {
                            EnvRow(stringResource(R.string.env_tmux), if (report.tmuxOk) available else missing)
                            EnvRow(stringResource(R.string.env_systemd_user), if (report.systemdUserOk) available else missing)
                            EnvRow(stringResource(R.string.env_linger), if (report.lingerOk) available else missing)
                        }
                        EnvRow(stringResource(R.string.env_code_server), report.codeServerVersion ?: missing)
                        EnvRow(
                            stringResource(R.string.env_sscode_service),
                            if (report.sscodeServiceActive) available else inactive,
                        )
                    }
                }

                // Windows 直连引导：非 Linux shell 且服务未运行，展示手动启动指引
                if (!report.existingServiceReady && !tokenReady && !deploying && report.osPrettyName == null) {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.secondaryContainer,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(
                                stringResource(R.string.windows_guide_title),
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                            )
                            Text(
                                stringResource(R.string.windows_guide_message),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                                modifier = Modifier.padding(top = 6.dp),
                            )
                        }
                    }
                }

                if (report.existingServiceReady && !tokenReady && !deploying) {
                    Button(
                        onClick = { connectExisting() },
                        enabled = connected,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(stringResource(R.string.connect_existing_service)) }
                }

                if (!report.existingServiceReady && !deploying && !tokenReady && report.osPrettyName != null) {
                    Button(
                        onClick = { deploy() },
                        enabled = connected && report.systemdUserOk,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(stringResource(R.string.prepare_env)) }
                }

                if (connected && (tokenReady || sessionBound)) {
                    Button(onClick = { onOpenProjects(serverId) }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.enter_projects))
                    }
                }

                if (connected && report.existingServiceReady) {
                    OutlinedButton(onClick = { onBind(serverId) }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.bind_entry))
                    }
                }

                if (connected && (tokenReady || sessionBound)) {
                    TextButton(onClick = { onOpenDevices(serverId) }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.devices_manage))
                    }
                }
            }

            if (deploying || deployStages.isNotEmpty()) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        if (deploying) {
                            Text(stringResource(R.string.deploying))
                            LinearProgressIndicator(modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                        }
                        deployStages.forEach { stage ->
                            Text(
                                "• " + stringResource(stageLabel(stage)),
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                        }
                        if (!deploying && deployError == null && tokenReady) {
                            Text(
                                stringResource(R.string.deploy_done_token),
                                color = MaterialTheme.colorScheme.tertiary,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                        }
                        deployError?.let { err ->
                            Text(
                                stringResource(R.string.deploy_failed),
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.error,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                            Text(
                                err,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                            TextButton(onClick = { clipboard.setText(AnnotatedString(err)) }) {
                                Text(stringResource(R.string.copy))
                            }
                        }
                    }
                }
            }
        }
        }
    }
}

@Composable
private fun EnvRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(
            label,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}
