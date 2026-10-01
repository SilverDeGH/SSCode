package dev.sscode.app.ui

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import dev.sscode.app.api.ProjectDto
import kotlinx.coroutines.launch

internal fun roleLabelRes(role: String): Int = when (role) {
    "owner" -> R.string.role_owner
    "operator" -> R.string.role_operator
    "reviewer" -> R.string.role_reviewer
    "viewer" -> R.string.role_viewer
    else -> R.string.value_unknown
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectListScreen(
    serverId: Long,
    onBack: () -> Unit,
    onOpenProject: (projectId: String, projectName: String, role: String) -> Unit,
    onOpenMembers: (projectId: String) -> Unit,
    onOpenDevices: () -> Unit,
) {
    val context = LocalContext.current
    val dao = remember { AppContainer.database(context).serverDao() }
    val credentials = remember { AppContainer.credentials(context) }
    val ssh = remember { AppContainer.ssh(context) }
    val sessionManager = remember { AppContainer.sessionManager(context, serverId) }
    val scope = rememberCoroutineScope()

    var connection by remember { mutableStateOf<ServerConnection?>(null) }
    var projects by remember { mutableStateOf<List<ProjectDto>>(emptyList()) }
    // projectId -> 本设备角色，来自 me() 的 memberships；旧静态 token 视为 owner
    var roles by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var serverName by remember { mutableStateOf("") }
    var showCreate by remember { mutableStateOf(false) }
    var deleteTarget by remember { mutableStateOf<ProjectDto?>(null) }
    var deleting by remember { mutableStateOf(false) }
    var deleteError by remember { mutableStateOf<String?>(null) }

    val missingTokenText = stringResource(R.string.missing_token)
    val noPermissionText = stringResource(R.string.no_permission)
    val deleteConflictText = stringResource(R.string.project_delete_conflict)
    val deleteOwnerOnlyText = stringResource(R.string.project_delete_owner_only)

    DisposableEffect(Unit) {
        onDispose { connection?.close() }
    }

    fun roleOf(project: ProjectDto): String = project.role ?: roles[project.id] ?: "owner"

    suspend fun loadRoles(conn: ServerConnection) {
        roles = runCatching { conn.api.me() }.getOrNull()
            ?.memberships?.associate { it.projectId to it.role }
            ?: emptyMap()
    }

    fun refresh() {
        val conn = connection ?: return
        scope.launch {
            refreshing = true
            try {
                loadRoles(conn)
                projects = conn.api.listProjects()
                error = null
            } catch (e: ApiException) {
                error = if (e.httpStatus == 403) noPermissionText + "\n" + e.message else e.message
            } catch (e: Exception) {
                error = e.message
            } finally {
                refreshing = false
            }
        }
    }

    fun deleteProject(project: ProjectDto) {
        val conn = connection ?: return
        scope.launch {
            deleting = true
            try {
                conn.api.deleteProject(project.id)
                deleteTarget = null
                projects = projects.filterNot { it.id == project.id }
            } catch (e: ApiException) {
                deleteTarget = null
                deleteError = when (e.httpStatus) {
                    409 -> deleteConflictText
                    403 -> deleteOwnerOnlyText
                    else -> e.message
                }
            } catch (e: Exception) {
                deleteTarget = null
                deleteError = e.message
            } finally {
                deleting = false
            }
        }
    }

    LaunchedEffect(serverId) {
        loading = true
        try {
            val entity = dao.getById(serverId) ?: error("server not found")
            serverName = entity.name
            val hasStaticToken = credentials.get(
                dev.sscode.app.data.CredentialStore.apiTokenRef(serverId),
                dev.sscode.app.data.CredentialStore.KEY_API_TOKEN,
            ) != null
            if (!hasStaticToken && !sessionManager.hasRefreshToken) {
                error = missingTokenText
                return@LaunchedEffect
            }
            connection = connectToApi(ssh, credentials, entity, sessionManager)
            loadRoles(connection!!)
            projects = connection!!.api.listProjects()
        } catch (e: ApiException) {
            error = if (e.httpStatus == 403) noPermissionText + "\n" + e.message else e.message
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(serverName.ifBlank { stringResource(R.string.projects_title) }) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    IconButton(onClick = onOpenDevices) {
                        Icon(Icons.Filled.Devices, contentDescription = stringResource(R.string.devices_manage))
                    }
                },
            )
        },
        floatingActionButton = {
            if (connection != null) {
                FloatingActionButton(onClick = { showCreate = true }) {
                    Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.new_project))
                }
            }
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

            projects.isEmpty() -> Box(
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(32.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    stringResource(R.string.empty_projects),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            else -> LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(projects, key = { it.id }) { project ->
                    val role = roleOf(project)
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onOpenProject(project.id, project.name, role) },
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(start = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f).padding(top = 16.dp, bottom = 16.dp)) {
                                Text(project.name, style = MaterialTheme.typography.titleMedium)
                                Text(
                                    project.path,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    stringResource(roleLabelRes(role)),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                                project.tasks?.let { counts ->
                                    Text(
                                        stringResource(R.string.project_tasks_summary, counts.running, counts.queued),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.tertiary,
                                    )
                                }
                            }
                            Box {
                                var overflow by remember { mutableStateOf(false) }
                                if (role == "owner") {
                                    IconButton(onClick = { overflow = true }) {
                                        Icon(
                                            Icons.Filled.MoreVert,
                                            contentDescription = stringResource(R.string.members_manage),
                                        )
                                    }
                                }
                                DropdownMenu(expanded = overflow, onDismissRequest = { overflow = false }) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.members_manage)) },
                                        onClick = {
                                            overflow = false
                                            onOpenMembers(project.id)
                                        },
                                    )
                                    DropdownMenuItem(
                                        text = {
                                            Text(
                                                stringResource(R.string.project_delete),
                                                color = MaterialTheme.colorScheme.error,
                                            )
                                        },
                                        onClick = {
                                            overflow = false
                                            deleteTarget = project
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        }
    }

    deleteTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { if (!deleting) deleteTarget = null },
            title = { Text(stringResource(R.string.project_delete_confirm_title)) },
            text = { Text(stringResource(R.string.project_delete_confirm_message, target.name)) },
            confirmButton = {
                TextButton(enabled = !deleting, onClick = { deleteProject(target) }) {
                    Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }, enabled = !deleting) {
                    Text(stringResource(R.string.cancel))
                }
            },
        )
    }

    deleteError?.let { message ->
        AlertDialog(
            onDismissRequest = { deleteError = null },
            text = { Text(message) },
            confirmButton = {
                TextButton(onClick = { deleteError = null }) { Text(stringResource(R.string.confirm)) }
            },
        )
    }

    if (showCreate) {
        var name by remember { mutableStateOf("") }
        var path by remember { mutableStateOf("") }
        var creating by remember { mutableStateOf(false) }
        AlertDialog(
            modifier = Modifier.dismissKeyboardOnBackgroundTap(),
            onDismissRequest = { if (!creating) showCreate = false },
            title = { Text(stringResource(R.string.new_project)) },
            text = {
                Column {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text(stringResource(R.string.field_project_name)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = path,
                        onValueChange = { path = it },
                        label = { Text(stringResource(R.string.field_project_path)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = name.isNotBlank() && path.isNotBlank() && !creating,
                    onClick = {
                        val conn = connection ?: return@TextButton
                        creating = true
                        scope.launch {
                            try {
                                val created = conn.api.createProject(name.trim(), path.trim())
                                showCreate = false
                                onOpenProject(created.id, created.name, "owner")
                            } catch (e: Exception) {
                                error = e.message
                                showCreate = false
                            }
                        }
                    },
                ) { Text(stringResource(R.string.create)) }
            },
            dismissButton = {
                TextButton(onClick = { showCreate = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}
