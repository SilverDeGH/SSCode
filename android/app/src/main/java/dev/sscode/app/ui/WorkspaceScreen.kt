package dev.sscode.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Check
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TopAppBar
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CancellationException
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.AnnotatedString
import dev.sscode.app.AppContainer
import dev.sscode.app.R
import dev.sscode.app.api.AgentConfigDto
import dev.sscode.app.api.ApiException
import dev.sscode.app.api.ApprovalDto
import dev.sscode.app.api.SessionDto
import dev.sscode.app.api.TaskChangeFileDto
import dev.sscode.app.api.TaskDto
import dev.sscode.app.api.ToolCallDto
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import android.content.Intent
import android.net.Uri

private val ACTIVE_STATES = setOf("queued", "running", "awaiting_input", "awaiting_approval", "stopping")

private const val ATTACH_PREFIX = "【附加文件】\n"

private fun splitAttachments(input: String): Pair<List<String>, String> {
    if (!input.startsWith(ATTACH_PREFIX)) return emptyList<String>() to input
    val body = input.removePrefix(ATTACH_PREFIX)
    val sep = body.indexOf("\n\n")
    if (sep < 0) return emptyList<String>() to input
    val files = body.substring(0, sep).lines()
        .filter { it.startsWith("- ") }
        .map { it.removePrefix("- ") }
    return files to body.substring(sep + 2)
}

