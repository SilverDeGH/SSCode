package dev.sscode.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.sscode.app.R
import dev.sscode.app.api.ApiException
import dev.sscode.app.api.FilesApi
import dev.sscode.app.api.SessionRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val CodeTextStyle = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontSize = 13.sp,
    lineHeight = 18.sp,
)

private class HighlightTransformation(
    private val query: String,
    private val color: Color,
) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        if (query.isEmpty()) return TransformedText(text, OffsetMapping.Identity)
        val highlighted = buildAnnotatedString {
            append(text)
            var index = text.text.indexOf(query, startIndex = 0, ignoreCase = true)
            while (index >= 0) {
                addStyle(SpanStyle(background = color), index, index + query.length)
                index = text.text.indexOf(query, startIndex = index + query.length, ignoreCase = true)
            }
        }
        return TransformedText(highlighted, OffsetMapping.Identity)
    }
}

private fun findMatches(text: String, query: String): List<Int> {
    if (query.isEmpty()) return emptyList()
    val result = ArrayList<Int>()
    var index = text.indexOf(query, startIndex = 0, ignoreCase = true)
    while (index >= 0) {
        result.add(index)
        index = text.indexOf(query, startIndex = index + query.length, ignoreCase = true)
    }
    return result
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditorScreen(
    baseUrl: String,
    token: String,
    projectId: String,
    filePath: String,
    onBack: () -> Unit,
) {
    // 会话模式：按隧道 origin 找回 SessionManager，逐请求取最新 access token（含 401 刷新重试）
    val session = remember(baseUrl) { SessionRegistry.forUrl(baseUrl) }
    val api = remember(session) {
        if (session != null) FilesApi(baseUrl, { session.accessTokenBlocking() }, session)
        else FilesApi(baseUrl, token)
    }
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }

    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var truncated by remember { mutableStateOf(false) }
    var content by remember { mutableStateOf(TextFieldValue("")) }
    var loadedContent by remember { mutableStateOf("") }
    var loadedHash by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var showConflict by remember { mutableStateOf(false) }
    var showExitDialog by remember { mutableStateOf(false) }
    var findOpen by remember { mutableStateOf(false) }
    var findQuery by remember { mutableStateOf("") }
    // 下拉刷新指示器脉冲：dirty 拦截时不走 load()，用脉冲让指示器正常回弹收起
    var refreshPulse by remember { mutableStateOf(false) }

    val dirty = content.text != loadedContent
    val fileName = filePath.substringAfterLast('/')
    val noMatchText = stringResource(R.string.editor_no_match)
    val refreshBlockedText = stringResource(R.string.editor_refresh_blocked)
    val saveErrorFmt = stringResource(R.string.editor_save_error)

    fun load() {
        scope.launch {
            loading = true
            loadError = null
            try {
                val resp = api.content(projectId, filePath)
                content = TextFieldValue(resp.content)
                loadedContent = resp.content
                loadedHash = resp.hash
                truncated = resp.truncated
            } catch (e: Exception) {
                loadError = e.message ?: e.javaClass.simpleName
            } finally {
                loading = false
            }
        }
    }

    fun save(force: Boolean, onSuccess: (() -> Unit)? = null) {
        if (saving || truncated) return
        scope.launch {
            saving = true
            try {
                val resp = api.write(
                    projectId = projectId,
                    path = filePath,
                    content = content.text,
                    baseHash = if (force) null else loadedHash,
                )
                loadedHash = resp.hash
                loadedContent = content.text
                showConflict = false
                onSuccess?.invoke()
            } catch (e: ApiException) {
                if (e.httpStatus == 409) {
                    showConflict = true
                } else {
                    snackbar.showSnackbar(saveErrorFmt.format(e.message ?: e.code))
                }
            } catch (e: Exception) {
                snackbar.showSnackbar(saveErrorFmt.format(e.message ?: "error"))
            } finally {
                saving = false
            }
        }
    }

    fun jumpToNextMatch() {
        val matches = findMatches(content.text, findQuery)
        if (matches.isEmpty()) {
            if (findQuery.isNotEmpty()) {
                scope.launch { snackbar.showSnackbar(noMatchText) }
            }
            return
        }
        val from = maxOf(content.selection.end, 0)
        val start = matches.firstOrNull { it >= from } ?: matches.first()
        content = TextFieldValue(
            text = content.text,
            selection = TextRange(start, start + findQuery.length),
        )
    }

    LaunchedEffect(filePath) { load() }

    fun stepBack() {
        when {
            findOpen -> findOpen = false
            dirty -> showExitDialog = true
            else -> onBack()
        }
    }
    BackHandler { stepBack() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(fileName, maxLines = 1)
                        if (dirty) {
                            Spacer(modifier = Modifier.width(6.dp))
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .background(MaterialTheme.colorScheme.primary, CircleShape),
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = { stepBack() }) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.back),
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { findOpen = !findOpen }) {
                        Icon(Icons.Filled.Search, contentDescription = stringResource(R.string.editor_find))
                    }
                    TextButton(
                        onClick = { save(force = false) },
                        enabled = dirty && !saving && !truncated,
                    ) { Text(stringResource(R.string.save)) }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            if (findOpen) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = findQuery,
                        onValueChange = { findQuery = it },
                        placeholder = { Text(stringResource(R.string.editor_find_hint)) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = { jumpToNextMatch() }) {
                        Icon(
                            Icons.Filled.KeyboardArrowDown,
                            contentDescription = stringResource(R.string.editor_find_next),
                        )
                    }
                    IconButton(onClick = { findOpen = false; findQuery = "" }) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = stringResource(R.string.editor_close_find),
                        )
                    }
                }
            }

            if (truncated) {
                Text(
                    stringResource(R.string.editor_truncated_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                )
            }

            PullToRefreshBox(
                isRefreshing = loading || refreshPulse,
                onRefresh = {
                    if (dirty) {
                        scope.launch {
                            refreshPulse = true
                            launch { snackbar.showSnackbar(refreshBlockedText) }
                            delay(400)
                            refreshPulse = false
                        }
                    } else {
                        load()
                    }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
            when {
                loading -> Box(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
                    Text(
                        stringResource(R.string.loading),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                loadError != null -> Box(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            stringResource(R.string.editor_load_error, loadError.orEmpty()),
                            color = MaterialTheme.colorScheme.error,
                        )
                        TextButton(onClick = { load() }) { Text(stringResource(R.string.retry)) }
                    }
                }

                else -> {
                    val lineCount = content.text.count { it == '\n' } + 1
                    val verticalScroll = rememberScrollState()
                    val horizontalScroll = rememberScrollState()
                    val highlightColor = MaterialTheme.colorScheme.tertiaryContainer
                    val highlight = remember(findQuery, highlightColor) {
                        HighlightTransformation(findQuery, highlightColor)
                    }
                    Row(modifier = Modifier.fillMaxSize().verticalScroll(verticalScroll)) {
                        Column(
                            modifier = Modifier.padding(start = 8.dp, end = 8.dp, top = 4.dp),
                            horizontalAlignment = Alignment.End,
                        ) {
                            for (i in 1..lineCount) {
                                Text(
                                    text = i.toString(),
                                    style = CodeTextStyle,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        BasicTextField(
                            value = content,
                            onValueChange = { content = it },
                            textStyle = CodeTextStyle.copy(color = MaterialTheme.colorScheme.onSurface),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            visualTransformation = highlight,
                            readOnly = truncated,
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(horizontalScroll)
                                .padding(start = 8.dp, end = 8.dp, top = 4.dp),
                        )
                    }
                }
            }
            }
        }
    }

    if (showConflict) {
        AlertDialog(
            modifier = Modifier.dismissKeyboardOnBackgroundTap(),
            onDismissRequest = { showConflict = false },
            title = { Text(stringResource(R.string.editor_conflict_title)) },
            text = { Text(stringResource(R.string.editor_conflict_message)) },
            confirmButton = {
                TextButton(onClick = { showConflict = false; load() }) {
                    Text(stringResource(R.string.editor_reload))
                }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = { save(force = true) }) {
                        Text(stringResource(R.string.editor_force_save))
                    }
                    TextButton(onClick = { showConflict = false }) {
                        Text(stringResource(R.string.cancel))
                    }
                }
            },
        )
    }

    if (showExitDialog) {
        AlertDialog(
            modifier = Modifier.dismissKeyboardOnBackgroundTap(),
            onDismissRequest = { showExitDialog = false },
            title = { Text(stringResource(R.string.editor_unsaved_title)) },
            text = { Text(stringResource(R.string.editor_unsaved_message)) },
            confirmButton = {
                TextButton(onClick = {
                    showExitDialog = false
                    save(force = false, onSuccess = onBack)
                }) { Text(stringResource(R.string.save)) }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = { showExitDialog = false; onBack() }) {
                        Text(stringResource(R.string.editor_discard))
                    }
                    TextButton(onClick = { showExitDialog = false }) {
                        Text(stringResource(R.string.cancel))
                    }
                }
            },
        )
    }
}
