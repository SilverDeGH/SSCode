package dev.sscode.app.ui

import dev.sscode.app.api.ApiException
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
    val token: String,
) {
    val wsBaseUrl: String get() = baseUrl.removeSuffix("/v1").replaceFirst("http://", "ws://")
    fun close() = session.close()
}

suspend fun connectToApi(ssh: SshManager, credentials: CredentialStore, server: ServerEntity): ServerConnection {
    val session = ssh.connect(server)
    val token = credentials.get(
        CredentialStore.apiTokenRef(server.id),
        CredentialStore.KEY_API_TOKEN,
    ) ?: run {
        session.close()
        throw ApiException(code = "missing_token", message = "missing API token; finish deploy on server detail page first")
    }
    return try {
        val localPort = session.startLocalForward(localPort = 0, remotePort = 7823)
        val baseUrl = "http://127.0.0.1:$localPort/v1"
        ServerConnection(session, SscodeApi(baseUrl, token), baseUrl, token)
    } catch (e: Exception) {
        session.close()
        throw e
    }
}
