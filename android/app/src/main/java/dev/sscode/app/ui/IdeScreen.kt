package dev.sscode.app.ui

import android.annotation.SuppressLint
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.sscode.app.R
import dev.sscode.app.api.IdeAccessDto
import dev.sscode.app.api.IdeApi
import dev.sscode.app.api.SessionRegistry
import kotlinx.coroutines.launch
import java.net.URLEncoder

private enum class IdePhase { LOADING, NOT_INSTALLED, UNSUPPORTED, INSTALLING, STOPPED, STARTING, READY }

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun IdeScreen(
    baseUrl: String,
    token: String,
    projectPath: String,
    ideLocalPort: Int,
    onBack: () -> Unit,
) {
    // 会话模式：按隧道 origin 找回 SessionManager，逐请求取最新 access token（含 401 刷新重试）
    val session = remember(baseUrl) { SessionRegistry.forUrl(baseUrl) }
    val api = remember(session) {
        if (session != null) IdeApi(baseUrl, { session.accessTokenBlocking() }, session)
        else IdeApi(baseUrl, token)
    }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current

    var phase by remember { mutableStateOf(IdePhase.LOADING) }
    var version by remember { mutableStateOf<String?>(null) }
    var access by remember { mutableStateOf<IdeAccessDto?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var passwordVisible by remember { mutableStateOf(false) }
    var webView by remember { mutableStateOf<WebView?>(null) }

    val ideUrl = remember(ideLocalPort, projectPath) {
        "http://127.0.0.1:$ideLocalPort/?folder=${URLEncoder.encode(projectPath, "UTF-8")}"
    }
    val passwordCopiedText = stringResource(R.string.ide_password_copied)

    fun refreshStatus() {
        scope.launch {
            errorMessage = null
            try {
                val status = api.status()
                version = status.version
                when {
                    status.hostUnsupported && !status.installed -> phase = IdePhase.UNSUPPORTED
                    !status.installed -> phase = IdePhase.NOT_INSTALLED
                    !status.running -> phase = IdePhase.STOPPED
                    else -> {
                        access = api.access()
                        phase = IdePhase.READY
                    }
                }
            } catch (e: Exception) {
                errorMessage = e.message ?: e.javaClass.simpleName
                phase = IdePhase.LOADING
            }
        }
    }

    LaunchedEffect(Unit) { refreshStatus() }

    val keyboard = LocalSoftwareKeyboardController.current
    val keyboardVisible = WindowInsets.isImeVisible
    fun stepBack() {
        if (keyboardVisible) keyboard?.hide() else onBack()
    }
    // Return to the workspace, not through code-server login/editor browser history.
    BackHandler { stepBack() }

    DisposableEffect(Unit) {
        onDispose {
            // 只销毁 WebView；本地端口转发由调用方管理，这里不处理。
            webView?.destroy()
            webView = null
        }
    }

    Scaffold(
        modifier = Modifier.imePadding(),
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(stringResource(R.string.ide_title))
                        Text(
                            stringResource(R.string.ide_landscape_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = { stepBack() }) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.ide_back_workspace),
                        )
                    }
                },
                actions = {
                    IconButton(onClick = {
                        webView?.reload()
                        refreshStatus()
                    }) {
                        Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.ide_reconnect))
                    }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
            when (phase) {
                IdePhase.LOADING -> CenterBox {
                    if (errorMessage != null) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                stringResource(R.string.ide_error, errorMessage.orEmpty()),
                                color = MaterialTheme.colorScheme.error,
                            )
                            TextButton(onClick = { refreshStatus() }) {
                                Text(stringResource(R.string.retry))
                            }
                        }
                    } else {
                        Text(
                            stringResource(R.string.ide_checking),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                IdePhase.UNSUPPORTED -> CenterBox {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.padding(32.dp),
                    ) {
                        Text(
                            stringResource(R.string.ide_wsl_guide_title),
                            style = MaterialTheme.typography.titleSmall,
                        )
                        Text(
                            stringResource(R.string.ide_wsl_guide_message),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(onClick = { refreshStatus() }) {
                            Text(stringResource(R.string.retry))
                        }
                    }
                }

                IdePhase.NOT_INSTALLED -> CenterBox {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.padding(32.dp),
                    ) {
                        Text(stringResource(R.string.ide_not_installed))
                        if (errorMessage != null) {
                            Text(
                                stringResource(R.string.ide_install_failed, errorMessage.orEmpty()),
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Button(onClick = {
                            scope.launch {
                                phase = IdePhase.INSTALLING
                                errorMessage = null
                                try {
                                    val resp = api.install()
                                    version = resp.version
                                    refreshStatus()
                                } catch (e: Exception) {
                                    errorMessage = e.message ?: e.javaClass.simpleName
                                    phase = IdePhase.NOT_INSTALLED
                                }
                            }
                        }) { Text(stringResource(R.string.ide_install)) }
                    }
                }

                IdePhase.INSTALLING -> CenterBox {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier.padding(32.dp),
                    ) {
                        Text(stringResource(R.string.ide_installing))
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }

                IdePhase.STOPPED -> CenterBox {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.padding(32.dp),
                    ) {
                        version?.let {
                            Text(
                                stringResource(R.string.ide_version, it),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Text(stringResource(R.string.ide_stopped_hint))
                        if (errorMessage != null) {
                            Text(
                                stringResource(R.string.ide_error, errorMessage.orEmpty()),
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Button(onClick = {
                            scope.launch {
                                phase = IdePhase.STARTING
                                errorMessage = null
                                try {
                                    api.start()
                                    access = api.access()
                                    phase = IdePhase.READY
                                } catch (e: Exception) {
                                    errorMessage = e.message ?: e.javaClass.simpleName
                                    phase = IdePhase.STOPPED
                                }
                            }
                        }) { Text(stringResource(R.string.ide_start)) }
                    }
                }

                IdePhase.STARTING -> CenterBox {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier.padding(32.dp),
                    ) {
                        Text(stringResource(R.string.ide_starting))
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }

                IdePhase.READY -> Column(modifier = Modifier.fillMaxSize()) {
                    val wslAccess = access?.wsl == true
                    if (!keyboardVisible && wslAccess) Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            stringResource(R.string.ide_wsl_password_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    if (!keyboardVisible && !wslAccess) Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = stringResource(R.string.ide_password_label) + ": " +
                                if (passwordVisible) access?.password.orEmpty() else "••••••••",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                            maxLines = 1,
                        )
                        IconButton(onClick = { passwordVisible = !passwordVisible }) {
                            Icon(
                                if (passwordVisible) Icons.Filled.VisibilityOff
                                else Icons.Filled.Visibility,
                                contentDescription = stringResource(
                                    if (passwordVisible) R.string.ide_hide_password
                                    else R.string.ide_show_password,
                                ),
                            )
                        }
                        TextButton(onClick = {
                            clipboard.setText(AnnotatedString(access?.password.orEmpty()))
                            Toast.makeText(context, passwordCopiedText, Toast.LENGTH_SHORT).show()
                        }) { Text(stringResource(R.string.ide_copy_password)) }
                    }
                    CodeServerWebView(
                        url = ideUrl,
                        onCreated = { webView = it },
                        modifier = Modifier.fillMaxWidth().weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun CenterBox(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        content()
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun CodeServerWebView(
    url: String,
    onCreated: (WebView) -> Unit,
    modifier: Modifier = Modifier,
) {
    var loadProgress by remember { mutableStateOf(0) }
    var loadFailed by remember { mutableStateOf(false) }
    Box(modifier) {
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            WebView(ctx).apply {
                webChromeClient = object : WebChromeClient() {
                    override fun onProgressChanged(view: WebView, progress: Int) { loadProgress = progress }
                }
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.useWideViewPort = false
                settings.loadWithOverviewMode = false
                settings.setSupportZoom(true)
                settings.builtInZoomControls = true
                settings.displayZoomControls = false
                settings.textZoom = 100
                settings.javaScriptCanOpenWindowsAutomatically = true
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                settings.setSupportMultipleWindows(false)
                webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                        loadFailed = false
                    }
                    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                        if (request.isForMainFrame) loadFailed = true
                    }
                    override fun onPageFinished(view: WebView, url: String) {
                        // Keep the editor's responsive layout at the actual device width.
                        view.evaluateJavascript(
                            """(function(){let m=document.querySelector('meta[name="viewport"]');if(!m){m=document.createElement('meta');m.name='viewport';document.head.appendChild(m);}m.content='width=device-width, initial-scale=1, viewport-fit=cover';window.dispatchEvent(new Event('resize'));})()""",
                            null,
                        )
                    }
                    override fun shouldOverrideUrlLoading(
                        view: WebView,
                        request: WebResourceRequest,
                    ): Boolean {
                        val host = request.url.host.orEmpty()
                        // 只允许回环地址导航，其余一律拦截（code-server 回环 http 环境）。
                        return !(host == "127.0.0.1" || host == "localhost")
                    }
                }
                onCreated(this)
                loadUrl(url)
            }
        },

    )
    if (loadFailed) {
        Text(stringResource(R.string.ide_web_load_failed), modifier = Modifier.align(Alignment.TopCenter).padding(16.dp), color = MaterialTheme.colorScheme.error)
    } else if (loadProgress < 100) {
        Column(Modifier.fillMaxWidth().align(Alignment.TopCenter)) {
            LinearProgressIndicator(progress = { loadProgress / 100f }, modifier = Modifier.fillMaxWidth())
            Text(stringResource(R.string.ide_web_loading), modifier = Modifier.padding(8.dp), style = MaterialTheme.typography.bodySmall)
        }
    }
    }
}

