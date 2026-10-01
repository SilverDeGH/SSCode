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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import dev.sscode.app.api.MemberDto
import kotlinx.coroutines.launch

private val PROJECT_ROLES = listOf("owner", "operator", "reviewer", "viewer")

@Composable
private fun roleLabel(role: String): String = when (role) {
    "owner" -> stringResource(R.string.role_owner)
    "operator" -> stringResource(R.string.role_operator)
    "reviewer" -> stringResource(R.string.role_reviewer)
    "viewer" -> stringResource(R.string.role_viewer)
    else -> role
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectMembersScreen(serverId: Long, projectId: String, onBack: () -> Unit, onRebind: () -> Unit) {
    val context = LocalContext.current
    val dao = remember { AppContainer.database(context).serverDao() }
    val credentials = remember { AppContainer.credentials(context) }
    val ssh = remember { AppContainer.ssh(context) }
    val sessionManager = remember { AppContainer.sessionManager(context, serverId) }
    val scope = rememberCoroutineScope()

    var connection by remember { mutableStateOf<ServerConnection?>(null) }
    var members by remember { mutableStateOf<List<MemberDto>>(emptyList()) }
    var allDevices by remember { mutableStateOf<List<DeviceDto>>(emptyList()) }
    var myRole by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var expired by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var showAdd by remember { mutableStateOf(false) }
    var addDevice by remember { mutableStateOf<DeviceDto?>(null) }
    var addRole by remember { mutableStateOf("viewer") }
    var addDeviceMenu by remember { mutableStateOf(false) }
    var addRoleMenu by remember { mutableStateOf(false) }
    var roleTarget by remember { mutableStateOf<MemberDto?>(null) }
    var roleMenu by remember { mutableStateOf(false) }
    var removeTarget by remember { mutableStateOf<MemberDto?>(null) }

    val isOwner = myRole == "owner"

    val noPermissionText = stringResource(R.string.no_permission)
    fun errText(e: Exception): String {
        if (e is ApiException && e.httpStatus == 401) {
            expired = true
            return e.message
        }
        return if (e is ApiException && e.httpStatus == 403) noPermissionText + "\n" + e.message
        else e.message.orEmpty()
    }

    DisposableEffect(Unit) {
        onDispose { connection?.close() }
    }

    fun refresh() {
        val conn = connection ?: return
        scope.launch {
            refreshing = true
            try {
                members = conn.api.listMembers(projectId)
                error = null
            } catch (e: Exception) {
                error = errText(e)
            } finally {
                refreshing = false
            }
        }
    }

    LaunchedEffect(serverId, projectId) {
        loading = true
        try {
            val entity = dao.getById(serverId) ?: error("server not found")
            val conn = connectToApi(ssh, credentials, entity, sessionManager)
            connection = conn
            members = conn.api.listMembers(projectId)
            try {
                allDevices = conn.api.listDevices().filter { it.revokedAt == null }
            } catch (_: Exception) {
            }
            val me = try {
                conn.api.me()
            } catch (_: Exception) {
                null
            }
            myRole = when {
                me == null -> null
                me.legacy -> "owner" // 旧静态 token 等同服务端管理员
                else -> me.memberships.firstOrNull { it.projectId == projectId }?.role
            }
        } catch (e: Exception) {
            error = errText(e)
        } finally {
            loading = false
        }
    }

    fun deviceName(deviceId: String): String =
        members.firstOrNull { it.deviceId == deviceId }?.deviceName
            ?: allDevices.firstOrNull { it.id == deviceId }?.name
            ?: deviceId.take(8)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.members_title)) },
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

                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (!isOwner) {
                        item {
                            Text(
                                stringResource(R.string.members_readonly_hint),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (members.isEmpty()) {
                        item {
                            Text(
                                stringResource(R.string.members_empty),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    items(members, key = { it.deviceId }) { member ->
                        Card(modifier = Modifier.fillMaxWidth()) {
                            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        member.deviceName ?: deviceName(member.deviceId),
                                        style = MaterialTheme.typography.titleMedium,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Text(
                                        roleLabel(member.role),
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.tertiary,
                                    )
                                }
                                if (isOwner) {
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        TextButton(enabled = !busy, onClick = { roleTarget = member }) {
                                            Text(stringResource(R.string.members_change_role))
                                        }
                                        TextButton(enabled = !busy, onClick = { removeTarget = member }) {
                                            Text(
                                                stringResource(R.string.members_remove),
                                                color = MaterialTheme.colorScheme.error,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if (isOwner) {
                        item {
                            Button(
                                enabled = !busy,
                                onClick = {
                                    addDevice = null
                                    addRole = "viewer"
                                    showAdd = true
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text(stringResource(R.string.members_add)) }
                        }
                    }
                }
            }
        }
    }

    if (showAdd) {
        val candidates = allDevices.filter { d -> members.none { it.deviceId == d.id } }
        AlertDialog(
            modifier = Modifier.dismissKeyboardOnBackgroundTap(),
            onDismissRequest = { if (!busy) showAdd = false },
            title = { Text(stringResource(R.string.members_add)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box {
                        OutlinedButton(onClick = { addDeviceMenu = true }, enabled = !busy) {
                            Text(addDevice?.name ?: stringResource(R.string.members_pick_device))
                        }
                        DropdownMenu(expanded = addDeviceMenu, onDismissRequest = { addDeviceMenu = false }) {
                            candidates.forEach { device ->
                                DropdownMenuItem(
                                    text = { Text(device.name.ifBlank { device.id.take(8) }) },
                                    onClick = { addDevice = device; addDeviceMenu = false },
                                )
                            }
                        }
                    }
                    Box {
                        OutlinedButton(onClick = { addRoleMenu = true }, enabled = !busy) {
                            Text(stringResource(R.string.members_role) + ": " + roleLabel(addRole))
                        }
                        DropdownMenu(expanded = addRoleMenu, onDismissRequest = { addRoleMenu = false }) {
                            PROJECT_ROLES.forEach { role ->
                                DropdownMenuItem(
                                    text = { Text(roleLabel(role)) },
                                    onClick = { addRole = role; addRoleMenu = false },
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = addDevice != null && !busy,
                    onClick = {
                        val conn = connection ?: return@TextButton
                        val device = addDevice ?: return@TextButton
                        busy = true
                        scope.launch {
                            try {
                                conn.api.setMember(projectId, device.id, addRole)
                                showAdd = false
                                refresh()
                            } catch (e: ApiException) {
                                error = errText(e)
                                showAdd = false
                            } catch (e: Exception) {
                                error = errText(e)
                                showAdd = false
                            } finally {
                                busy = false
                            }
                        }
                    },
                ) { Text(stringResource(R.string.create)) }
            },
            dismissButton = {
                TextButton(onClick = { showAdd = false }, enabled = !busy) {
                    Text(stringResource(R.string.cancel))
                }
            },
        )
    }

    roleTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { if (!busy) roleTarget = null },
            title = { Text(stringResource(R.string.members_change_role)) },
            text = {
                Box {
                    OutlinedButton(onClick = { roleMenu = true }, enabled = !busy) {
                        Text(roleLabel(target.role))
                    }
                    DropdownMenu(expanded = roleMenu, onDismissRequest = { roleMenu = false }) {
                        PROJECT_ROLES.forEach { role ->
                            DropdownMenuItem(
                                text = { Text(roleLabel(role)) },
                                onClick = {
                                    roleMenu = false
                                    val conn = connection ?: return@DropdownMenuItem
                                    busy = true
                                    scope.launch {
                                        try {
                                            conn.api.setMember(projectId, target.deviceId, role)
                                            roleTarget = null
                                            refresh()
                                        } catch (e: Exception) {
                                            error = errText(e)
                                            roleTarget = null
                                        } finally {
                                            busy = false
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { roleTarget = null }, enabled = !busy) {
                    Text(stringResource(R.string.cancel))
                }
            },
        )
    }

    removeTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { if (!busy) removeTarget = null },
            title = { Text(stringResource(R.string.members_remove)) },
            text = { Text(stringResource(R.string.members_remove_confirm, deviceName(target.deviceId))) },
            confirmButton = {
                TextButton(
                    enabled = !busy,
                    onClick = {
                        val conn = connection ?: return@TextButton
                        busy = true
                        scope.launch {
                            try {
                                conn.api.removeMember(projectId, target.deviceId)
                                removeTarget = null
                                refresh()
                            } catch (e: Exception) {
                                error = errText(e)
                                removeTarget = null
                            } finally {
                                busy = false
                            }
                        }
                    },
                ) { Text(stringResource(R.string.members_remove)) }
            },
            dismissButton = {
                TextButton(onClick = { removeTarget = null }, enabled = !busy) {
                    Text(stringResource(R.string.cancel))
                }
            },
        )
    }
}
