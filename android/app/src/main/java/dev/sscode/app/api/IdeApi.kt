package dev.sscode.app.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

// ------------------------------------------------------------------ DTO

@Serializable
data class IdeStatusDto(
    val installed: Boolean = false,
    val version: String? = null,
    val running: Boolean = false,
    val port: Int? = null,
    val source: String = "none",
    val hasPassword: Boolean = false,
    /** Windows 原生宿主不支持 code-server：需在 WSL 内运行（服务端 hostUnsupported） */
    val hostUnsupported: Boolean = false,
)

@Serializable
data class IdeInstallResponse(val version: String = "")

@Serializable
data class IdeStartResponse(val port: Int = 0, val reused: Boolean = false)

@Serializable
data class IdeAccessDto(
    val port: Int = 0,
    val password: String? = null,
    val url: String = "",
    /** Windows 宿主：访问的是 WSL 内 code-server，密码需用户在 WSL 内查看 */
    val wsl: Boolean = false,
)

@Serializable
private data class IdeInstallRequest(val proxy: String? = null)

@Serializable
private data class IdeErrorBody(val error: IdeErrorDetail? = null)

@Serializable
private data class IdeErrorDetail(val code: String = "unknown", val message: String = "")

// ------------------------------------------------------------------ 客户端

/**
 * /v1/ide 端点封装。baseUrl 可带或不带 /v1 后缀，内部归一化。
 * install 耗时较长，使用独立的长超时 client（读超时 10 分钟）。
 */
class IdeApi(baseUrl: String, private val token: String) {

    private val root = baseUrl.trimEnd('/').let { if (it.endsWith("/v1")) it else "$it/v1" }

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val installClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.MINUTES)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private inline fun <reified T> execute(request: Request, httpClient: OkHttpClient = client): T {
        httpClient.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val parsed = try {
                    json.decodeFromString<IdeErrorBody>(body)
                } catch (_: Exception) {
                    null
                }
                throw ApiException(
                    code = parsed?.error?.code ?: "http_${response.code}",
                    message = parsed?.error?.message ?: body.take(300).ifBlank { "HTTP ${response.code}" },
                    httpStatus = response.code,
                )
            }
            return json.decodeFromString(body)
        }
    }

    private fun builder(path: String): Request.Builder = Request.Builder()
        .url("$root$path")
        .header("Authorization", "Bearer $token")

    private fun emptyPost(path: String): Request =
        builder(path).post("".toRequestBody(null)).build()

    suspend fun status(): IdeStatusDto = withContext(Dispatchers.IO) {
        execute(builder("/ide/status").get().build())
    }

    /** 安装 code-server，耗时操作（内部使用 10 分钟读超时）。 */
    suspend fun install(proxy: String? = null): IdeInstallResponse = withContext(Dispatchers.IO) {
        val body = json.encodeToString(IdeInstallRequest.serializer(), IdeInstallRequest(proxy))
        execute(
            builder("/ide/install").post(body.toRequestBody(jsonMediaType)).build(),
            httpClient = installClient,
        )
    }

    suspend fun start(): IdeStartResponse = withContext(Dispatchers.IO) {
        execute(emptyPost("/ide/start"))
    }

    suspend fun stop(): Unit = withContext(Dispatchers.IO) {
        client.newCall(emptyPost("/ide/stop")).execute().use { response ->
            if (!response.isSuccessful) {
                throw ApiException(
                    code = "http_${response.code}",
                    message = response.body?.string().orEmpty().take(300).ifBlank { "HTTP ${response.code}" },
                    httpStatus = response.code,
                )
            }
        }
    }

    suspend fun access(): IdeAccessDto = withContext(Dispatchers.IO) {
        execute(builder("/ide/access").get().build())
    }
}
