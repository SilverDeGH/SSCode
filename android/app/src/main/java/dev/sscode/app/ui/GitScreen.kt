package dev.sscode.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.sscode.app.R
import dev.sscode.app.api.ApiException
import dev.sscode.app.api.GitApi
import dev.sscode.app.api.GitFileDto
import dev.sscode.app.api.GitStatusDto
import kotlinx.coroutines.launch

private val GIT_BADGE_MODIFIED = Color(0xFFE2A336)
private val GIT_BADGE_ADDED = Color(0xFF4CAF50)
private val GIT_BADGE_DELETED = Color(0xFFF44336)
private val GIT_BADGE_CONFLICT = Color(0xFFAB47BC)
private val GIT_BADGE_RENAMED = Color(0xFF42A5F5)
private val GIT_BADGE_UNTRACKED = Color(0xFF9E9E9E)
private val DIFF_ADD = Color(0xFF4CAF50)
private val DIFF_DEL = Color(0xFFF44336)
private val DIFF_HUNK = Color(0xFF29B8DB)

private fun codeOf(s: String): Char? {
    for (c in s) {
        when (c) {
            'M', 'A', 'D', 'R', 'C', 'U', '?' -> return c
        }
    }
    return null
}

private fun badgeOf(f: GitFileDto): Char {
    val x = codeOf(f.index)
    val y = codeOf(f.worktree)
    if (x == 'U' || y == 'U') return 'U'
    if (x == '?' || y == '?') return '?'
    return x ?: y ?: '?'
}

