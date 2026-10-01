package dev.sscode.app.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

// ------------------------------------------------------------------ DTO

@Serializable
data class HealthDto(
    val version: String = "",
    val name: String = "",
    val capabilities: List<String> = emptyList(),
    /** 服务端宿主平台（host-platform 能力）：win32 / linux / darwin…，缺省为旧版服务端 */
    val platform: String? = null,
    val terminalBackend: String? = null,
)

@Serializable
data class TaskCountsDto(val running: Int = 0, val queued: Int = 0)

@Serializable
data class ProjectDto(
    val id: String,
    val name: String = "",
    val path: String = "",
    val isGit: Boolean = false,
    val createdAt: Long = 0,
    val tasks: TaskCountsDto? = null,
    /** 会话模式下服务端返回本设备在该项目的角色（owner/operator/reviewer/viewer） */
    val role: String? = null,
)

@Serializable
data class ProjectsResponse(val projects: List<ProjectDto> = emptyList())

@Serializable
data class SessionDto(
    val id: String,
    val projectId: String = "",
    val title: String = "",
    val createdAt: Long = 0,
)

@Serializable
data class SessionsResponse(val sessions: List<SessionDto> = emptyList())

@Serializable
data class ToolCallDto(
    val id: String,
    val taskId: String = "",
    val seq: Int = 0,
    val tool: String = "",
    val args: JsonObject? = null,
    val state: String = "",
    val result: String? = null,
    val approvalId: String? = null,
    val createdAt: Long = 0,
    val endedAt: Long? = null,
)

@Serializable
data class ApprovalDto(
    val id: String,
    val taskId: String = "",
    val toolCallId: String = "",
    val operation: String = "",
    val params: JsonObject? = null,
    val reason: String = "",
    val riskSummary: String = "",
    val state: String = "pending",
    val decidedAt: Long? = null,
    val note: String? = null,
    val createdAt: Long = 0,
    /** 发起审批的设备；null 表示旧本地管理员 token 提交的审批或迁移前数据 */
    val requesterDeviceId: String? = null,
    val requesterDeviceName: String? = null,
)

@Serializable
data class TaskDto(
    val approvalMode: String = "manual",
    val events: List<EventDto> = emptyList(),
    val id: String,
    val projectId: String = "",
    val sessionId: String = "",
    val seq: Int = 0,
    val state: String = "queued",
    val input: String = "",
    val summary: String? = null,
    val modelConfigId: String? = null,
    val clientRequestId: String = "",
    val createdAt: Long = 0,
    val startedAt: Long? = null,
    val endedAt: Long? = null,
    /** 仅 GET /v1/tasks/:id 返回 */
    val toolCalls: List<ToolCallDto> = emptyList(),
    val pendingApprovals: List<ApprovalDto> = emptyList(),
)

@Serializable
data class TasksResponse(val tasks: List<TaskDto> = emptyList())

@Serializable
data class SubmitTaskResponse(val task: TaskDto, val deduplicated: Boolean = false)

@Serializable
data class EventDto(
    val id: Long,
    val projectId: String? = null,
    val taskId: String? = null,
    val type: String = "",
    val payload: JsonObject? = null,
    val createdAt: Long = 0,
)

@Serializable
data class EventsResponse(val events: List<EventDto> = emptyList(), val cursor: Long = 0)

@Serializable
data class PresetDto(
    val id: String = "",
    val name: String = "",
    val baseUrl: String = "",
    val models: List<String> = emptyList(),
    val keyUrl: String = "",
    val guide: String = "",
    val guideEn: String = "",
)

@Serializable
data class PresetsResponse(val presets: List<PresetDto> = emptyList())

@Serializable
private data class ApiErrorBody(val error: ApiErrorDetail? = null)

@Serializable
private data class ApiErrorDetail(val code: String = "unknown", val message: String = "")

@Serializable
private data class CreateProjectRequest(val name: String, val path: String)

@Serializable
private data class CreateSessionRequest(val title: String)

@Serializable
private data class SubmitTaskRequest(val projectId: String, val sessionId: String, val input: String, val modelConfigId: String? = null, val approvalMode: String = "manual")

@Serializable
data class AgentConfigDto(val id: String, val name: String, val baseUrl: String, val model: String, val isDefault: Boolean = false)
@Serializable
private data class AgentConfigsResponse(val models: List<AgentConfigDto> = emptyList())
@Serializable
private data class CreateAgentRequest(val name: String, val baseUrl: String, val model: String, val apiKey: String)
@Serializable
private data class AgentKeyRequest(val apiKey: String)
@Serializable
data class AgentTestResponse(val ok: Boolean, val detail: String = "")
@Serializable
data class ModelCatalogDto(val models: List<String> = emptyList())
@Serializable
private data class ModelVariantRequest(val model: String)

