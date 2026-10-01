package dev.sscode.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.unit.dp
import dev.sscode.app.AppContainer
import dev.sscode.app.R
import dev.sscode.app.api.ApiException
import dev.sscode.app.api.DeviceDto
import kotlinx.coroutines.launch

@Composable
private fun relativeTime(epochMs: Long): String {
    if (epochMs <= 0) return "-"
    val diff = System.currentTimeMillis() - epochMs
    val minutes = diff / 60_000
    return when {
        minutes < 1 -> stringResource(R.string.time_just_now)
        minutes < 60 -> stringResource(R.string.time_minutes_ago, minutes)
        minutes < 60 * 24 -> stringResource(R.string.time_hours_ago, minutes / 60)
        else -> stringResource(R.string.time_days_ago, minutes / (60 * 24))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeviceSessionsScreen(serverId: Long, onBack: () -> Unit, onSignedOut: () -> Unit, onRebind: () -> Unit) {
    val context = LocalContext.current
    val dao = remember { AppContainer.database(context).serverDao() }
    val credentials = remember { AppContainer.credentials(context) }
    val ssh = remember { AppContainer.ssh(context) }
    val sessionManager = remember { AppContainer.sessionManager(context, serverId) }
    val scope = rememberCoroutineScope()

    var connection by remember { mutableStateOf<ServerConnection?>(null) }
    var devices by remember { mutableStateOf<List<DeviceDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var expired by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var revokeTarget by remember { mutableStateOf<DeviceDto?>(null) }
    var confirmSignOut by remember { mutableStateOf(false) }

    val selfId = sessionManager.deviceId

    DisposableEffect(Unit) {
        onDispose { connection?.close() }
    }

    fun refresh() {
        val conn = connection ?: return
        scope.launch {
            refreshing = true
            try {
                devices = conn.api.listDevices()
                error = null
            } catch (e: ApiException) {
                if (e.httpStatus == 401) expired = true
                error = e.message
            } catch (e: Exception) {
                error = e.message
            } finally {
                refreshing = false
            }
        }
    }

    LaunchedEffect(serverId) {
        loading = true
        try {
            val entity = dao.getById(serverId) ?: error("server not found")
            connection = connectToApi(ssh, credentials, entity, sessionManager)
            devices = connection!!.api.listDevices()
        } catch (e: ApiException) {
            if (e.httpStatus == 401) expired = true
            error = e.message
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.devices_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { refresh() },
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            when {
                loading -> Box(
                    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }

                expired -> Box(
                    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(32.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        // 401（设备被撤销/会话失效）：引导重新绑定，不再展示服务端原文与无效重试
                        Text(
                            stringResource(R.string.session_expired),
                            color = MaterialTheme.colorScheme.error,
                        )
                        Button(onClick = onRebind, modifier = Modifier.padding(top = 12.dp)) {
                            Text(stringResource(R.string.session_rebind))
                        }
                        TextButton(onClick = onBack, modifier = Modifier.padding(top = 4.dp)) {
                            Text(stringResource(R.string.back))
                        }
                    }
                }

                error != null -> Box(
                    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(32.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(error ?: "", color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = { refresh() }, modifier = Modifier.padding(top = 8.dp)) {
                            Text(stringResource(R.string.retry))
                        }
                    }
                }

                devices.isEmpty() -> Box(
                    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(32.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        stringResource(R.string.devices_empty),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(devices, key = { it.id }) { device ->
                        Card(modifier = Modifier.fillMaxWidth()) {
                            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        device.name.ifBlank { device.id.take(8) },
                                        style = MaterialTheme.typography.titleMedium,
                                        modifier = Modifier.weight(1f),
                                    )
                                    if (device.id == selfId) {
                                        AssistChip(
                                            onClick = {},
                                            label = { Text(stringResource(R.string.devices_current)) },
                                        )
                                    }
                                }
                                Text(
                                    stringResource(R.string.devices_last_seen, relativeTime(device.lastSeenAt)),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                if (device.revokedAt != null) {
                                    Text(
                                        stringResource(R.string.devices_revoked),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                } else if (device.id != selfId) {
                                    TextButton(
                                        enabled = !busy,
                                        onClick = { revokeTarget = device },
                                    ) { Text(stringResource(R.string.devices_revoke)) }
                                }
                            }
                        }
                    }
                    if (selfId != null) {
                        item {
                            TextButton(
                                enabled = !busy,
                                onClick = { confirmSignOut = true },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    stringResource(R.string.devices_sign_out),
                                    color = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    revokeTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { if (!busy) revokeTarget = null },
            title = { Text(stringResource(R.string.devices_revoke)) },
            text = { Text(stringResource(R.string.devices_revoke_confirm, target.name.ifBlank { target.id.take(8) })) },
            confirmButton = {
                TextButton(
                    enabled = !busy,
                    onClick = {
                        val conn = connection ?: return@TextButton
                        busy = true
                        scope.launch {
                            try {
                                conn.api.revokeDevice(target.id)
                                revokeTarget = null
                                refresh()
                            } catch (e: Exception) {
                                error = e.message
                                revokeTarget = null
                            } finally {
                                busy = false
                            }
                        }
                    },
                ) { Text(stringResource(R.string.devices_revoke)) }
            },
            dismissButton = {
                TextButton(onClick = { revokeTarget = null }, enabled = !busy) {
                    Text(stringResource(R.string.cancel))
                }
            },
        )
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { if (!busy) confirmSignOut = false },
            title = { Text(stringResource(R.string.devices_sign_out)) },
            text = { Text(stringResource(R.string.devices_sign_out_confirm)) },
            confirmButton = {
                TextButton(
                    enabled = !busy,
                    onClick = {
                        val conn = connection
                        busy = true
                        scope.launch {
                            try {
                                // 服务端撤销失败也要清本地凭据，避免卡在失效会话上
                                try {
                                    conn?.api?.revokeSession()
                                } catch (_: Exception) {
                                }
                                sessionManager.clearSession()
                                confirmSignOut = false
                                onSignedOut()
                            } finally {
                                busy = false
                            }
                        }
                    },
                ) { Text(stringResource(R.string.devices_sign_out)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmSignOut = false }, enabled = !busy) {
                    Text(stringResource(R.string.cancel))
                }
            },
        )
    }
}