private fun isStaged(f: GitFileDto): Boolean {
    val x = codeOf(f.index)
    return x != null && x != '?'
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GitScreen(
    baseUrl: String,
    token: String,
    projectId: String,
    onBack: () -> Unit,
    onOpenIde: () -> Unit,
) {
    val context = LocalContext.current
    val api = remember { GitApi(baseUrl, token) }
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }

    var status by remember { mutableStateOf<GitStatusDto?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var conflict by remember { mutableStateOf(false) }
    var commitMsg by remember { mutableStateOf("") }
    var diffPath by remember { mutableStateOf<String?>(null) }
    var diffText by remember { mutableStateOf<String?>(null) }
    var showNewBranch by remember { mutableStateOf(false) }
    var showCheckout by remember { mutableStateOf(false) }
    var branchName by remember { mutableStateOf("") }

    fun msg(res: Int): String = context.getString(res)

    fun toast(text: String) {
        scope.launch { snackbar.showSnackbar(text) }
    }

    fun refresh() {
        scope.launch {
            refreshing = true
            try {
                status = api.status(projectId)
                loadError = null
            } catch (e: Exception) {
                loadError = e.message
            } finally {
                loading = false
                refreshing = false
            }
        }
    }

    LaunchedEffect(Unit) { refresh() }

    fun stage(paths: List<String>, unstage: Boolean) {
        scope.launch {
            try {
                if (unstage) api.unstage(projectId, paths) else api.stage(projectId, paths)
                refresh()
            } catch (e: Exception) {
                toast(e.message ?: "error")
            }
        }
    }

    fun showDiff(f: GitFileDto) {
        diffPath = f.path
        diffText = null
        scope.launch {
            try {
                diffText = api.diff(projectId, f.path, isStaged(f)).diff
            } catch (e: Exception) {
                diffPath = null
                toast(e.message ?: "error")
            }
        }
    }

    fun commit() {
        val message = commitMsg.trim()
        if (message.isEmpty() || busy) return
        busy = true
        scope.launch {
            try {
                api.commit(projectId, message)
                commitMsg = ""
                toast(msg(R.string.git_commit_done))
                refresh()
            } catch (e: ApiException) {
                if (e.httpStatus == 400 && e.message.contains("who you are", ignoreCase = true)) {
                    toast(msg(R.string.git_commit_identity_error))
                } else {
                    toast(e.message)
                }
            } catch (e: Exception) {
                toast(e.message ?: "error")
            } finally {
                busy = false
            }
        }
    }

    fun pullPush(pull: Boolean) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                val r = if (pull) api.pull(projectId) else api.push(projectId)
                conflict = false
                toast(r.output.ifBlank { msg(if (pull) R.string.git_pull_done else R.string.git_push_done) })
                refresh()
            } catch (e: ApiException) {
                when {
                    e.code == "git_auth_failed" -> toast(msg(R.string.git_auth_failed))
                    e.httpStatus == 409 -> {
                        conflict = true
                        toast(msg(R.string.git_conflict))
                    }

                    else -> toast(e.message)
                }
            } catch (e: Exception) {
                toast(e.message ?: "error")
            } finally {
                busy = false
            }
        }
    }

    fun branchAction(checkout: Boolean) {
        val name = branchName.trim()
        if (name.isEmpty()) return
        showNewBranch = false
        showCheckout = false
        branchName = ""
        scope.launch {
            try {
                val r = if (checkout) api.checkout(projectId, name) else api.createBranch(projectId, name)
                toast(r.output.ifBlank { msg(R.string.git_branch_done) })
                refresh()
            } catch (e: Exception) {
                toast(e.message ?: "error")
            }
        }
    }

    BackHandler { onBack() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.git_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val st = status
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { refresh() },
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
        Box(modifier = Modifier.fillMaxSize()) {
            when {
                loading && st == null -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))

                loadError != null && st == null -> Box(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                    Column(
                        modifier = Modifier.align(Alignment.Center),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(loadError ?: "", color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = { loading = true; refresh() }) {
                            Text(stringResource(R.string.retry))
                        }
                    }
                }

                st == null -> {}

                !st.isRepo -> Box(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                    Text(
                        stringResource(R.string.git_not_repo),
                        modifier = Modifier.align(Alignment.Center),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                else -> Column(modifier = Modifier.fillMaxSize()) {
                    // 分支行
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                stringResource(R.string.git_branch_label, st.branch.ifBlank { "?" }),
                                style = MaterialTheme.typography.titleSmall,
                            )
                            Text(
                                stringResource(R.string.git_ahead_behind, st.ahead, st.behind),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        TextButton(onClick = { showNewBranch = true }) {
                            Text(stringResource(R.string.git_new_branch))
                        }
                        TextButton(onClick = { showCheckout = true }) {
                            Text(stringResource(R.string.git_switch_branch))
                        }
                    }

                    if (conflict) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 4.dp)
                                .background(MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(8.dp))
                                .padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                stringResource(R.string.git_conflict),
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                            TextButton(onClick = onOpenIde) {
                                Text(stringResource(R.string.git_open_ide))
                            }
                        }
                    }

                    HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

                    // 变更文件列表
                    LazyColumn(modifier = Modifier.fillMaxWidth().weight(1f)) {
                        if (st.files.isEmpty()) {
                            item {
                                Text(
                                    stringResource(R.string.git_no_changes),
                                    modifier = Modifier.padding(16.dp),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        items(st.files, key = { it.path + it.index + it.worktree }) { file ->
                            val staged = isStaged(file)
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { showDiff(file) }
                                    .padding(horizontal = 16.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                StatusBadge(badgeOf(file))
                                Text(
                                    file.path,
                                    modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
                                    style = MaterialTheme.typography.bodyMedium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                TextButton(onClick = { stage(listOf(file.path), staged) }) {
                                    Text(
                                        stringResource(
                                            if (staged) R.string.git_unstage else R.string.git_stage,
                                        ),
                                    )
                                }
                            }
                        }
                    }

                    HorizontalDivider()

                    // 提交行
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        OutlinedTextField(
                            value = commitMsg,
                            onValueChange = { commitMsg = it },
                            placeholder = { Text(stringResource(R.string.git_commit_hint)) },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        Button(
                            onClick = { commit() },
                            enabled = !busy && commitMsg.isNotBlank(),
                            modifier = Modifier.padding(start = 8.dp),
                        ) {
                            Text(stringResource(R.string.git_commit))
                        }
                    }

                    // 拉取 / 推送
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedButton(
                            onClick = { pullPush(true) },
                            enabled = !busy,
                            modifier = Modifier.weight(1f),
                        ) {
                            Text(stringResource(R.string.git_pull))
                        }
                        OutlinedButton(
                            onClick = { pullPush(false) },
                            enabled = !busy,
                            modifier = Modifier.weight(1f),
                        ) {
                            Text(stringResource(R.string.git_push))
                        }
                    }
                }
            }
        }
        }
    }

    // diff 全屏对话框
    val dp = diffPath
    if (dp != null) {
        Dialog(
            onDismissRequest = { diffPath = null; diffText = null },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Surface(modifier = Modifier.fillMaxSize()) {
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            stringResource(R.string.git_diff_title, dp),
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        TextButton(onClick = { diffPath = null; diffText = null }) {
                            Text(stringResource(R.string.git_close))
                        }
                    }
                    HorizontalDivider()
                    val dt = diffText
                    if (dt == null) {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    } else {
                        val diffLines = remember(dt) { dt.lines() }
                        LazyColumn(
                            modifier = Modifier
                                .fillMaxSize()
                                .horizontalScroll(rememberScrollState())
                                .padding(8.dp),
                        ) {
                            items(diffLines.size) { i ->
                                val l = diffLines[i]
                                Text(
                                    l,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 12.sp,
                                    color = diffLineColor(l),
                                    softWrap = false,
                                    maxLines = 1,
                                    overflow = TextOverflow.Clip,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showNewBranch) {
        BranchDialog(
            title = stringResource(R.string.git_new_branch),
            name = branchName,
            onNameChange = { branchName = it },
            onConfirm = { branchAction(false) },
            onDismiss = { showNewBranch = false },
        )
    }
    if (showCheckout) {
        BranchDialog(
            title = stringResource(R.string.git_switch_branch),
            name = branchName,
            onNameChange = { branchName = it },
            onConfirm = { branchAction(true) },
            onDismiss = { showCheckout = false },
        )
    }
}

private fun diffLineColor(line: String): Color = when {
    line.startsWith("+++") -> Color.Unspecified
    line.startsWith("---") -> Color.Unspecified
    line.startsWith("+") -> DIFF_ADD
    line.startsWith("-") -> DIFF_DEL
    line.startsWith("@@") -> DIFF_HUNK
    else -> Color.Unspecified
}

@Composable
private fun StatusBadge(code: Char) {
    val color = when (code) {
        'M' -> GIT_BADGE_MODIFIED
        'A' -> GIT_BADGE_ADDED
        'D' -> GIT_BADGE_DELETED
        'U' -> GIT_BADGE_CONFLICT
        'R', 'C' -> GIT_BADGE_RENAMED
        else -> GIT_BADGE_UNTRACKED
    }
    Box(
        modifier = Modifier
            .background(color, RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Text(code.toString(), color = Color.White, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun BranchDialog(
    title: String,
    name: String,
    onNameChange: (String) -> Unit,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        modifier = Modifier.dismissKeyboardOnBackgroundTap(),
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = onNameChange,
                placeholder = { Text(stringResource(R.string.git_branch_name_hint)) },
                singleLine = true,
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = name.isNotBlank()) {
                Text(stringResource(R.string.confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.cancel))
            }
        },
    )
}
