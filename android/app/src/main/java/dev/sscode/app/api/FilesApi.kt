package dev.sscode.app.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

// ------------------------------------------------------------------ DTO

@Serializable
data class FileEntryDto(
    val name: String,
    val kind: String = "file",
    val size: Long = 0,
    val mtime: Double = 0.0,
    val sensitive: Boolean = false,
)

@Serializable
data class FileListResponse(val entries: List<FileEntryDto> = emptyList())

@Serializable
data class FileContentResponse(
    val content: String = "",
    val hash: String = "",
    val size: Long = 0,
    val truncated: Boolean = false,
)

@Serializable
data class FileWriteResponse(val hash: String = "")

@Serializable
private data class FileWriteRequest(
    val projectId: String,
    val path: String,
    val content: String,
    val baseHash: String? = null,
)

@Serializable
private data class FileCreateRequest(val projectId: String, val path: String, val kind: String)

@Serializable
private data class FileRenameRequest(val projectId: String, val path: String, val newName: String)

@Serializable
private data class FileMoveRequest(val projectId: String, val path: String, val destDir: String)

@Serializable
private data class FileDeleteRequest(val projectId: String, val path: String)

@Serializable
private data class FilesErrorBody(val error: FilesErrorDetail? = null)

@Serializable
private data class FilesErrorDetail(val code: String = "unknown", val message: String = "")

// ------------------------------------------------------------------ 客户端

/**
 * /v1/files 端点封装。baseUrl 可带或不带 /v1 后缀，内部归一化。
 * 旧静态 token：`FilesApi(baseUrl, token)`；设备会话：传 [session]，
 * 每个请求经 [tokenProvider] 取最新 access token，401 时刷新重试一次。
 */
class FilesApi(
    baseUrl: String,
    private val tokenProvider: () -> String?,
    session: SessionManager? = null,
) {

    constructor(baseUrl: String, token: String) : this(baseUrl, { token }, null)

    private val root = baseUrl.trimEnd('/').let { if (it.endsWith("/v1")) it else "$it/v1" }

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .apply {
            if (session != null) authenticator(sessionAuthenticator(session))
        }
        .build()

    private val json = Json { ignoreUnknownKeys = true }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private inline fun <reified T> execute(request: Request): T {
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val parsed = try {
                    json.decodeFromString<FilesErrorBody>(body)
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

    private fun executeNoContent(request: Request) {
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val body = response.body?.string().orEmpty()
                val parsed = try {
                    json.decodeFromString<FilesErrorBody>(body)
                } catch (_: Exception) {
                    null
                }
                throw ApiException(
                    code = parsed?.error?.code ?: "http_${response.code}",
                    message = parsed?.error?.message ?: body.take(300).ifBlank { "HTTP ${response.code}" },
                    httpStatus = response.code,
                )
            }
        }
    }

    private fun builder(path: String): Request.Builder {
        val b = Request.Builder().url("$root$path")
        tokenProvider()?.takeIf { it.isNotEmpty() }?.let { b.header("Authorization", "Bearer $it") }
        return b
    }

    private fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")

    suspend fun list(projectId: String, path: String): List<FileEntryDto> = withContext(Dispatchers.IO) {
        execute<FileListResponse>(
            builder("/files/list?projectId=${enc(projectId)}&path=${enc(path)}").get().build(),
        ).entries
    }

    suspend fun content(projectId: String, path: String): FileContentResponse = withContext(Dispatchers.IO) {
        execute(builder("/files/content?projectId=${enc(projectId)}&path=${enc(path)}").get().build())
    }

    /** baseHash 传 null 表示强制保存（忽略外部修改冲突）。409 冲突时抛 ApiException(httpStatus = 409)。 */
    suspend fun write(projectId: String, path: String, content: String, baseHash: String?): FileWriteResponse =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(
                FileWriteRequest.serializer(),
                FileWriteRequest(projectId, path, content, baseHash),
            )
            execute(builder("/files/write").post(body.toRequestBody(jsonMediaType)).build())
        }

    /** kind: "file" | "dir" */
    suspend fun create(projectId: String, path: String, kind: String): Unit = withContext(Dispatchers.IO) {
        val body = json.encodeToString(FileCreateRequest.serializer(), FileCreateRequest(projectId, path, kind))
        executeNoContent(builder("/files/create").post(body.toRequestBody(jsonMediaType)).build())
    }

    suspend fun rename(projectId: String, path: String, newName: String): Unit = withContext(Dispatchers.IO) {
        val body = json.encodeToString(FileRenameRequest.serializer(), FileRenameRequest(projectId, path, newName))
        executeNoContent(builder("/files/rename").post(body.toRequestBody(jsonMediaType)).build())
    }

    /** destDir 为目标目录（相对项目根），空字符串表示项目根。 */
    suspend fun move(projectId: String, path: String, destDir: String): Unit = withContext(Dispatchers.IO) {
        val body = json.encodeToString(FileMoveRequest.serializer(), FileMoveRequest(projectId, path, destDir))
        executeNoContent(builder("/files/move").post(body.toRequestBody(jsonMediaType)).build())
    }

    suspend fun delete(projectId: String, path: String): Unit = withContext(Dispatchers.IO) {
        val body = json.encodeToString(FileDeleteRequest.serializer(), FileDeleteRequest(projectId, path))
        executeNoContent(builder("/files").delete(body.toRequestBody(jsonMediaType)).build())
    }
}
