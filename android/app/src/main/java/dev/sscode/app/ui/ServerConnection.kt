package dev.sscode.app.ui

import dev.sscode.app.api.ApiException
import dev.sscode.app.api.SessionManager
import dev.sscode.app.api.SessionRegistry
import dev.sscode.app.api.SscodeApi
import dev.sscode.app.data.CredentialStore
import dev.sscode.app.data.ServerEntity
import dev.sscode.app.ssh.SshManager
import dev.sscode.app.ssh.SshSession

/** 一次完整的"SSH 会话 + 隧道 + API 客户端"，随界面销毁而关闭。 */
class ServerConnection(
    val session: SshSession,
    val api: SscodeApi,
    val baseUrl: String,
    private val tokenProvider: () -> String,
    val sessionManager: SessionManager? = null,
) {
    val wsBaseUrl: String get() = baseUrl.removeSuffix("/v1").replaceFirst("http://", "ws://")

    /** 会话模式下每次读取都会取内存中最新的 access token（必要时先刷新）。 */
    val token: String get() = tokenProvider()

    fun close() {
        sessionManager?.let { SessionRegistry.unregister(baseUrl, it) }
        session.close()
    }
}

suspend fun connectToApi(
    ssh: SshManager,
    credentials: CredentialStore,
    server: ServerEntity,
    sessionManager: SessionManager? = null,
): ServerConnection {
    val session = ssh.connect(server)
    return try {
        val localPort = session.startLocalForward(localPort = 0, remotePort = 7823)
        val baseUrl = "http://127.0.0.1:$localPort/v1"
        val sm = sessionManager?.takeIf { it.hasRefreshToken }
        if (sm != null) {
            sm.attach(baseUrl)
            SessionRegistry.register(baseUrl, sm)
            val api = SscodeApi(
                baseUrl,
                tokenProvider = { sm.accessTokenBlocking() },
                session = sm,
            )
            ServerConnection(session, api, baseUrl, { sm.accessTokenBlocking().orEmpty() }, sm)
        } else {
            val token = credentials.get(
                CredentialStore.apiTokenRef(server.id),
                CredentialStore.KEY_API_TOKEN,
            ) ?: throw ApiException(code = "missing_token", message = "missing API token; finish deploy on server detail page first")
            ServerConnection(session, SscodeApi(baseUrl, token), baseUrl, { token })
        }
    } catch (e: Exception) {
        session.close()
        throw e
    }
}