@Serializable
private data class ApprovalDecisionRequest(val decision: String, val note: String? = null)

@Serializable
private data class ApprovalModeRequest(val approvalMode: String)

@Serializable
private data class AppendMessageRequest(val text: String)

@Serializable
private data class CodexMessageRequest(val text: String)

@Serializable
data class TaskChangeFileDto(val path: String, val changeKind: String = "")

@Serializable
data class TaskChangesResponse(val taskId: String = "", val files: List<TaskChangeFileDto> = emptyList())

// ------------------------------------------------------------------ Codex 任务监视 DTO（项目作用域，只读）

@Serializable
data class CodexTaskProgressDto(
    val state: String = "idle",
    val label: String = "",
    val tone: String = "slate",
)

@Serializable
data class CodexTaskGoalDto(
    val id: String = "",
    val objective: String = "",
    val status: CodexTaskProgressDto = CodexTaskProgressDto(),
    val elapsedSeconds: Long = 0,
    val elapsed: String = "",
)

@Serializable
data class CodexTaskDto(
    val id: String,
    val title: String = "",
    val project: String = "",
    val projectId: String? = null,
    val cwd: String = "",
    val model: String? = null,
    val pinned: Boolean = false,
    val queuedCount: Int = 0,
    val progress: CodexTaskProgressDto = CodexTaskProgressDto(),
    val activity: String = "",
    val latestTask: String = "",
    val latestResult: String = "",
    val updatedAt: Long = 0,
    val goal: CodexTaskGoalDto? = null,
)

@Serializable
data class CodexTasksResponse(
    val available: Boolean = false,
    val tasks: List<CodexTaskDto> = emptyList(),
)

/** 历史消息与排队消息共用；排队消息额外带 queueOrder / queueRevision。 */
@Serializable
data class CodexMessageDto(
    val id: String = "",
    val role: String = "user",
    val text: String = "",
    val timestamp: Long = 0,
    val pending: Boolean = false,
    val queueOrder: Int? = null,
    val queueRevision: Int? = null,
)

@Serializable
data class CodexTaskDetailResponse(
    val available: Boolean = false,
    val task: CodexTaskDto? = null,
    val messages: List<CodexMessageDto> = emptyList(),
    val queuedTasks: List<CodexMessageDto> = emptyList(),
)

// ------------------------------------------------------------------ 设备会话 / 成员 DTO

@Serializable
data class DeviceDto(
    val id: String,
    val name: String = "",
    val createdAt: Long = 0,
    val lastSeenAt: Long = 0,
    val revokedAt: Long? = null,
)

@Serializable
private data class DevicesResponse(val devices: List<DeviceDto> = emptyList())

@Serializable
data class MembershipDto(val projectId: String, val role: String = "", val projectName: String? = null)

@Serializable
data class MeDto(
    val legacy: Boolean = false,
    val device: DeviceDto? = null,
    val sessionId: String? = null,
    val memberships: List<MembershipDto> = emptyList(),
)

@Serializable
data class MemberDto(
    val projectId: String = "",
    val deviceId: String,
    val role: String = "",
    val createdAt: Long = 0,
    val deviceName: String? = null,
)

@Serializable
private data class MembersResponse(val members: List<MemberDto> = emptyList())

@Serializable
private data class SetMemberRequest(val deviceId: String, val role: String)

// ------------------------------------------------------------------ 异常

class ApiException(
    val code: String,
    override val message: String,
    val httpStatus: Int = -1,
) : Exception("[$httpStatus][$code] $message")

// ------------------------------------------------------------------ 客户端

/**
 * sscode-server REST 客户端。baseUrl 形如 http://127.0.0.1:<本地转发端口>/v1。
 * 两种认证模式：
 * - 旧静态 token：`SscodeApi(baseUrl, token)`，行为与之前完全一致；
 * - 设备会话：传入 [session]，每个请求经 [tokenProvider] 取内存中的 access token，
 *   收到 401 时由 Authenticator 刷新一次并重试；刷新失败会把会话标记为 EXPIRED。
 */
