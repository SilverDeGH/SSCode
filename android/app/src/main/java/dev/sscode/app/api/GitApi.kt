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
data class GitFileDto(
    val path: String = "",
    /** porcelain X 状态字符（" "/"." 表示未改动，"?" 未跟踪） */
    val index: String = "",
    /** porcelain Y 状态字符 */
    val worktree: String = "",
)

@Serializable
data class GitStatusDto(
    val ok: Boolean = false,
    val isRepo: Boolean = false,
    val branch: String = "",
    val ahead: Int = 0,
    val behind: Int = 0,
    val files: List<GitFileDto> = emptyList(),
)

@Serializable
data class GitDiffDto(
    val ok: Boolean = false,
    val diff: String = "",
    val truncated: Boolean = false,
)

@Serializable
data class GitActionDto(
    val ok: Boolean = false,
    val output: String = "",
)

@Serializable
private data class GitErrorBody(val error: GitErrorDetail? = null)

@Serializable
private data class GitErrorDetail(val code: String = "unknown", val message: String = "")

@Serializable
private data class GitProjectRequest(val projectId: String)

@Serializable
private data class GitPathsRequest(val projectId: String, val paths: List<String>)

@Serializable
private data class GitCommitRequest(val projectId: String, val message: String)

@Serializable
private data class GitBranchRequest(val projectId: String, val name: String)

// ------------------------------------------------------------------ 客户端

/**
 * sscode-server Git REST 客户端。baseUrl 形如 http://127.0.0.1:<本地转发端口>/v1。
 * 错误统一抛 [ApiException]（httpStatus 400/409 等由调用方判断）。
 */
class GitApi(private val baseUrl: String, private val token: String) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private inline fun <reified T> execute(request: Request): T {
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val parsed = try {
                    json.decodeFromString<GitErrorBody>(body)
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

    private fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")

    private fun builder(path: String): Request.Builder = Request.Builder()
        .url("$baseUrl$path")
        .header("Authorization", "Bearer $token")

    private fun <T> post(path: String, payload: T, serializer: kotlinx.serialization.KSerializer<T>): Request =
        builder(path)
            .post(json.encodeToString(serializer, payload).toRequestBody(jsonMediaType))
            .build()

    suspend fun status(projectId: String): GitStatusDto = withContext(Dispatchers.IO) {
        execute(builder("/git/status?projectId=${enc(projectId)}").get().build())
    }

    suspend fun diff(projectId: String, path: String, staged: Boolean): GitDiffDto = withContext(Dispatchers.IO) {
        execute(
            builder("/git/diff?projectId=${enc(projectId)}&path=${enc(path)}&staged=$staged").get().build(),
        )
    }

    suspend fun stage(projectId: String, paths: List<String>): GitActionDto = withContext(Dispatchers.IO) {
        execute(post("/git/stage", GitPathsRequest(projectId, paths), GitPathsRequest.serializer()))
    }

    suspend fun unstage(projectId: String, paths: List<String>): GitActionDto = withContext(Dispatchers.IO) {
        execute(post("/git/unstage", GitPathsRequest(projectId, paths), GitPathsRequest.serializer()))
    }

    suspend fun commit(projectId: String, message: String): GitActionDto = withContext(Dispatchers.IO) {
        execute(post("/git/commit", GitCommitRequest(projectId, message), GitCommitRequest.serializer()))
    }

    suspend fun pull(projectId: String): GitActionDto = withContext(Dispatchers.IO) {
        execute(post("/git/pull", GitProjectRequest(projectId), GitProjectRequest.serializer()))
    }

    suspend fun push(projectId: String): GitActionDto = withContext(Dispatchers.IO) {
        execute(post("/git/push", GitProjectRequest(projectId), GitProjectRequest.serializer()))
    }

    suspend fun createBranch(projectId: String, name: String): GitActionDto = withContext(Dispatchers.IO) {
        execute(post("/git/branch", GitBranchRequest(projectId, name), GitBranchRequest.serializer()))
    }

    suspend fun checkout(projectId: String, name: String): GitActionDto = withContext(Dispatchers.IO) {
        execute(post("/git/checkout", GitBranchRequest(projectId, name), GitBranchRequest.serializer()))
    }
}
