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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.IconButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
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
import dev.sscode.app.data.ServerEntity
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerListScreen(
    onAdd: () -> Unit,
    onEdit: (Long) -> Unit,
    onConnect: (Long) -> Unit,
    onSettings: () -> Unit,
) {
    val context = LocalContext.current
    val dao = remember { AppContainer.database(context).serverDao() }
    val credentials = remember { AppContainer.credentials(context) }
    val servers by dao.observeAll().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    var pendingDelete by remember { mutableStateOf<ServerEntity?>(null) }

    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.servers_title)) }, actions = {
            IconButton(onClick = onSettings) { Icon(Icons.Filled.Settings, stringResource(R.string.appearance_title)) }
        }) },
        floatingActionButton = {
            FloatingActionButton(onClick = onAdd) {
                Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.add_server))
            }
        },
    ) { padding ->
        if (servers.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize().padding(padding).padding(32.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(R.string.empty_servers),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(servers, key = { it.id }) { server ->
                    ServerCard(
                        server = server,
                        onConnect = { onConnect(server.id) },
                        onEdit = { onEdit(server.id) },
                        onDelete = { pendingDelete = server },
                    )
                }
            }
        }
    }

    pendingDelete?.let { server ->
        AlertDialog(
            modifier = Modifier.dismissKeyboardOnBackgroundTap(),
            onDismissRequest = { pendingDelete = null },
            title = { Text(stringResource(R.string.delete_server_title)) },
            text = { Text(stringResource(R.string.delete_server_message)) },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch {
                        dao.delete(server)
                        credentials.deleteAll(server.credentialRef)
                        credentials.deleteAll(dev.sscode.app.data.CredentialStore.apiTokenRef(server.id))
                    }
                    pendingDelete = null
                }) { Text(stringResource(R.string.delete)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

@Composable
private fun ServerCard(
    server: ServerEntity,
    onConnect: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(server.name, style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.server_line, server.username, server.host, server.port),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                when (server.lastStatus) {
                    "Connected", "已连接" -> stringResource(R.string.connected)
                    "Connecting…", "连接中…", "正在连接…" -> stringResource(R.string.connecting)
                    "auth failed" -> stringResource(R.string.error_auth)
                    "host key changed" -> stringResource(R.string.host_key_changed_title)
                    "failed", "network failed" -> stringResource(R.string.connection_failed_short)
                    else -> server.lastStatus.ifBlank { stringResource(R.string.not_connected_yet) }
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (server.hostFingerprint != null) {
                Text(
                    stringResource(R.string.fingerprint_recorded),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TextButton(onClick = onConnect, modifier = Modifier.minimumInteractiveComponentSize()) {
                    Text(stringResource(R.string.connect))
                }
                TextButton(onClick = onEdit, modifier = Modifier.minimumInteractiveComponentSize()) {
                    Text(stringResource(R.string.edit))
                }
                TextButton(onClick = onDelete, modifier = Modifier.minimumInteractiveComponentSize()) {
                    Text(stringResource(R.string.delete))
                }
            }
        }
    }
}