class SscodeApi(
    private val baseUrl: String,
    private val tokenProvider: () -> String?,
    session: SessionManager? = null,
) {

    constructor(baseUrl: String, token: String) : this(baseUrl, { token }, null)

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(100, TimeUnit.SECONDS)
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
                    json.decodeFromString<ApiErrorBody>(body)
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

    private fun builder(path: String): Request.Builder {
        val b = Request.Builder().url("$baseUrl$path")
        tokenProvider()?.takeIf { it.isNotEmpty() }?.let { b.header("Authorization", "Bearer $it") }
        return b
    }

    suspend fun health(): HealthDto = withContext(Dispatchers.IO) {
        execute(Request.Builder().url("$baseUrl/health").get().build())
    }

    suspend fun listProjects(): List<ProjectDto> = withContext(Dispatchers.IO) {
        execute<ProjectsResponse>(builder("/projects").get().build()).projects
    }

    suspend fun createProject(name: String, path: String): ProjectDto = withContext(Dispatchers.IO) {
        val body = json.encodeToString(CreateProjectRequest.serializer(), CreateProjectRequest(name, path))
        execute(builder("/projects").post(body.toRequestBody(jsonMediaType)).build())
    }

    suspend fun deleteProject(projectId: String): Unit = withContext(Dispatchers.IO) {
        execute<JsonObject>(builder("/projects/$projectId").delete().build())
        Unit
    }

    suspend fun listSessions(projectId: String): List<SessionDto> = withContext(Dispatchers.IO) {
        execute<SessionsResponse>(builder("/projects/$projectId/sessions").get().build()).sessions
    }

    suspend fun createSession(projectId: String, title: String): SessionDto = withContext(Dispatchers.IO) {
        val body = json.encodeToString(CreateSessionRequest.serializer(), CreateSessionRequest(title))
        execute(builder("/projects/$projectId/sessions").post(body.toRequestBody(jsonMediaType)).build())
    }

    suspend fun submitTask(
        projectId: String,
        sessionId: String,
        input: String,
        clientRequestId: String,
        modelConfigId: String? = null,
        approvalMode: String = "manual",
    ): SubmitTaskResponse = withContext(Dispatchers.IO) {
        val body = json.encodeToString(SubmitTaskRequest.serializer(), SubmitTaskRequest(projectId, sessionId, input, modelConfigId, approvalMode))
        execute(
            builder("/tasks")
                .header("X-Client-Request-Id", clientRequestId)
                .post(body.toRequestBody(jsonMediaType))
                .build(),
        )
    }

    suspend fun listTasks(projectId: String): List<TaskDto> = withContext(Dispatchers.IO) {
        execute<TasksResponse>(builder("/tasks?projectId=$projectId").get().build()).tasks
    }

    suspend fun listAgents(): List<AgentConfigDto> = withContext(Dispatchers.IO) {
        execute<AgentConfigsResponse>(builder("/models").get().build()).models
    }
    suspend fun modelCatalog(id: String): ModelCatalogDto = withContext(Dispatchers.IO) {
        execute(builder("/models/$id/catalog").get().build())
    }
    suspend fun selectModel(id: String, model: String): AgentConfigDto = withContext(Dispatchers.IO) {
        val body = json.encodeToString(ModelVariantRequest.serializer(), ModelVariantRequest(model))
        execute(builder("/models/$id/variant").post(body.toRequestBody(jsonMediaType)).build())
    }

    suspend fun createAgent(name: String, baseUrl: String, model: String, apiKey: String): AgentConfigDto = withContext(Dispatchers.IO) {
        val body = json.encodeToString(CreateAgentRequest.serializer(), CreateAgentRequest(name, baseUrl, model, apiKey))
        execute(builder("/models").post(body.toRequestBody(jsonMediaType)).build())
    }

    suspend fun updateAgentKey(id: String, apiKey: String): Unit = withContext(Dispatchers.IO) {
        val body = json.encodeToString(AgentKeyRequest.serializer(), AgentKeyRequest(apiKey))
        execute<JsonObject>(builder("/models/$id/key").post(body.toRequestBody(jsonMediaType)).build())
        Unit
    }

    suspend fun testAgent(id: String): AgentTestResponse = withContext(Dispatchers.IO) {
        execute(builder("/models/$id/test").post("".toRequestBody(null)).build())
    }

    suspend fun getTask(id: String): TaskDto = withContext(Dispatchers.IO) {
        execute(builder("/tasks/$id").get().build())
    }

    suspend fun setApprovalMode(id: String, mode: String): TaskDto = withContext(Dispatchers.IO) {
        val body = json.encodeToString(ApprovalModeRequest.serializer(), ApprovalModeRequest(mode))
        execute(builder("/tasks/$id/approval-mode").post(body.toRequestBody(jsonMediaType)).build())
    }

    suspend fun appendTaskMessage(taskId: String, text: String): TaskDto = withContext(Dispatchers.IO) {
        val body = json.encodeToString(AppendMessageRequest.serializer(), AppendMessageRequest(text))
        execute(builder("/tasks/$taskId/messages").post(body.toRequestBody(jsonMediaType)).build())
    }

    suspend fun listTaskChanges(taskId: String): List<TaskChangeFileDto> = withContext(Dispatchers.IO) {
        execute<TaskChangesResponse>(builder("/tasks/$taskId/changes").get().build()).files
    }

    suspend fun stopTask(id: String): TaskDto = withContext(Dispatchers.IO) {
        execute(builder("/tasks/$id/stop").post("".toRequestBody(null)).build())
    }

    suspend fun decideApproval(approvalId: String, decision: String, note: String? = null): ApprovalDto =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(
                ApprovalDecisionRequest.serializer(),
                ApprovalDecisionRequest(decision, note),
            )
            execute(builder("/approvals/$approvalId/decision").post(body.toRequestBody(jsonMediaType)).build())
        }

    suspend fun getEvents(after: Long, projectId: String? = null): EventsResponse = withContext(Dispatchers.IO) {
        val query = buildString {
            append("/events?after=").append(after)
            if (projectId != null) append("&projectId=").append(projectId)
        }
        execute(builder(query).get().build())
    }

    // ------------------------------------------------------------------ Codex 任务监视（项目作用域，只读）

    /** 本机 Codex Desktop/CLI 中 cwd 落在项目路径内的线程；available=false 表示宿主无 Codex 数据。 */
    suspend fun listCodexTasks(projectId: String): CodexTasksResponse = withContext(Dispatchers.IO) {
        execute(builder("/projects/$projectId/codex/tasks").get().build())
    }

    /** 线程不存在或不属于该项目时抛 [ApiException]（httpStatus = 404）。 */
    suspend fun getCodexTask(projectId: String, threadId: String): CodexTaskDetailResponse = withContext(Dispatchers.IO) {
        execute(builder("/projects/$projectId/codex/tasks/$threadId").get().build())
    }

    /** 向 Codex 线程追加用户消息；服务端返回 202（Accepted），响应体可能为空，忽略解码失败。 */
    suspend fun sendCodexMessage(projectId: String, threadId: String, text: String): Unit = withContext(Dispatchers.IO) {
        val body = json.encodeToString(CodexMessageRequest.serializer(), CodexMessageRequest(text))
        try {
            execute<JsonObject>(builder("/projects/$projectId/codex/tasks/$threadId/messages").post(body.toRequestBody(jsonMediaType)).build())
        } catch (e: ApiException) {
            throw e
        } catch (_: Exception) {
            // 202 空响应体无法解码，视为成功
        }
        Unit
    }

    suspend fun getPresets(): List<PresetDto> = withContext(Dispatchers.IO) {
        execute<PresetsResponse>(builder("/models/presets").get().build()).presets
    }

    // ------------------------------------------------------------------ 设备会话 / 成员

    suspend fun me(): MeDto = withContext(Dispatchers.IO) {
        execute(builder("/auth/me").get().build())
    }

    suspend fun listDevices(): List<DeviceDto> = withContext(Dispatchers.IO) {
        execute<DevicesResponse>(builder("/auth/devices").get().build()).devices
    }

    /** 退出当前设备：服务端要求会话 access token（撤销本会话），本地凭据由调用方清理。 */
    suspend fun revokeSession(): Unit = withContext(Dispatchers.IO) {
        execute<kotlinx.serialization.json.JsonObject>(builder("/auth/revoke").post("".toRequestBody(null)).build())
        Unit
    }

    suspend fun revokeDevice(deviceId: String): Unit = withContext(Dispatchers.IO) {
        execute<kotlinx.serialization.json.JsonObject>(builder("/auth/devices/$deviceId").delete().build())
        Unit
    }

    suspend fun listMembers(projectId: String): List<MemberDto> = withContext(Dispatchers.IO) {
        execute<MembersResponse>(builder("/projects/$projectId/members").get().build()).members
    }

    suspend fun setMember(projectId: String, deviceId: String, role: String): MemberDto = withContext(Dispatchers.IO) {
        val body = json.encodeToString(SetMemberRequest.serializer(), SetMemberRequest(deviceId, role))
        execute(builder("/projects/$projectId/members").post(body.toRequestBody(jsonMediaType)).build())
    }

    suspend fun removeMember(projectId: String, deviceId: String): Unit = withContext(Dispatchers.IO) {
        execute<kotlinx.serialization.json.JsonObject>(builder("/projects/$projectId/members/$deviceId").delete().build())
        Unit
    }
}
