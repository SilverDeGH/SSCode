package dev.sscode.app.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** 终端 WS 回调，全部发生在 OkHttp 后台线程，UI 侧需自行切主线程。 */
interface TerminalCallbacks {
    fun onReady(backend: String)
    fun onOutput(data: String)
    fun onClosed(reason: String)
    /** httpStatus 为升级被拒绝时的 HTTP 状态码（如 401）；非 HTTP 失败为 null。 */
    fun onFailure(error: String, httpStatus: Int?)
}

@Serializable
private data class TerminalFrame(
    val type: String = "",
    val backend: String = "",
    val data: String = "",
)

@Serializable
private data class TerminalInputFrame(val type: String, val data: String)

@Serializable
private data class TerminalResizeFrame(val type: String, val cols: Int, val rows: Int)

/**
 * 终端 WebSocket 客户端。
 * wsBaseUrl 形如 ws://127.0.0.1:<本地转发端口>（不含 /v1）。
 * 断开后重新 [connect] 即可接回服务端持久会话（tmux）。
 * 旧静态 token：`TerminalWsClient(wsBaseUrl, token)`；设备会话：传 [tokenProvider]，
 * 每次 connect/reconnect 取最新 access token（服务端升级握手在迁移窗口内只认静态令牌）。
 */
class TerminalWsClient(private val wsBaseUrl: String, private val tokenProvider: () -> String?) {

    constructor(wsBaseUrl: String, token: String) : this(wsBaseUrl, { token })

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // WS 长连接不设读超时
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }

    @Volatile
    private var ws: WebSocket? = null

    fun connect(projectId: String, callbacks: TerminalCallbacks) {
        val base = wsBaseUrl.trimEnd('/')
        val token = tokenProvider().orEmpty()
        val url = "$base/v1/terminal/ws?projectId=${enc(projectId)}&token=${enc(token)}"
        ws = client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = try {
                        json.decodeFromString<TerminalFrame>(text)
                    } catch (_: Exception) {
                        return
                    }
                    when (frame.type) {
                        "ready" -> callbacks.onReady(frame.backend)
                        "output" -> callbacks.onOutput(frame.data)
                        "exit" -> {
                            callbacks.onClosed("exit")
                            webSocket.close(1000, null)
                        }
                    }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    callbacks.onClosed(reason.ifBlank { "code $code" })
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    callbacks.onFailure(t.message ?: "connection failed", response?.code)
                }
            },
        )
    }

    fun sendInput(data: String): Boolean {
        val socket = ws ?: return false
        return socket.send(
            json.encodeToString(TerminalInputFrame.serializer(), TerminalInputFrame("input", data)),
        )
    }

    fun sendResize(cols: Int, rows: Int): Boolean {
        val socket = ws ?: return false
        return socket.send(
            json.encodeToString(TerminalResizeFrame.serializer(), TerminalResizeFrame("resize", cols, rows)),
        )
    }

    /** 仅断开本地连接，不终止服务端会话。 */
    fun close() {
        ws?.close(1000, null)
        ws = null
    }

    private fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")
}
