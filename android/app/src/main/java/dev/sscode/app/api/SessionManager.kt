package dev.sscode.app.api

import dev.sscode.app.data.CredentialStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Authenticator
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URI
import java.util.concurrent.TimeUnit

// ------------------------------------------------------------------ DTO

@Serializable
data class LinkResponse(
    val deviceId: String,
    val accessToken: String,
    val accessTokenExpiresAt: Long,
    val refreshToken: String,
    val refreshTokenExpiresAt: Long = 0,
    val role: String = "",
)

@Serializable
data class RefreshResponse(
    val deviceId: String,
    val accessToken: String,
    val accessTokenExpiresAt: Long,
    val refreshToken: String,
    val refreshTokenExpiresAt: Long = 0,
)

@Serializable
private data class LinkRequest(
    val deviceName: String,
    val name: String,
    val baseUrl: String,
    val model: String,
    val apiKey: String,
)

@Serializable
private data class RefreshRequest(val refreshToken: String)

@Serializable
private data class AuthErrorBody(val error: AuthErrorDetail? = null)

@Serializable
private data class AuthErrorDetail(val code: String = "unknown", val message: String = "")

// ------------------------------------------------------------------ 公开认证调用

private val authJson = Json { ignoreUnknownKeys = true }
private val authMediaType = "application/json; charset=utf-8".toMediaType()
private val authClient = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .build()

private inline fun <reified T> executeAuth(request: Request): T {
    authClient.newCall(request).execute().use { response ->
        val body = response.body?.string().orEmpty()
        if (!response.isSuccessful) {
            val parsed = try {
                authJson.decodeFromString<AuthErrorBody>(body)
            } catch (_: Exception) {
                null
            }
            throw ApiException(
                code = parsed?.error?.code ?: "http_${response.code}",
                message = parsed?.error?.message ?: body.take(300).ifBlank { "HTTP ${response.code}" },
                httpStatus = response.code,
            )
        }
        return authJson.decodeFromString(body)
    }
}

/** POST /v1/auth/link（公开端点）。apiKey 只出现在本次请求体内，不落盘、不入日志。 */
suspend fun linkDevice(
    serverBaseUrl: String,
    deviceName: String,
    name: String,
    baseUrl: String,
    model: String,
    apiKey: String,
): LinkResponse = withContext(Dispatchers.IO) {
    val body = authJson.encodeToString(
        LinkRequest.serializer(),
        LinkRequest(deviceName, name, baseUrl, model, apiKey),
    )
    executeAuth(
        Request.Builder()
            .url("$serverBaseUrl/auth/link")
            .post(body.toRequestBody(authMediaType))
            .build(),
    )
}

// ------------------------------------------------------------------ 会话管理

/**
 * 单台服务器的设备会话：access token 仅存内存，refresh token / deviceId 存 CredentialStore。
 * OkHttp 可能并发触发刷新，全部状态变更在 [lock] 内串行。
 */
class SessionManager(val serverId: Long, private val credentials: CredentialStore) {

    enum class State { ACTIVE, EXPIRED }

    companion object {
        /** 提前 30 秒主动刷新，避免请求半途撞上过期点 */
        private const val REFRESH_MARGIN_MS = 30_000L
    }

    private val lock = Any()

    private val _state = MutableStateFlow(State.ACTIVE)

    /** EXPIRED = 刷新失败且不可恢复（401/429/网络），UI 层应引导重新绑定 */
    val state: StateFlow<State> = _state

    /** 本次 SSH 隧道的 baseUrl（http://127.0.0.1:<port>/v1），每次连接后更新 */
    @Volatile
    private var baseUrl: String? = null

    @Volatile
    private var accessToken: String? = null

    @Volatile
    private var accessTokenExpiresAt: Long = 0L

    val deviceId: String?
        get() = credentials.get(CredentialStore.deviceIdRef(serverId), CredentialStore.KEY_DEVICE_ID)

    val hasRefreshToken: Boolean
        get() = credentials.get(CredentialStore.refreshTokenRef(serverId), CredentialStore.KEY_REFRESH_TOKEN) != null

    fun attach(baseUrl: String) {
        this.baseUrl = baseUrl
    }

    /** 绑定成功后写入：refresh token / deviceId 落加密存储，access token 只进内存。 */
    fun onLinked(baseUrl: String, result: LinkResponse) {
        synchronized(lock) {
            attach(baseUrl)
            accessToken = result.accessToken
            accessTokenExpiresAt = result.accessTokenExpiresAt
            credentials.set(
                CredentialStore.refreshTokenRef(serverId),
                CredentialStore.KEY_REFRESH_TOKEN,
                result.refreshToken,
            )
            credentials.set(
                CredentialStore.deviceIdRef(serverId),
                CredentialStore.KEY_DEVICE_ID,
                result.deviceId,
            )
            _state.value = State.ACTIVE
        }
    }

