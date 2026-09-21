package dev.sscode.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectListScreen(
    serverId: Long,
    onBack: () -> Unit,
    onOpenProject: (projectId: String, projectName: String) -> Unit,
) {
    val context = LocalContext.current
    val dao = remember { AppContainer.database(context).serverDao() }
    val credentials = remember { AppContainer.credentials(context) }
    val ssh = remember { AppContainer.ssh(context) }
    val scope = rememberCoroutineScope()

    var connection by remember { mutableStateOf<ServerConnection?>(null) }
    var projects by remember { mutableStateOf<List<ProjectDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var serverName by remember { mutableStateOf("") }
    var showCreate by remember { mutableStateOf(false) }

    val missingTokenText = stringResource(R.string.missing_token)

    DisposableEffect(Unit) {
        onDispose { connection?.close() }
    }

    fun refresh() {
        val conn = connection ?: return
        scope.launch {
            refreshing = true
            try {
                projects = conn.api.listProjects()
                error = null
            } catch (e: ApiException) {
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
            serverName = entity.name
            if (credentials.get(
                    dev.sscode.app.data.CredentialStore.apiTokenRef(serverId),
                    dev.sscode.app.data.CredentialStore.KEY_API_TOKEN,
                ) == null
            ) {
                error = missingTokenText
                return@LaunchedEffect
            }
            connection = connectToApi(ssh, credentials, entity)
            projects = connection!!.api.listProjects()
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
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onOpenProject(project.id, project.name) },
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(project.name, style = MaterialTheme.typography.titleMedium)
                            Text(
                                project.path,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            project.tasks?.let { counts ->
                                Text(
                                    stringResource(R.string.project_tasks_summary, counts.running, counts.queued),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.tertiary,
                                )
                            }
                        }
                    }
                }
            }
        }
        }
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
                                onOpenProject(created.id, created.name)
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
