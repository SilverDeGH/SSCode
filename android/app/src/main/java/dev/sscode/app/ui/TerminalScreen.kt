package dev.sscode.app.ui

import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.ui.draw.clip
import androidx.compose.material3.ButtonDefaults
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.sscode.app.R
import dev.sscode.app.api.TerminalCallbacks
import dev.sscode.app.api.TerminalWsClient
import dev.sscode.app.terminal.TerminalModel

private val TERM_BG = Color(0xFF101722)
private val TERM_FG = Color(0xFFDCE6F2)

/** ANSI 16 色调色板（索引 0-15，与 TerminalModel 的 fg 对应）。 */
private val ANSI_PALETTE = listOf(
    Color(0xFF000000), Color(0xFFCD3131), Color(0xFF0DBC79), Color(0xFFE5E510),
    Color(0xFF2472C8), Color(0xFFBC3FBC), Color(0xFF11A8CD), Color(0xFFE5E5E5),
    Color(0xFF666666), Color(0xFFF14C4C), Color(0xFF23D18B), Color(0xFFF5F543),
    Color(0xFF3B8EEA), Color(0xFFD670D6), Color(0xFF29B8DB), Color(0xFFFFFFFF),
)

private fun buildAnnotated(line: TerminalModel.TerminalLine): AnnotatedString {
    val builder = AnnotatedString.Builder()
    var runColor = -2
    var runStart = 0

    fun flush(end: Int) {
        if (runColor in 0..15 && end > runStart) {
            builder.addStyle(SpanStyle(color = ANSI_PALETTE[runColor]), runStart, end)
        }
    }

    for (i in 0 until line.length) {
        val c = line.chars[i]
        if (c == '\u0000') continue // 宽字符占位格
        val col = line.fg.getOrElse(i) { -1 }
        if (col != runColor) {
            flush(builder.length)
            runColor = col
            runStart = builder.length
        }
        builder.append(c)
    }
    flush(builder.length)
    return builder.toAnnotatedString()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    wsBaseUrl: String,
    token: String,
    projectId: String,
    onBack: () -> Unit,
) {
    val model = remember { TerminalModel(80, 24) }
    var modelVersion by remember { mutableIntStateOf(0) }
    var connected by remember { mutableStateOf(false) }
    var disconnected by remember { mutableStateOf(false) }
    var fontSize by remember { mutableFloatStateOf(13f) }
    var ctrlLatch by remember { mutableStateOf(false) }
    var input by remember { mutableStateOf("") }
    var connectNonce by remember { mutableIntStateOf(0) }
    var terminalBackend by remember { mutableStateOf<String?>(null) }
    val clientState = remember { mutableStateOf<TerminalWsClient?>(null) }
    val mainHandler = remember { Handler(Looper.getMainLooper()) }
    val clipboard = LocalClipboardManager.current

    DisposableEffect(wsBaseUrl, token, projectId, connectNonce) {
        val client = TerminalWsClient(wsBaseUrl, token)
        clientState.value = client
        connected = false
        disconnected = false
        terminalBackend = null
        client.connect(projectId, object : TerminalCallbacks {
            override fun onReady(backendName: String) {
                mainHandler.post {
                    connected = true
                    disconnected = false
                    terminalBackend = backendName
                }
            }

            override fun onOutput(data: String) {
                model.feed(data)
                mainHandler.post { modelVersion = model.version }
            }

            override fun onClosed(reason: String) {
                mainHandler.post {
                    connected = false
                    disconnected = true
                }
            }

            override fun onFailure(error: String) {
                mainHandler.post {
                    connected = false
                    disconnected = true
                }
            }
        })
        onDispose {
            clientState.value = null
            client.close()
        }
    }

    fun sendRaw(s: String) {
        if (connected) clientState.value?.sendInput(s)
    }

    fun sendKey(s: String) {
        var out = s
        if (ctrlLatch && out.length == 1) {
            out = when (val c = out[0]) {
                in 'a'..'z' -> (c.code - 'a'.code + 1).toChar().toString()
                in 'A'..'Z' -> (c.code - 'A'.code + 1).toChar().toString()
                '[' -> "\u001B"
                else -> out
            }
        }
        ctrlLatch = false
        sendRaw(out)
    }

    fun submitInput() {
        val text = input
        if (!connected) return
        if (text.isEmpty()) { sendRaw("\r"); return }
        if (ctrlLatch && text.length == 1) {
            sendKey(text)
        } else {
            sendRaw(text + "\n")
        }
        ctrlLatch = false
        input = ""
    }

    val statusText = when {
        connected -> stringResource(R.string.connected)
        disconnected -> stringResource(R.string.terminal_disconnected)
        else -> stringResource(R.string.terminal_connecting)
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            Row(
                Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    statusText,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (connected) Color(0xFF238568) else MaterialTheme.colorScheme.error,
                )
                TextButton(onClick = { fontSize = (fontSize - 1f).coerceAtLeast(8f) }) {
                    Text(stringResource(R.string.terminal_font_smaller))
                }
                TextButton(onClick = { fontSize = (fontSize + 1f).coerceAtMost(24f) }) {
                    Text(stringResource(R.string.terminal_font_larger))
                }
            }
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            // 非 tmux 后端明示限制（需求 9.2 差异如实提示）：Windows persist 不支持全屏程序
            if (connected && terminalBackend != null && terminalBackend != "tmux") {
                Text(
                    stringResource(R.string.terminal_backend_limited, terminalBackend.orEmpty()),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 10.dp, vertical = 2.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(horizontal = 8.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(TERM_BG),
            ) {
                BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
                    val density = LocalDensity.current
                    val charW = with(density) { (fontSize * 0.6f).sp.toPx() }
                    val lineH = with(density) { (fontSize * 1.35f).sp.toPx() }
                    val cols = ((constraints.maxWidth - with(density) { 16.dp.toPx() }) / charW).toInt().coerceIn(20, 400)
                    val rows = (constraints.maxHeight / lineH).toInt().coerceIn(5, 200)

                    LaunchedEffect(cols, rows, connected) {
                        model.resize(cols, rows)
                        modelVersion = model.version
                        if (connected) clientState.value?.sendResize(cols, rows)
                    }

                    val lines = remember(modelVersion) { model.snapshot() }
                    val listState = rememberLazyListState()
                    var followTail by remember { mutableStateOf(true) }

                    LaunchedEffect(Unit) {
                        snapshotFlow { listState.canScrollForward }.collect { followTail = !it }
                    }
                    LaunchedEffect(modelVersion) {
                        if (followTail && lines.isNotEmpty()) {
                            listState.scrollToItem(lines.size - 1)
                        }
                    }

                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize().padding(horizontal = 8.dp),
                    ) {
                        items(lines.size) { index ->
                            Text(
                                text = buildAnnotated(lines[index]),
                                color = TERM_FG,
                                fontFamily = FontFamily.Monospace,
                                fontSize = fontSize.sp,
                                letterSpacing = 0.sp,
                                lineHeight = (fontSize * 1.35f).sp,
                                softWrap = false,
                                maxLines = 1,
                                overflow = TextOverflow.Clip,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }

                if (disconnected) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(Color(0xCC000000)),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            stringResource(R.string.terminal_reconnect_hint),
                            color = Color.White,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Button(
                            onClick = { connectNonce++ },
                            modifier = Modifier.padding(top = 12.dp),
                        ) {
                            Text(stringResource(R.string.terminal_reconnect))
                        }
                    }
                }
            }

            // 固定两排快捷键，手机上无需横向滚动寻找按键。
            Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 1.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                TermKey("Esc", Modifier.weight(1f), connected) { sendKey("\u001B") }
                TermKey(if (ctrlLatch) "Ctrl*" else "Ctrl", Modifier.weight(1f), connected) { ctrlLatch = !ctrlLatch }
                TermKey("Tab", Modifier.weight(1f), connected) {
                    if (input.isNotEmpty()) { sendRaw(input); input = "" }
                    sendKey("\t")
                }
                TermKey("Ctrl+C", Modifier.weight(1f), connected) { sendRaw("\u0003") }
                TermKey(stringResource(R.string.terminal_paste), Modifier.weight(1f), connected) {
                    clipboard.getText()?.text?.let { input += it }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TermKey("←", Modifier.weight(1f), connected) { sendRaw("\u001B[D") }
                TermKey("↓", Modifier.weight(1f), connected) { sendRaw("\u001B[B") }
                TermKey("↑", Modifier.weight(1f), connected) { sendRaw("\u001B[A") }
                TermKey("→", Modifier.weight(1f), connected) { sendRaw("\u001B[C") }
                TermKey("⌫", Modifier.weight(1f), connected) {
                    if (input.isNotEmpty()) input = input.dropLast(1) else sendRaw("\u007F")
                }
            }
            }

            // 输入行：回车发送 text + \n
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = { Text(stringResource(R.string.terminal_input_hint)) },
                    singleLine = true,
                    enabled = connected,
                    shape = RoundedCornerShape(16.dp),
                    textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, autoCorrectEnabled = false, imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { submitInput() }),
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { submitInput() }, enabled = connected) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.send))
                }
            }
        }
    }
}

@Composable
private fun TermKey(label: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 48.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surfaceVariant, contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
        shape = RoundedCornerShape(10.dp), contentPadding = PaddingValues(horizontal = 2.dp, vertical = 2.dp)) {
        Text(label, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelMedium)
    }
}