private fun taskStateRes(state: String): Int = when (state) {
    "queued" -> R.string.state_queued
    "running" -> R.string.state_running
    "awaiting_input" -> R.string.state_awaiting_input
    "awaiting_approval" -> R.string.state_awaiting_approval
    "stopping" -> R.string.state_stopping
    "completed" -> R.string.state_completed
    "failed" -> R.string.state_failed
    "blocked" -> R.string.state_blocked
    "stopped" -> R.string.state_stopped
    "interrupted" -> R.string.state_interrupted
    else -> R.string.value_unknown
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun WorkspaceScreen(
    serverId: Long,
    projectId: String,
    projectName: String,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val dao = remember { AppContainer.database(context).serverDao() }
    val credentials = remember { AppContainer.credentials(context) }
    val ssh = remember { AppContainer.ssh(context) }
    val scope = rememberCoroutineScope()
    val keyboardVisible = WindowInsets.isImeVisible

    var connection by remember { mutableStateOf<ServerConnection?>(null) }
    var serverName by remember { mutableStateOf("") }
    var sessions by remember { mutableStateOf<List<SessionDto>>(emptyList()) }
    var selectedSessionId by remember { mutableStateOf<String?>(null) }
    var draftNewChat by remember { mutableStateOf(false) }
    var tasks by remember { mutableStateOf<List<TaskDto>>(emptyList()) }
    var activeDetail by remember { mutableStateOf<TaskDto?>(null) }
    var input by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var selectedTab by remember { mutableIntStateOf(0) }
    var projectPath by remember { mutableStateOf("") }
    var editingFile by remember { mutableStateOf<String?>(null) }
    var filesRefreshNonce by remember { mutableIntStateOf(0) }
    var showFileCreateDialog by remember { mutableStateOf(false) }
    var attachments by remember { mutableStateOf<List<String>>(emptyList()) }
    var expandedTaskIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var expandedDetails by remember { mutableStateOf<Map<String, TaskDto>>(emptyMap()) }
    var expandedChanges by remember { mutableStateOf<Map<String, List<TaskChangeFileDto>>>(emptyMap()) }
    var showAttachSheet by remember { mutableStateOf(false) }
    var tasksRefreshing by remember { mutableStateOf(false) }
    var showGit by remember { mutableStateOf(false) }
    var showAgents by remember { mutableStateOf(false) }
    var selectedAgent by remember { mutableStateOf<AgentConfigDto?>(null) }
    val agentPrefs = remember { context.getSharedPreferences("agent_selection", android.content.Context.MODE_PRIVATE) }
    val agentPreferenceKey = "$serverId:$projectId"
    fun selectAgent(agent: AgentConfigDto) {
        selectedAgent = agent
        agentPrefs.edit().putString(agentPreferenceKey, agent.id).apply()
    }
    var showIde by remember { mutableStateOf(false) }
    var ideLocalPort by remember { mutableStateOf<Int?>(null) }
    var showWebDialog by remember { mutableStateOf(false) }
    var webPortInput by remember { mutableStateOf("3000") }
    var webRemotePort by remember { mutableStateOf<Int?>(null) }

    var approvalMode by remember { mutableStateOf(agentPrefs.getString("mode:$agentPreferenceKey", "manual") ?: "manual") }
    var legacyApprovalServer by remember { mutableStateOf(false) }
    var modeRevision by remember { mutableIntStateOf(0) }
    val modeMutex = remember { kotlinx.coroutines.sync.Mutex() }

    fun changeApprovalMode(mode: String) {
        approvalMode = mode
        val edit = agentPrefs.edit().putString("mode:$agentPreferenceKey", mode)
        tasks.filter { it.sessionId == selectedSessionId && it.state in ACTIVE_STATES }.forEach {
            edit.putString("task-mode:$serverId:${it.id}", mode)
        }
        edit.apply()
        modeRevision++
    }

    LaunchedEffect(connection, modeRevision) {
        val conn = connection ?: return@LaunchedEffect
        while (isActive) {
            try {
                for (task in conn.api.listTasks(projectId).filter { it.state in ACTIVE_STATES }) {
                    val desired = agentPrefs.getString("task-mode:$serverId:${task.id}", null) ?: continue
                    modeMutex.lock()
                    try {
                        if (task.approvalMode != desired && !legacyApprovalServer) {
                            try { conn.api.setApprovalMode(task.id, desired) }
                            catch (e: ApiException) {
                                if (e.httpStatus == 404 || e.httpStatus == 405) legacyApprovalServer = true
                                else if (e.httpStatus != 409) throw e
                            }
                        }
                        if (legacyApprovalServer && desired != "manual") {
                            val detail = conn.api.getTask(task.id)
                            for (approval in detail.pendingApprovals) {
                                try { conn.api.decideApproval(approval.id, "approve", "User selected $desired mode") }
                                catch (e: ApiException) { if (e.httpStatus != 409) throw e }
                            }
                        }
                    } finally { modeMutex.unlock() }
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = e.message }
            delay(1_000)
        }
    }
    var reconnectNonce by remember { mutableIntStateOf(0) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) reconnectNonce++
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(selectedSessionId) {
        selectedSessionId?.let { agentPrefs.edit().putString("session:$agentPreferenceKey", it).apply() }
    }

    val defaultSessionTitle = stringResource(R.string.session_default_title)

    DisposableEffect(Unit) {
        onDispose { connection?.close() }
    }

    fun openForwardedWeb() {
        val remotePort = webPortInput.toIntOrNull()?.takeIf { it in 1..65535 } ?: return
        webRemotePort = remotePort
        showWebDialog = false
    }

    fun openIde() {
        val conn = connection ?: return
        val port = ideLocalPort
        if (port != null) {
            showIde = true
            return
        }
        scope.launch {
            try {
                ideLocalPort = conn.session.startLocalForward(localPort = 0, remotePort = 8080)
                showIde = true
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    // Execution belongs to the server. Navigation only closes the transport.
    LaunchedEffect(serverId, projectId, reconnectNonce) {
        var retryDelay = 1_000L
        while (isActive) {
            var ownedConnection: ServerConnection? = null
            try {
                val entity = dao.getById(serverId) ?: error("server not found")
                serverName = entity.name
                val conn = connectToApi(ssh, credentials, entity)
                ownedConnection = conn
                connection = conn
                ideLocalPort = null
                val agents = conn.api.listAgents()
                selectedAgent = agents.find { it.id == agentPrefs.getString(agentPreferenceKey, null) }
                    ?: agents.find { it.isDefault } ?: agents.firstOrNull()
                projectPath = conn.api.listProjects().find { it.id == projectId }?.path ?: ""
                var loaded = conn.api.listSessions(projectId)
                if (loaded.isEmpty()) loaded = listOf(conn.api.createSession(projectId, defaultSessionTitle))
                sessions = loaded
                val initialTasks = conn.api.listTasks(projectId).sortedBy { it.seq }
                tasks = initialTasks
                if (!draftNewChat && selectedSessionId == null) {
                    selectedSessionId = initialTasks.lastOrNull { it.state in ACTIVE_STATES }?.sessionId
                        ?: loaded.find { it.id == agentPrefs.getString("session:$agentPreferenceKey", null) }?.id
                        ?: loaded.lastOrNull()?.id
                }
                retryDelay = 1_000L
                while (isActive) {
                    val list = conn.api.listTasks(projectId).sortedBy { it.seq }
                    tasks = list
                    sessions = conn.api.listSessions(projectId).map { session ->
                        if ('\uFFFD' !in session.title) session else {
                            val original = list.firstOrNull { it.sessionId == session.id && '\uFFFD' !in it.input }?.input
                            session.copy(title = original?.let { splitAttachments(it).second }?.take(40)?.takeIf { it.isNotBlank() }
                                ?: "${defaultSessionTitle} · ${session.id.take(6)}")
                        }
                    }
                    val sessionTasks = list.filter { it.sessionId == selectedSessionId }
                    val active = sessionTasks.lastOrNull { it.state in ACTIVE_STATES } ?: sessionTasks.lastOrNull()
                    activeDetail = active?.let { conn.api.getTask(it.id) }
                    error = null
                    delay(2_000)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = context.getString(R.string.workspace_reconnecting) + "\n" + e.message.orEmpty()
            } finally {
                ownedConnection?.close()
                if (connection === ownedConnection) connection = null
            }
            delay(retryDelay)
            retryDelay = (retryDelay * 2).coerceAtMost(15_000L)
        }
    }

    fun send() {
        val conn = connection ?: return
        val agent = selectedAgent ?: return
        val text = input.trim()
        if (text.isEmpty() || sending) return
        val fullInput = if (attachments.isEmpty()) text else buildString {
            append(ATTACH_PREFIX)
            attachments.forEach { append("- ").append(it).append('\n') }
            append('\n')
            append(text)
        }
        sending = true
        scope.launch {
            try {
                val current = selectedSessionId
                val sid = if (draftNewChat || current == null) {
                    val session = conn.api.createSession(projectId, text.substring(0, text.offsetByCodePoints(0, minOf(20, text.codePointCount(0, text.length)))))
                    sessions = sessions + session
                    selectedSessionId = session.id
                    draftNewChat = false
                    session.id
                } else {
                    current
                }
                val active = tasks.lastOrNull { it.sessionId == sid && it.state in ACTIVE_STATES }
                if (active != null) {
                    conn.api.appendTaskMessage(active.id, fullInput)
                } else {
                    val submitted = conn.api.submitTask(projectId, sid, fullInput, UUID.randomUUID().toString(), agent.id, approvalMode)
                    agentPrefs.edit().putString("task-mode:$serverId:${submitted.task.id}", approvalMode).apply()
                    modeRevision++
                }
                input = ""
                attachments = emptyList()
                tasks = conn.api.listTasks(projectId).sortedBy { it.seq }
            } catch (e: Exception) {
                error = e.message
            } finally {
                sending = false
            }
        }
    }

    fun startNewChat() {
        draftNewChat = true
        selectedSessionId = null
        activeDetail = null
        attachments = emptyList()
    }

    fun selectSession(id: String) {
        draftNewChat = false
        selectedSessionId = id
        expandedTaskIds = emptySet()
        val conn = connection ?: return
        scope.launch {
            runCatching {
                val list = conn.api.listTasks(projectId).sortedBy { it.seq }
                tasks = list
                val sessionTasks = list.filter { it.sessionId == id }
                val active = sessionTasks.lastOrNull { it.state in ACTIVE_STATES }
                    ?: sessionTasks.lastOrNull()
                activeDetail = active?.let { conn.api.getTask(it.id) }
            }
        }
    }

    fun toggleExpand(taskId: String) {
        if (taskId in expandedTaskIds) {
            expandedTaskIds = expandedTaskIds - taskId
            return
        }
        expandedTaskIds = expandedTaskIds + taskId
        val conn = connection ?: return
        scope.launch {
            val detail = runCatching { conn.api.getTask(taskId) }.getOrNull()
            if (detail != null) expandedDetails = expandedDetails + (taskId to detail)
            val changes = runCatching { conn.api.listTaskChanges(taskId) }.getOrNull()
            if (changes != null) expandedChanges = expandedChanges + (taskId to changes)
        }
    }

    fun decide(approvalId: String, decision: String) {
        val conn = connection ?: return
        scope.launch {
            try {
                conn.api.decideApproval(approvalId, decision)
                activeDetail?.let { activeDetail = conn.api.getTask(it.id) }
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    fun stopActive() {
        val conn = connection ?: return
        val task = activeDetail ?: return
        scope.launch {
            runCatching { conn.api.stopTask(task.id) }
        }
    }

    fun refreshTasks() {
        val conn = connection ?: return
        scope.launch {
            tasksRefreshing = true
            try {
                val list = conn.api.listTasks(projectId).sortedBy { it.seq }
                tasks = list
                val sid = selectedSessionId
                val sessionTasks = if (sid == null) emptyList() else list.filter { it.sessionId == sid }
                val active = sessionTasks.lastOrNull { it.state in ACTIVE_STATES }
                    ?: sessionTasks.lastOrNull()
                activeDetail = active?.let { runCatching { conn.api.getTask(it.id) }.getOrNull() }
                error = null
            } catch (e: Exception) {
                error = e.message
            } finally {
                tasksRefreshing = false
            }
        }
    }

    fun stepBack() {
        when {
            selectedTab != 0 -> selectedTab = 0
            else -> onBack()
        }
    }
    BackHandler(enabled = !showIde && !showGit && !showAgents && webRemotePort == null) { stepBack() }

    Scaffold(
        modifier = Modifier.imePadding(),
        topBar = {
            TopAppBar(
                modifier = Modifier.statusBarsPadding().height(52.dp),
                windowInsets = WindowInsets(0, 0, 0, 0),
                title = {
                    Column {
                        Text(projectName, style = MaterialTheme.typography.titleMedium)
                        Text(
                            serverName,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = { stepBack() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    if (selectedTab == 1 && editingFile == null) {
                        IconButton(onClick = { showFileCreateDialog = true }, enabled = connection != null) {
                            Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.files_new))
                        }
                        IconButton(onClick = { filesRefreshNonce++ }, enabled = connection != null) {
                            Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.files_refresh))
                        }
                    }
                    IconButton(onClick = { showGit = true }, enabled = connection != null) {
                        Icon(Icons.Filled.AccountTree, contentDescription = stringResource(R.string.open_git))
                    }
                    IconButton(onClick = { openIde() }, enabled = connection != null) {
                        Icon(Icons.Filled.Code, contentDescription = stringResource(R.string.open_ide))
                    }
                },
            )
        },
        bottomBar = {
            if (!keyboardVisible) Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
                Row(Modifier.fillMaxWidth().navigationBarsPadding().height(52.dp).padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    listOf(R.string.tab_ai, R.string.tab_files, R.string.tab_terminal).forEachIndexed { index, label ->
                        TextButton(onClick = { selectedTab = index }, modifier = Modifier.weight(1f),
                            shape = RoundedCornerShape(14.dp),
                            colors = ButtonDefaults.textButtonColors(
                                containerColor = if (selectedTab == index) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent,
                                contentColor = if (selectedTab == index) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                            )) { Text(stringResource(label), style = MaterialTheme.typography.labelLarge) }
                    }
                    IconButton(onClick = { showWebDialog = true }, enabled = connection != null) {
                        Icon(Icons.Filled.Language, contentDescription = stringResource(R.string.open_web))
                    }
                }
            }
        },
    ) { padding ->
        when (selectedTab) {
            0 -> AiTab(
                modifier = Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding),
                agentModel = selectedAgent?.model,
                onConfigureAgent = { showAgents = true },
                canConfigureAgent = connection != null,
                agentReady = selectedAgent != null,
                approvalMode = approvalMode,
                onApprovalModeChange = { changeApprovalMode(it) },
                sessions = sessions,
                currentSessionId = selectedSessionId,
                isDraft = draftNewChat,
                onSelectSession = { selectSession(it) },
                onNewChat = { startNewChat() },
                tasks = tasks.filter { it.sessionId == selectedSessionId },
                activeDetail = activeDetail,
                attachments = attachments,
                onAttachClick = { showAttachSheet = true },
                onRemoveAttachment = { attachments = attachments - it },
                expandedTaskIds = expandedTaskIds,
                expandedDetails = expandedDetails,
                expandedChanges = expandedChanges,
                onToggleExpand = { toggleExpand(it) },
                input = input,
                onInputChange = { input = it },
                sending = sending,
                onSend = { send() },
                onStop = { stopActive() },
                onDecide = { id, decision -> decide(id, decision) },
                error = error ?: if (legacyApprovalServer && approvalMode != "manual") stringResource(R.string.legacy_auto_approval) else null,
                ready = connection != null,
                refreshing = tasksRefreshing,
                onRefresh = { refreshTasks() },
            )

            1 -> {
                val conn = connection
                if (conn == null) {
                    Box(modifier = Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                } else {
                    Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                    val file = editingFile
                    if (file != null) {
                        EditorScreen(
                            baseUrl = conn.baseUrl,
                            token = conn.token,
                            projectId = projectId,
                            filePath = file,
                            onBack = { editingFile = null },
                        )
                    } else {
                        FilesScreen(
                            baseUrl = conn.baseUrl,
                            token = conn.token,
                            projectId = projectId,
                            onOpenFile = { editingFile = it },
                            onBack = { selectedTab = 0 },
                            refreshNonce = filesRefreshNonce,
                            createDialogVisible = showFileCreateDialog,
                            onCreateDialogVisibleChange = { showFileCreateDialog = it },
                        )
                    }
                    }
                }
            }

            else -> {
                val conn = connection
                if (conn == null) {
                    Box(modifier = Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                } else {
                    Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                    TerminalScreen(
                        wsBaseUrl = conn.wsBaseUrl,
                        token = conn.token,
                        projectId = projectId,
                        onBack = { selectedTab = 0 },
                    )
                    }
                }
            }
        }

    }

        val conn = connection
        if (showAgents && conn != null) {
            AgentSettingsScreen(conn.api, selectedAgent?.id, ::selectAgent, onBack = { showAgents = false })
        }
        if (showAttachSheet && conn != null) {
            AttachFileSheet(
                baseUrl = conn.baseUrl,
                token = conn.token,
                projectId = projectId,
                initiallySelected = attachments,
                onConfirm = { attachments = it },
                onDismiss = { showAttachSheet = false },
            )
        }
        if (showGit && conn != null) {
            GitScreen(
                baseUrl = conn.baseUrl,
                token = conn.token,
                projectId = projectId,
                onBack = { showGit = false },
                onOpenIde = {
                    showGit = false
                    openIde()
                },
            )
        }
        val idePort = ideLocalPort
        if (showIde && conn != null && idePort != null) {
            IdeScreen(
                baseUrl = conn.baseUrl,
                token = conn.token,
                projectPath = projectPath,
                ideLocalPort = idePort,
                onBack = { showIde = false },
            )
        }
    if (showWebDialog) {
        AlertDialog(onDismissRequest = { showWebDialog = false },
            title = { Text(stringResource(R.string.open_web)) },
            text = { Column { Text(stringResource(R.string.open_web_hint), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(webPortInput, { webPortInput = it.filter(Char::isDigit) }, label = { Text(stringResource(R.string.remote_port)) }, singleLine = true) } },
            confirmButton = { TextButton(enabled = webPortInput.toIntOrNull()?.let { it in 1..65535 } == true, onClick = { openForwardedWeb() }) { Text(stringResource(R.string.open)) } },
            dismissButton = { TextButton(onClick = { showWebDialog = false }) { Text(stringResource(R.string.cancel)) } })
    }
    webRemotePort?.let { port -> RemoteWebScreen(serverId, port, onBack = { webRemotePort = null }) }
}

private fun formatSessionTime(epochMillis: Long): String =
    if (epochMillis <= 0L) "" else SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(epochMillis))

private fun toolIcon(tool: String): ImageVector {
    val t = tool.lowercase()
    return when {
        "write" in t || "edit" in t || "patch" in t -> Icons.Filled.Edit
        "run" in t || "exec" in t || "shell" in t || "bash" in t || "command" in t -> Icons.Filled.PlayArrow
        "read" in t || "list" in t || "search" in t || "grep" in t || "glob" in t || "find" in t -> Icons.Filled.Search
        else -> Icons.Filled.Build
    }
}

private fun toolArgsSummary(args: JsonObject?): String? {
    if (args == null) return null
    for (key in listOf("command", "cmd", "path", "file", "filePath", "file_path", "query", "pattern", "url")) {
        val value = args[key]?.jsonPrimitive?.contentOrNull
        if (!value.isNullOrBlank()) return value.replace('\n', ' ').take(80)
    }
    return null
}

@Composable
private fun toolStateColor(state: String): Color = when (state) {
    "failed", "rejected" -> MaterialTheme.colorScheme.error
    "running", "awaiting_approval" -> MaterialTheme.colorScheme.primary
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
private fun SessionBar(
    sessions: List<SessionDto>,
    currentSessionId: String?,
    isDraft: Boolean,
    onSelectSession: (String) -> Unit,
    onNewChat: () -> Unit,
    agentModel: String?,
    onConfigureAgent: () -> Unit,
    canConfigureAgent: Boolean,
    approvalMode: String,
    onApprovalModeChange: (String) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    var approvalMenuOpen by remember { mutableStateOf(false) }
    val draftTitle = stringResource(R.string.chat_draft_title)
    val title = if (isDraft) draftTitle else sessions.find { it.id == currentSessionId }?.title ?: draftTitle
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(96.dp)) {
            TextButton(onClick = { menuOpen = true }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                Text(
                    title,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    Icons.Filled.KeyboardArrowDown,
                    contentDescription = stringResource(R.string.chat_list),
                )
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }, modifier = Modifier.widthIn(min = 240.dp, max = 320.dp)) {
                sessions.asReversed().forEach { session ->
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(session.title)
                                val time = formatSessionTime(session.createdAt)
                                if (time.isNotEmpty()) {
                                    Text(
                                        time,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        },
                        trailingIcon = {
                            if (session.id == currentSessionId && !isDraft) Icon(Icons.Filled.Check, contentDescription = null)
                        },
                        onClick = {
                            menuOpen = false
                            onSelectSession(session.id)
                        },
                    )
                }
            }
        }
        TextButton(
            onClick = onConfigureAgent,
            enabled = canConfigureAgent,
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(horizontal = 4.dp),
        ) {
            Text(agentModel ?: stringResource(R.string.agent_choose), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box {
            val modeLabel = when (approvalMode) {
                "full" -> R.string.mode_full
                "auto" -> R.string.mode_auto
                else -> R.string.mode_manual
            }
            IconButton(onClick = { approvalMenuOpen = true }) {
                Icon(Icons.Filled.Security, contentDescription = stringResource(modeLabel),
                    tint = if (approvalMode == "manual") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary)
            }
            DropdownMenu(expanded = approvalMenuOpen, onDismissRequest = { approvalMenuOpen = false },
                modifier = Modifier.widthIn(min = 240.dp, max = 320.dp)) {
                listOf(
                    Triple("manual", R.string.mode_manual, R.string.mode_manual_hint),
                    Triple("auto", R.string.mode_auto, R.string.mode_auto_hint),
                    Triple("full", R.string.mode_full, R.string.mode_full_hint),
                ).forEach { (mode, label, hint) ->
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(stringResource(label))
                                Text(stringResource(hint), style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        },
                        trailingIcon = { if (approvalMode == mode) Icon(Icons.Filled.Check, contentDescription = null) },
                        onClick = { onApprovalModeChange(mode); approvalMenuOpen = false },
                    )
                }
            }
        }
        IconButton(onClick = onNewChat) {
            Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.chat_new))
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun AiTab(
    modifier: Modifier,
    agentModel: String?,
    onConfigureAgent: () -> Unit,
    canConfigureAgent: Boolean,
    agentReady: Boolean,
    approvalMode: String,
    onApprovalModeChange: (String) -> Unit,
    sessions: List<SessionDto>,
    currentSessionId: String?,
    isDraft: Boolean,
    onSelectSession: (String) -> Unit,
    onNewChat: () -> Unit,
    tasks: List<TaskDto>,
    activeDetail: TaskDto?,
    attachments: List<String>,
    onAttachClick: () -> Unit,
    onRemoveAttachment: (String) -> Unit,
    expandedTaskIds: Set<String>,
    expandedDetails: Map<String, TaskDto>,
    expandedChanges: Map<String, List<TaskChangeFileDto>>,
    onToggleExpand: (String) -> Unit,
    input: String,
    onInputChange: (String) -> Unit,
    sending: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onDecide: (String, String) -> Unit,
    error: String?,
    ready: Boolean,
    refreshing: Boolean,
    onRefresh: () -> Unit,
) {
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    fun dismissKeyboard() {
        focus.clearFocus()
        keyboard?.hide()
    }
    val hasActive = (activeDetail?.state ?: "") in ACTIVE_STATES
    Column(modifier = modifier) {
        SessionBar(
            sessions = sessions,
            currentSessionId = currentSessionId,
            isDraft = isDraft,
            onSelectSession = onSelectSession,
            onNewChat = onNewChat,
            agentModel = agentModel,
            onConfigureAgent = onConfigureAgent,
            canConfigureAgent = canConfigureAgent,
            approvalMode = approvalMode,
            onApprovalModeChange = onApprovalModeChange,
        )
        if (!ready && error == null) {
            Box(modifier = Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        } else {
            val listState = rememberLazyListState()
            var followTail by remember { mutableStateOf(true) }
            LaunchedEffect(Unit) {
                snapshotFlow { listState.canScrollForward }.collect { followTail = !it }
            }
            var itemCount = if (tasks.isEmpty()) 1 else tasks.size * 2
            if (error != null) itemCount += 1
            LaunchedEffect(itemCount, activeDetail?.toolCalls?.size, activeDetail?.summary, activeDetail?.state) {
                if (followTail && itemCount > 0) listState.scrollToItem(itemCount - 1)
            }
            // A newly opened workspace/session always starts at the newest message.
            LaunchedEffect(currentSessionId, tasks.size, ready) {
                if (ready && itemCount > 0) {
                    withFrameNanos { }
                    listState.scrollToItem(itemCount - 1)
                }
            }
            LaunchedEffect(Unit) {
                snapshotFlow { listState.layoutInfo.visibleItemsInfo.map { Triple(it.index, it.offset, it.size) } }
            }
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = onRefresh,
                modifier = Modifier.fillMaxWidth().weight(1f),
            ) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().pointerInput(Unit) {
                    detectTapGestures(onTap = { dismissKeyboard() })
                },
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (tasks.isEmpty()) {
                    item(key = "empty") {
                        Text(
                            stringResource(if (isDraft) R.string.chat_draft_hint else R.string.no_tasks),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                tasks.forEach { task ->
                    item(key = task.id + ":user") {
                        UserBubble(task.input)
                    }
                    item(key = task.id + ":assistant") {
                        AssistantTurn(
                            task = task,
                            agentModel = agentModel,
                            liveDetail = activeDetail?.takeIf { it.id == task.id },
                            expanded = task.id in expandedTaskIds,
                            expandedDetail = expandedDetails[task.id],
                            changedFiles = expandedChanges[task.id],
                            onToggleExpand = { onToggleExpand(task.id) },
                            onDecide = onDecide,
                        )
                    }
                }
                error?.let {
                    item(key = "error") { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            }
            }
        }

        if (attachments.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                attachments.forEach { path ->
                    InputChip(
                        selected = true,
                        onClick = { onRemoveAttachment(path) },
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
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            IconButton(onClick = onAttachClick, enabled = ready) {
                Icon(Icons.Filled.AttachFile, contentDescription = stringResource(R.string.attach_files))
            }
            OutlinedTextField(
                value = input,
                onValueChange = onInputChange,
                placeholder = {
                    Text(stringResource(if (hasActive) R.string.input_hint_append else R.string.input_hint))
                },
                minLines = 1,
                maxLines = 5,
                shape = RoundedCornerShape(24.dp),
                textStyle = MaterialTheme.typography.bodyMedium,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                enabled = ready,
                modifier = Modifier.weight(1f),
            )
            if (hasActive) {
                TextButton(onClick = onStop, modifier = Modifier.padding(start = 4.dp)) {
                    Text(stringResource(R.string.stop_task))
                }
            }
            Button(
                onClick = { dismissKeyboard(); onSend() },
                enabled = ready && agentReady && input.isNotBlank() && !sending,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.padding(start = 8.dp, bottom = 4.dp),
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(if (hasActive) R.string.append_send else R.string.send), modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
private fun UserBubble(rawInput: String) {
    val (files, text) = splitAttachments(rawInput)
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        Surface(
            color = MaterialTheme.colorScheme.primaryContainer,
            shape = RoundedCornerShape(16.dp, 16.dp, 4.dp, 16.dp),
            modifier = Modifier.widthIn(max = 320.dp),
        ) {
            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                files.forEach { path ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Filled.Description,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                        Text(
                            path.substringAfterLast('/'),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            modifier = Modifier.padding(start = 4.dp),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (text.isNotBlank()) {
                    SelectionContainer { Text(
                        text,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.padding(top = if (files.isEmpty()) 0.dp else 4.dp),
                    ) }
                }
                CopyMessageButton(rawInput)
            }
        }
    }
}

@Composable
private fun CopyMessageButton(text: String) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(text) { mutableStateOf(false) }
    TextButton(onClick = { clipboard.setText(AnnotatedString(text)); copied = true }, contentPadding = PaddingValues(horizontal = 4.dp)) {
        Icon(if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(14.dp))
        Text(stringResource(if (copied) R.string.copied else R.string.copy), style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(start = 4.dp))
    }
}

@Composable
private fun AssistantTurn(
    task: TaskDto,
    agentModel: String?,
    liveDetail: TaskDto?,
    expanded: Boolean,
    expandedDetail: TaskDto?,
    changedFiles: List<TaskChangeFileDto>?,
    onToggleExpand: () -> Unit,
    onDecide: (String, String) -> Unit,
) {
    val active = task.state in ACTIVE_STATES
    val detail = liveDetail ?: if (expanded) expandedDetail else null
    val calls = detail?.toolCalls.orEmpty()
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (active) {
                    CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                }
                Text(
                    agentModel.orEmpty(),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = if (active) 8.dp else 0.dp),
                )
                Text(
                    stringResource(taskStateRes(task.state)),
                    style = MaterialTheme.typography.labelMedium,
                    color = when {
                        task.state == "failed" -> MaterialTheme.colorScheme.error
                        active -> MaterialTheme.colorScheme.primary
                        task.state == "completed" -> MaterialTheme.colorScheme.onSurfaceVariant
                        else -> MaterialTheme.colorScheme.tertiary
                    },
                )
            }
            if (expanded) {
                detail?.events.orEmpty().forEach { event ->
                    listOf("reasoningSummary", "text").forEach { key ->
                        event.payload?.get(key)?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }?.let { text ->
                            SelectionContainer { Text(text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp)) }
                        }
                    }
                }
                if (active && calls.isEmpty() && detail?.events.isNullOrEmpty()) {
                    Text(stringResource(R.string.agent_waiting), style = MaterialTheme.typography.bodySmall)
                }
                calls.forEach { call -> ToolCallRow(call) }
            }
            task.summary?.takeIf { it.isNotBlank() }?.let {
                SelectionContainer { Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 8.dp),
                ) }
                CopyMessageButton(it)
            }
            if (task.summary != null || active) {
                Text(
                    text = when {
                        !expanded -> stringResource(R.string.turn_show_details)
                        detail != null || changedFiles != null -> stringResource(
                            R.string.turn_tools_files,
                            calls.size,
                            changedFiles?.size ?: 0,
                        )
                        else -> stringResource(R.string.loading)
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .padding(top = 8.dp)
                        .clickable { onToggleExpand() },
                )
            }
            liveDetail?.pendingApprovals?.forEach { approval ->
                Box(modifier = Modifier.padding(top = 8.dp)) {
                    ApprovalCard(approval = approval, onDecide = onDecide)
                }
            }
        }
    }
}

@Composable
private fun ToolCallRow(call: ToolCallDto) {
    Column {
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            toolIcon(call.tool),
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = toolStateColor(call.state),
        )
        Text(
            text = call.tool + (toolArgsSummary(call.args)?.let { " · $it" } ?: ""),
            style = MaterialTheme.typography.labelMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(start = 6.dp),
        )
        if (call.state in setOf("running", "awaiting_approval", "failed", "rejected")) {
            Text(
                text = stringResource(
                    when (call.state) {
                        "running" -> R.string.state_running
                        "awaiting_approval" -> R.string.state_awaiting_approval
                        else -> R.string.state_failed
                    },
                ),
                style = MaterialTheme.typography.labelSmall,
                color = toolStateColor(call.state),
            )
        }
    }
    call.result?.takeIf { it.isNotBlank() }?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 22.dp, top = 4.dp)) } }
    }
}

@Composable
private fun ApprovalCard(approval: ApprovalDto, onDecide: (String, String) -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(approval.operation, style = MaterialTheme.typography.titleSmall)
            if (approval.reason.isNotBlank()) {
                Text(
                    stringResource(R.string.approval_reason, approval.reason),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            if (approval.riskSummary.isNotBlank()) {
                Text(
                    stringResource(R.string.approval_risk, approval.riskSummary),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
            Row(modifier = Modifier.padding(top = 8.dp)) {
                TextButton(onClick = { onDecide(approval.id, "approve") }) {
                    Text(stringResource(R.string.approve))
                }
                TextButton(onClick = { onDecide(approval.id, "reject") }) {
                    Text(stringResource(R.string.reject))
                }
            }
        }
    }
}
