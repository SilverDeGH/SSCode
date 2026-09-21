package dev.sscode.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AttachFileSheet(
    baseUrl: String,
    token: String,
    projectId: String,
    initiallySelected: List<String>,
    onConfirm: (List<String>) -> Unit,
    onDismiss: () -> Unit,
) {
    val api = remember { FilesApi(baseUrl, token) }
    val scope = rememberCoroutineScope()
    var currentPath by remember { mutableStateOf("") }
    var entries by remember { mutableStateOf<List<FileEntryDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf(initiallySelected) }

    fun load(path: String) {
        currentPath = path
        loading = true
        scope.launch {
            try {
                entries = api.list(projectId, path)
                    .sortedWith(compareBy({ it.kind != "dir" }, { it.name }))
                error = null
            } catch (e: Exception) {
                error = e.message
            }
            loading = false
        }
    }

    LaunchedEffect(Unit) { load("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.attach_sheet_title),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                // 确认放顶栏：底部按钮需滚动才可见，拖动关sheet易丢选择
                TextButton(onClick = { onConfirm(selected); onDismiss() }) {
                    Text(stringResource(R.string.attach_done, selected.size))
                }
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = { load("") }) {
                    Text(stringResource(R.string.attach_root))
                }
                val segments = currentPath.split('/').filter { it.isNotEmpty() }
                segments.forEachIndexed { index, segment ->
                    Text("/", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val target = segments.take(index + 1).joinToString("/")
                    TextButton(onClick = { load(target) }) {
                        Text(segment, maxLines = 1)
                    }
                }
            }
            Box(modifier = Modifier.fillMaxWidth().heightIn(min = 200.dp, max = 360.dp)) {
                when {
                    loading -> Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                    error != null -> Text(error.orEmpty(), color = MaterialTheme.colorScheme.error)
                    entries.isEmpty() -> Text(
                        stringResource(R.string.attach_empty),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    else -> LazyColumn(modifier = Modifier.fillMaxWidth()) {
                        items(entries, key = { it.name }) { entry ->
                            val isDir = entry.kind == "dir"
                            val fullPath = if (currentPath.isEmpty()) entry.name else "$currentPath/${entry.name}"
                            val isSelected = fullPath in selected
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable(enabled = isDir || !entry.sensitive) {
                                        if (isDir) {
                                            load(fullPath)
                                        } else {
                                            selected = if (isSelected) selected - fullPath else selected + fullPath
                                        }
                                    }
                                    .padding(vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                val dim = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
                                Icon(
                                    when (entry.kind) {
                                        "dir" -> Icons.Filled.Folder
                                        "symlink" -> Icons.Filled.Link
                                        else -> Icons.Filled.Description
                                    },
                                    contentDescription = null,
                                    tint = if (entry.sensitive) dim else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    entry.name,
                                    modifier = Modifier
                                        .weight(1f)
                                        .padding(start = 12.dp),
                                    color = if (entry.sensitive) dim else MaterialTheme.colorScheme.onSurface,
                                    maxLines = 1,
                                )
                                if (entry.sensitive) {
                                    Icon(
                                        Icons.Filled.Lock,
                                        contentDescription = null,
                                        modifier = Modifier.size(16.dp),
                                        tint = dim,
                                    )
                                } else if (isSelected) {
                                    Icon(
                                        Icons.Filled.Check,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                        }
                    }
                }
            }
            if (selected.isNotEmpty()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(top = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    selected.forEach { path ->
                        InputChip(
                            selected = true,
                            onClick = { selected = selected - path },
                            label = { Text(path.substringAfterLast('/'), maxLines = 1) },
                            trailingIcon = {
                                Icon(
                                    Icons.Filled.Close,
                                    contentDescription = stringResource(R.string.remove_attachment),
                                    modifier = Modifier.size(16.dp),
                                )
                            },
                        )
                    }
                }
            }
        }
    }
}