    /** 每次请求前取 token；临近过期则同步阻塞刷新（调用方须在 IO 线程）。 */
    fun accessTokenBlocking(): String? {
        val token = accessToken
        if (token != null && System.currentTimeMillis() < accessTokenExpiresAt - REFRESH_MARGIN_MS) {
            return token
        }
        return refreshBlocking(failedToken = null)
    }

    /**
     * 刷新并轮换 token。
     * @param failedToken 401 时请求用过的 token；非空表示被动刷新，
     * 若其他线程已轮换到新 token 则直接复用，保证每个请求只重试一次。
     */
    fun refreshBlocking(failedToken: String?): String? {
        synchronized(lock) {
            val now = System.currentTimeMillis()
            val current = accessToken
            if (failedToken == null) {
                if (current != null && now < accessTokenExpiresAt - REFRESH_MARGIN_MS) return current
            } else if (current != null && current != failedToken && now < accessTokenExpiresAt) {
                return current
            }
            val refreshToken = credentials.get(
                CredentialStore.refreshTokenRef(serverId),
                CredentialStore.KEY_REFRESH_TOKEN,
            )
            val url = baseUrl
            if (refreshToken == null || url == null) {
                if (refreshToken == null) _state.value = State.EXPIRED
                return null
            }
            return try {
                val body = authJson.encodeToString(RefreshRequest.serializer(), RefreshRequest(refreshToken))
                val refreshed = executeAuth<RefreshResponse>(
                    Request.Builder()
                        .url("$url/auth/refresh")
                        .post(body.toRequestBody(authMediaType))
                        .build(),
                )
                accessToken = refreshed.accessToken
                accessTokenExpiresAt = refreshed.accessTokenExpiresAt
                // 服务端轮换 refresh token，旧的立即失效，必须立刻落盘
                credentials.set(
                    CredentialStore.refreshTokenRef(serverId),
                    CredentialStore.KEY_REFRESH_TOKEN,
                    refreshed.refreshToken,
                )
                credentials.set(
                    CredentialStore.deviceIdRef(serverId),
                    CredentialStore.KEY_DEVICE_ID,
                    refreshed.deviceId,
                )
                _state.value = State.ACTIVE
                refreshed.accessToken
            } catch (e: Exception) {
                // 401（轮换失效/被撤销）/ 429（限流）/ 网络异常：统一视为会话不可恢复
                _state.value = State.EXPIRED
                null
            }
        }
    }

    /** 退出登录/重新绑定前清空本地会话。 */
    fun clearSession() {
        synchronized(lock) {
            accessToken = null
            accessTokenExpiresAt = 0L
            credentials.deleteAll(CredentialStore.refreshTokenRef(serverId))
            credentials.deleteAll(CredentialStore.deviceIdRef(serverId))
            _state.value = State.ACTIVE
        }
    }
}


// ------------------------------------------------------------------ 共享组件

/**
 * 会话模式共用的 OkHttp Authenticator：401 时经 [SessionManager] 刷新一次并重试，
 * 每个请求最多重试一次（沿 priorResponse 链计数）。SscodeApi / FilesApi / GitApi / IdeApi 共用。
 */
fun sessionAuthenticator(session: SessionManager): Authenticator = Authenticator { _, response ->
    var count = 1
    var prior = response.priorResponse
    while (prior != null) {
        count++
        prior = prior.priorResponse
    }
    if (count >= 2) return@Authenticator null
    val failed = response.request.header("Authorization")
        ?.removePrefix("Bearer ")
        ?.trim()
    val newToken = session.refreshBlocking(failed) ?: return@Authenticator null
    response.request.newBuilder()
        .header("Authorization", "Bearer $newToken")
        .build()
}

/**
 * 活动会话登记表，键为隧道 origin（host:port）。
 * 子界面（文件/Git/IDE/终端）只从 WorkspaceScreen 拿到 baseUrl 与 token 快照，
 * 经此表按 baseUrl 找回 SessionManager，从而获得逐请求刷新 token 的能力。
 * 会话模式连接建立时注册，ServerConnection.close() 时注销。
 */
object SessionRegistry {

    private val lock = Any()
    private val byOrigin = HashMap<String, SessionManager>()

    private fun originOf(url: String): String = try {
        val uri = URI(url)
        "${uri.host}:${uri.port}"
    } catch (_: Exception) {
        url
    }

    fun register(baseUrl: String, session: SessionManager) = synchronized(lock) {
        byOrigin[originOf(baseUrl)] = session
    }

    fun unregister(baseUrl: String, session: SessionManager) = synchronized(lock) {
        val key = originOf(baseUrl)
        if (byOrigin[key] === session) byOrigin.remove(key)
    }

    /** 接受 http(s)://…/v1 或 ws://… 形式，按 origin 匹配。 */
    fun forUrl(url: String): SessionManager? = synchronized(lock) { byOrigin[originOf(url)] }
}
