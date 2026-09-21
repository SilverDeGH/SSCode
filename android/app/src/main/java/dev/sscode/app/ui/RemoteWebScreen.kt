package dev.sscode.app.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.sscode.app.AppContainer
import dev.sscode.app.R
import dev.sscode.app.ssh.SshSession
import kotlinx.coroutines.CancellationException

/** Dedicated tunnel survives workspace API reconnects while the preview remains open. */
@SuppressLint("SetJavaScriptEnabled")
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RemoteWebScreen(serverId: Long, remotePort: Int, onBack: () -> Unit) {
    val context = LocalContext.current
    var url by remember { mutableStateOf<String?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    var view by remember { mutableStateOf<WebView?>(null) }
    BackHandler { onBack() }
    LaunchedEffect(serverId, remotePort, retry) {
        var session: SshSession? = null
        url = null
        failure = null
        try {
            val server = AppContainer.database(context).serverDao().getById(serverId) ?: error("Server not found")
            session = AppContainer.ssh(context).connect(server)
            val port = session.startLocalForward(remotePort = remotePort)
            url = "http://127.0.0.1:$port/"
            kotlinx.coroutines.awaitCancellation()
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { failure = e.message }
        finally { session?.close() }
    }
    DisposableEffect(Unit) { onDispose { view?.destroy(); view = null } }
    Scaffold(topBar = {
        TopAppBar(title = { Text(":$remotePort", style = MaterialTheme.typography.titleMedium) },
            navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.back)) } },
            actions = {
                TextButton(onClick = { retry++ }) { Text(stringResource(R.string.retry)) }
                TextButton(enabled = url != null, onClick = {
                    try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url!!))) }
                    catch (e: Exception) { failure = e.message }
                }) { Text(stringResource(R.string.web_browser)) }
            })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Text(stringResource(R.string.web_tunnel_hint), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(8.dp))
            failure?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(8.dp)) }
            val address = url
            if (address == null) { if (failure == null) LinearProgressIndicator(Modifier.fillMaxWidth()) }
            else key(address) {
                AndroidView(modifier = Modifier.fillMaxSize(), factory = { ctx ->
                    WebView(ctx).apply {
                        view = this
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(v: WebView, request: android.webkit.WebResourceRequest): Boolean =
                                request.url.scheme !in listOf("http", "https")
                        }
                        loadUrl(address)
                    }
                }, onRelease = { it.destroy(); if (view === it) view = null })
            }
        }
    }
}
