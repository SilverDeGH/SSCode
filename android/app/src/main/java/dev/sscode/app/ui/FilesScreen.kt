package dev.sscode.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.sscode.app.R
import dev.sscode.app.api.FileEntryDto
import dev.sscode.app.api.FilesApi
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private fun formatFileSize(size: Long): String = when {
    size < 1024 -> "$size B"
    size < 1024 * 1024 -> "%.1f KB".format(size / 1024.0)
    size < 1024L * 1024 * 1024 -> "%.1f MB".format(size / (1024.0 * 1024))
    else -> "%.1f GB".format(size / (1024.0 * 1024 * 1024))
}

private fun formatMtime(mtime: Double): String =
    SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(mtime.toLong()))

private fun joinPath(dir: String, name: String): String =
    if (dir.isEmpty()) name else "$dir/$name"

private fun parentPath(path: String): String =
    path.substringBeforeLast('/', "")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(
    baseUrl: String,
    token: String,
    projectId: String,
    onOpenFile: (path: String) -> Unit,
    onBack: () -> Unit,
    /** 外部（工作区顶栏）触发刷新：值变化且 >0 时重载当前目录。 */
    refreshNonce: Int = 0,
    /** 外部控制"新建"对话框可见性；不传则用内部状态。 */
    createDialogVisible: Boolean? = null,
    onCreateDialogVisibleChange: ((Boolean) -> Unit)? = null,
) {
    val api = remember { FilesApi(baseUrl, token) }
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }

    var currentPath by remember { mutableStateOf("") }
    var entries by remember { mutableStateOf<List<FileEntryDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    var localShowCreateDialog by remember { mutableStateOf(false) }
    val showCreateDialog = createDialogVisible ?: localShowCreateDialog

    fun setShowCreateDialog(visible: Boolean) {
        if (onCreateDialogVisibleChange != null) onCreateDialogVisibleChange(visible)
        else localShowCreateDialog = visible
    }

    var renameTarget by remember { mutableStateOf<FileEntryDto?>(null) }
    var moveTarget by remember { mutableStateOf<FileEntryDto?>(null) }
    var deleteTarget by remember { mutableStateOf<FileEntryDto?>(null) }

    val sensitiveBlockedText = stringResource(R.string.files_sensitive)

    fun load(refresh: Boolean = false) {
        scope.launch {
            if (refresh) refreshing = true else loading = true
            error = null
            try {
                entries = api.list(projectId, currentPath)
                    .sortedWith(compareBy({ it.kind != "dir" }, { it.name.lowercase() }))
            } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
            } finally {
                loading = false
                refreshing = false
            }
        }
    }

    LaunchedEffect(currentPath) { load() }
    LaunchedEffect(refreshNonce) { if (refreshNonce > 0) load(refresh = true) }

    BackHandler { if (currentPath.isNotEmpty()) currentPath = parentPath(currentPath) else onBack() }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            Breadcrumb(
                currentPath = currentPath,
                onNavigate = { currentPath = it },
            )
            HorizontalDivider()
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { load(refresh = true) },
                modifier = Modifier.fillMaxSize(),
            ) {
                when {
                    loading -> Box(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
                        Text(
                            stringResource(R.string.loading),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    error != null -> Box(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                stringResource(R.string.files_error, error.orEmpty()),
                                color = MaterialTheme.colorScheme.error,
                            )
                            TextButton(
                                onClick = { load() },
                                modifier = Modifier.minimumInteractiveComponentSize(),
                            ) { Text(stringResource(R.string.retry)) }
                        }
                    }

                    entries.isEmpty() -> Box(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
                        Text(
                            stringResource(R.string.files_empty),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                        items(entries, key = { it.name }) { entry ->
                            FileRow(
                                entry = entry,
                                onClick = {
                                    when {
                                        entry.kind == "dir" -> currentPath = joinPath(currentPath, entry.name)
                                        entry.sensitive -> scope.launch {
                                            snackbar.showSnackbar(sensitiveBlockedText)
                                        }
                                        else -> onOpenFile(joinPath(currentPath, entry.name))
                                    }
                                },
                                onRename = { renameTarget = entry },
                                onMove = { moveTarget = entry },
                                onDelete = { deleteTarget = entry },
                            )
                        }
                    }
                }
            }
        }
    }

    if (showCreateDialog) {
        CreateEntryDialog(
            onDismiss = { setShowCreateDialog(false) },
            onConfirm = { name, kind ->
                setShowCreateDialog(false)
                scope.launch {
                    try {
                        api.create(projectId, joinPath(currentPath, name), kind)
                        load(refresh = true)
                    } catch (e: Exception) {
                        snackbar.showSnackbar(e.message ?: "error")
                    }
                }
            },
        )
    }

    renameTarget?.let { target ->
        InputDialog(
            title = stringResource(R.string.files_rename_title, target.name),
            initial = target.name,
            hint = stringResource(R.string.files_name_hint),
            onDismiss = { renameTarget = null },
            onConfirm = { newName ->
                renameTarget = null
                if (newName.isNotBlank() && newName != target.name) {
                    scope.launch {
                        try {
                            api.rename(projectId, joinPath(currentPath, target.name), newName.trim())
                            load(refresh = true)
                        } catch (e: Exception) {
                            snackbar.showSnackbar(e.message ?: "error")
                        }
                    }
                }
            },
        )
    }

    moveTarget?.let { target ->
        InputDialog(
            title = stringResource(R.string.files_move_title, target.name),
            initial = "",
            hint = stringResource(R.string.files_move_dest_hint),
            onDismiss = { moveTarget = null },
            onConfirm = { destDir ->
                moveTarget = null
                scope.launch {
                    try {
                        api.move(projectId, joinPath(currentPath, target.name), destDir.trim().trim('/'))
                        load(refresh = true)
                    } catch (e: Exception) {
                        snackbar.showSnackbar(e.message ?: "error")
                    }
                }
            },
        )
    }

    deleteTarget?.let { target ->
        AlertDialog(
            modifier = Modifier.dismissKeyboardOnBackgroundTap(),
            onDismissRequest = { deleteTarget = null },
            title = { Text(stringResource(R.string.files_delete_title, target.name)) },
            text = { Text(stringResource(R.string.files_delete_message)) },
            confirmButton = {
                TextButton(onClick = {
                    deleteTarget = null
                    scope.launch {
                        try {
                            api.delete(projectId, joinPath(currentPath, target.name))
                            load(refresh = true)
                        } catch (e: Exception) {
                            snackbar.showSnackbar(e.message ?: "error")
                        }
                    }
                }) {
                    Text(stringResource(R.string.delete), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

@Composable
private fun Breadcrumb(currentPath: String, onNavigate: (String) -> Unit) {
    val segments = currentPath.split('/').filter { it.isNotEmpty() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.files_root),
            style = MaterialTheme.typography.bodyMedium,
            color = if (segments.isEmpty()) MaterialTheme.colorScheme.onSurface
            else MaterialTheme.colorScheme.primary,
            modifier = Modifier
                .clickable(enabled = segments.isNotEmpty()) { onNavigate("") }
                .padding(vertical = 4.dp),
        )
        segments.forEachIndexed { index, segment ->
            Text(
                text = " / ",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val isLast = index == segments.lastIndex
            Text(
                text = segment,
                style = MaterialTheme.typography.bodyMedium,
                color = if (isLast) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .clickable(enabled = !isLast) {
                        onNavigate(segments.subList(0, index + 1).joinToString("/"))
                    }
                    .padding(vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun FileRow(
    entry: FileEntryDto,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onMove: () -> Unit,
    onDelete: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val icon = when (entry.kind) {
        "dir" -> Icons.Filled.Folder
        "symlink" -> Icons.Filled.Link
        else -> Icons.Filled.Description
    }
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        leadingContent = {
            Icon(
                icon,
                contentDescription = null,
                tint = if (entry.kind == "dir") MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        headlineContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(entry.name, style = MaterialTheme.typography.bodyLarge)
                if (entry.sensitive) {
                    Icon(
                        Icons.Filled.Lock,
                        contentDescription = stringResource(R.string.files_sensitive),
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
            }
        },
        supportingContent = {
            val meta = buildString {
                if (entry.kind != "dir") append(formatFileSize(entry.size)).append("  ")
                append(formatMtime(entry.mtime))
            }
            Text(meta, style = MaterialTheme.typography.bodySmall)
        },
        trailingContent = {
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(
                        Icons.Filled.MoreVert,
                        contentDescription = stringResource(R.string.files_more_actions),
                    )
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.files_rename)) },
                        onClick = { menuOpen = false; onRename() },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.files_move)) },
                        onClick = { menuOpen = false; onMove() },
                    )
                    DropdownMenuItem(
                        text = {
                            Text(
                                stringResource(R.string.delete),
                                color = MaterialTheme.colorScheme.error,
                            )
                        },
                        onClick = { menuOpen = false; onDelete() },
                    )
                }
            }
        },
    )
}

@Composable
private fun InputDialog(
    title: String,
    initial: String,
    hint: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var value by remember { mutableStateOf(initial) }
    AlertDialog(
        modifier = Modifier.dismissKeyboardOnBackgroundTap(),
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = value,
                onValueChange = { value = it },
                label = { Text(hint) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(value) }) { Text(stringResource(R.string.confirm)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        },
    )
}

@Composable
private fun CreateEntryDialog(
    onDismiss: () -> Unit,
    onConfirm: (name: String, kind: String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("file") }
    AlertDialog(
        modifier = Modifier.dismissKeyboardOnBackgroundTap(),
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.files_new)) },
        text = {
            Column {
                Row(
                    modifier = Modifier.clickable { kind = "file" },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = kind == "file", onClick = { kind = "file" })
                    Text(stringResource(R.string.files_new_file))
                }
                Row(
                    modifier = Modifier.clickable { kind = "dir" },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = kind == "dir", onClick = { kind = "dir" })
                    Text(stringResource(R.string.files_new_folder))
                }
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.files_name_hint)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(name.trim(), kind) },
                enabled = name.isNotBlank() && !name.contains('/'),
            ) { Text(stringResource(R.string.create)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        },
    )
}
