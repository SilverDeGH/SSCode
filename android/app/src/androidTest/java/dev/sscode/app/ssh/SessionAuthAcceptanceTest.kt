package dev.sscode.app.ssh

import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import androidx.test.platform.app.InstrumentationRegistry
import dev.sscode.app.AppContainer
import dev.sscode.app.api.ApiException
import dev.sscode.app.api.FilesApi
import dev.sscode.app.api.LinkResponse
import dev.sscode.app.api.RefreshResponse
import dev.sscode.app.api.SessionManager
import dev.sscode.app.api.SscodeApi
import dev.sscode.app.api.linkDevice
import dev.sscode.app.data.CredentialStore
import dev.sscode.app.data.ServerEntity
import dev.sscode.app.deploy.Deployer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64
import java.util.Collections
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * 模拟器会话认证端到端验收（P3/P4）：真实 SSH 隧道 + 设备绑定 + 会话模式 API。
 * 运行参数（am instrument -e …）：
 * - apiKey      服务商 Key，只经请求体发送，断言绝不出现在任何响应里（canary）
 * - sshKeyB64   本机测试私钥 PEM 的 Base64（一次性读入 CredentialStore）
 * - sshUser     SSH 用户名（默认 Silver）；sshPort 默认 22
 * - projectPath 专用一次性项目目录（默认 E:\SSCode\test-project\emu-e2e-20260930）
 * 真实模型调用仅一次小任务；日志不输出任何凭据。
 */
class SessionAuthAcceptanceTest {
    private val args = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val rawJson = Json { ignoreUnknownKeys = true }
    private val rawClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    /** 所有经客户端收到的响应体/帧，最后统一做 Key 泄露扫描 */
    private val canaryBodies = Collections.synchronizedList(mutableListOf<String>())

    private fun passed(step: String) = android.util.Log.i(TAG, "PASS $step")
    private fun info(step: String) = android.util.Log.i(TAG, "INFO $step")

    private val apiKey: String
        get() = requireNotNull(args.getString("apiKey")) { "Pass -e apiKey <provider key>" }

    private fun sshPem(): String {
        val b64 = requireNotNull(args.getString("sshKeyB64")) { "Pass -e sshKeyB64 <base64 PEM>" }
        return String(Base64.getDecoder().decode(b64), Charsets.UTF_8)
    }

    private suspend fun provisionServer(): ServerEntity {
        val credentials = AppContainer.credentials(context)
        val ref = "session-auth-acceptance"
        credentials.set(ref, CredentialStore.KEY_PRIVATE_KEY_PEM, sshPem())
        val draft = ServerEntity(
            name = "emulator-session-auth",
            host = "10.0.2.2",
            port = args.getString("sshPort")?.toIntOrNull() ?: 22,
            username = args.getString("sshUser") ?: "Silver",
            authType = "key",
            saveCredential = true,
            credentialRef = ref,
        )
        // TOFU：首次连接记录主机指纹并落库，第二次连接必须命中同一指纹
        val fingerprint = AppContainer.ssh(context).connect(draft).use { it.hostFingerprint }
        val id = AppContainer.database(context).serverDao().insert(draft.copy(hostFingerprint = fingerprint))
        val saved = requireNotNull(AppContainer.database(context).serverDao().getById(id))
        AppContainer.ssh(context).connect(saved).use { assertEquals(fingerprint, it.hostFingerprint) }
        return saved
    }

    /** access token 只允许在内存：扫描加密存储全部值，不允许出现该串 */
    private fun assertAccessTokenNotPersisted(accessToken: String) {
        val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        val prefs = EncryptedSharedPreferences.create(
            context,
            "sscode_credentials",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        val offenders = prefs.all.values.filterIsInstance<String>().filter { it.contains(accessToken) }
        assertTrue("access token persisted in credential store", offenders.isEmpty())
    }

    private fun rawRefresh(base: String, refreshToken: String): RefreshResponse {
        val body = buildJsonObject { put("refreshToken", refreshToken) }
            .toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())
        rawClient.newCall(Request.Builder().url("$base/auth/refresh").post(body).build()).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            canaryBodies += text
            assertEquals("refresh failed: $text", 200, resp.code)
            return rawJson.decodeFromString(RefreshResponse.serializer(), text)
        }
    }

    private fun rawRefreshStatus(base: String, refreshToken: String): Int {
        val body = buildJsonObject { put("refreshToken", refreshToken) }
            .toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())
        rawClient.newCall(Request.Builder().url("$base/auth/refresh").post(body).build()).execute().use { resp ->
            canaryBodies += resp.body?.string().orEmpty()
            return resp.code
        }
    }

    @Test fun sessionAuthEndToEnd(): Unit = runBlocking {
        val server = provisionServer()
        val credentials = AppContainer.credentials(context)
        AppContainer.ssh(context).connect(server).use { ssh ->
            assertEquals(0, ssh.exec("echo sscode-emu-ssh-ok", 10).exitCode)
            passed("SSH connect / TOFU fingerprint pinned / exec")

            val legacyToken = Deployer(context).connectExisting(ssh)
            val port = ssh.startLocalForward(remotePort = 7823)
            val base = "http://127.0.0.1:$port/v1"
            val legacyApi = SscodeApi(base, legacyToken)
            assertTrue(legacyApi.me().legacy)
            passed("SSH tunnel to 7823 / legacy admin token")

            // ---------------- (a) 设备绑定
            val link = linkDevice(
                serverBaseUrl = base,
                deviceName = "emulator-sscode35",
                name = "gpt.ge",
                baseUrl = "https://api.gpt.ge/v1",
                model = "gpt-5.5",
                apiKey = apiKey,
            )
            canaryBodies += link.toString()
            assertTrue(link.accessToken.isNotBlank())
            assertTrue(link.refreshToken.isNotBlank())
            assertTrue(link.deviceId.isNotBlank())
            val session = SessionManager(server.id, credentials)
            session.onLinked(base, link)
            assertEquals(
                link.refreshToken,
                credentials.get(CredentialStore.refreshTokenRef(server.id), CredentialStore.KEY_REFRESH_TOKEN),
            )
            assertEquals(
                link.deviceId,
                credentials.get(CredentialStore.deviceIdRef(server.id), CredentialStore.KEY_DEVICE_ID),
            )
            assertAccessTokenNotPersisted(link.accessToken)
            passed("linkDevice / refresh+deviceId in CredentialStore / access token memory-only (role=${link.role})")
            info("DEVICE_ID=${link.deviceId}")

            val api = SscodeApi(base, { session.accessTokenBlocking() }, session)

            // ---------------- (b) me() 与成员提升
            val me = api.me()
            canaryBodies += me.toString()
            assertFalse(me.legacy)
            assertEquals("emulator-sscode35", me.device?.name)
            assertTrue("memberships present", me.memberships.isNotEmpty())
            passed("me() session identity / memberships=${me.memberships.size}")

            val projectPath = args.getString("projectPath") ?: "E:\\SSCode\\test-project\\emu-e2e-20260930"
            ssh.exec("if not exist \"$projectPath\" mkdir \"$projectPath\"", 10)
            val norm = projectPath.replace('\\', '/').trimEnd('/')
            val project = legacyApi.listProjects()
                .find { it.path.replace('\\', '/').trimEnd('/').equals(norm, ignoreCase = true) }
                ?: legacyApi.createProject("Emulator session-auth E2E", projectPath)
            info("PROJECT_ID=${project.id}")

            var role = api.me().memberships.find { it.projectId == project.id }?.role
            if (role != "owner" && role != "operator") {
                info("new device role=$role on test project; promoting to operator via legacy admin members API")
                legacyApi.setMember(project.id, link.deviceId, "operator")
                role = api.me().memberships.find { it.projectId == project.id }?.role
            }
            assertTrue("role=$role", role == "owner" || role == "operator")
            val members = api.listMembers(project.id)
            canaryBodies += members.toString()
            assertTrue(members.any { it.deviceId == link.deviceId && (it.role == "operator" || it.role == "owner") })
            passed("member promotion via legacy admin / session sees own membership")

            // ---------------- (c) 刷新轮换
            val oldRefresh = requireNotNull(
                credentials.get(CredentialStore.refreshTokenRef(server.id), CredentialStore.KEY_REFRESH_TOKEN),
            )
            val refreshed = rawRefresh(base, oldRefresh)
            assertNotEquals(oldRefresh, refreshed.refreshToken)
            assertEquals(link.deviceId, refreshed.deviceId)
            assertEquals(401, rawRefreshStatus(base, oldRefresh))
            session.onLinked(
                base,
                LinkResponse(
                    deviceId = refreshed.deviceId,
                    accessToken = refreshed.accessToken,
                    accessTokenExpiresAt = refreshed.accessTokenExpiresAt,
                    refreshToken = refreshed.refreshToken,
                    refreshTokenExpiresAt = refreshed.refreshTokenExpiresAt,
                ),
            )
            assertEquals(
                refreshed.refreshToken,
                credentials.get(CredentialStore.refreshTokenRef(server.id), CredentialStore.KEY_REFRESH_TOKEN),
            )
            assertAccessTokenNotPersisted(refreshed.accessToken)
            assertEquals("emulator-sscode35", api.me().device?.name)
            passed("refresh rotation / old refresh token 401 / session usable with new tokens")

            // ---------------- (d) 幂等提交 + 真实小任务
            val chat = api.createSession(project.id, "emulator session auth e2e")
            val crid = UUID.randomUUID().toString()
            val prompt = "Create a file named emu-session-ok.txt in the project root whose entire content " +
                "is the single line EMU_SESSION_OK, then finish. Do not touch anything else."
            val submitted = api.submitTask(project.id, chat.id, prompt, crid, null, "full")
            val duplicate = api.submitTask(project.id, chat.id, prompt, crid, null, "full")
            canaryBodies += submitted.toString()
            assertEquals(submitted.task.id, duplicate.task.id)
            assertTrue(duplicate.deduplicated)
            val task = submitted.task
            passed("task submit / X-Client-Request-Id dedup (same task id)")
            info("TASK_ID=${task.id}")

            // ---------------- P3：两个设备身份同时查看/操作同一任务
            val activeStates = setOf("queued", "running", "awaiting_input", "awaiting_approval", "stopping")
            val legacySeen = Collections.synchronizedList(mutableListOf<String>())
            val poller = async(Dispatchers.IO) {
                var guard = 0
                while (guard++ < 400) {
                    val t = legacyApi.getTask(task.id)
                    legacySeen += t.state
                    if (t.state !in activeStates) break
                    delay(300)
                }
            }
            try {
                api.setApprovalMode(task.id, "full")
                info("emulator session operated on task: approval-mode -> full")
            } catch (e: ApiException) {
                assertEquals(409, e.httpStatus)
                api.stopTask(task.id) // 已终态：幂等停止仍是一次第二设备写操作
                info("task already terminal; emulator session operated via idempotent stop")
            }
            val deadline = System.currentTimeMillis() + 300_000
            var result = api.getTask(task.id)
            while (result.state in activeStates && System.currentTimeMillis() < deadline) {
                delay(1000)
                result = api.getTask(task.id)
            }
            withTimeout(60_000) { poller.await() }
            canaryBodies += result.toString()
            assertEquals("task runaway? state=${result.state}", "completed", result.state)
            assertTrue("legacy admin observed the task", legacySeen.isNotEmpty())
            assertEquals("both devices observe same final state", result.state, legacySeen.last())
            passed("dual-device concurrent view+operate (legacy polls=${legacySeen.size}, emulator session writes)")

            val onHost = ssh.exec("type \"$projectPath\\emu-session-ok.txt\"", 10)
            assertEquals(onHost.stderr, 0, onHost.exitCode)
            assertTrue(onHost.stdout.contains("EMU_SESSION_OK"))
            val viaApi = FilesApi(base, legacyToken).content(project.id, "emu-session-ok.txt")
            assertTrue(viaApi.content.contains("EMU_SESSION_OK"))
            passed("AI task completed / emu-session-ok.txt verified on host (SSH exec + FilesApi)")

            // ---------------- (e) 游标轮询
            val ev0 = api.getEvents(0, project.id)
            canaryBodies += ev0.toString().take(8000)
            val types = ev0.events.map { it.type }.toSet()
            assertTrue("task.created missing in $types", "task.created" in types)
            assertTrue("task.state missing in $types", "task.state" in types)
            assertTrue("tool events missing in $types", types.any { it.startsWith("tool.") })
            assertTrue(ev0.cursor > 0)
            legacyApi.setMember(project.id, link.deviceId, "operator") // 产生一条新的审计事件
            val ev1 = api.getEvents(ev0.cursor, project.id)
            assertTrue("expected at least one newer event", ev1.events.isNotEmpty())
            assertTrue(ev1.events.all { it.id > ev0.cursor })
            passed("cursor polling after=0 (${ev0.events.size} events incl task.created/state/tool.*) / follow-up only-newer (${ev1.events.size})")

            // ---------------- (f) SSE 事件流
            val sseClient = OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .build()
            try {
                val sseRequest = Request.Builder()
                    .url("$base/events/stream?projectId=${project.id}")
                    .header("Authorization", "Bearer ${session.accessTokenBlocking()}")
                    .build()
                val frames = mutableListOf<String>()
                sseClient.newCall(sseRequest).execute().use { resp ->
                    assertEquals(200, resp.code)
                    assertTrue(resp.header("content-type").orEmpty().startsWith("text/event-stream"))
                    val source = resp.body!!.source()
                    var gotConnected = false
                    var gotEvent = false
                    val end = System.currentTimeMillis() + 15_000
                    while (System.currentTimeMillis() < end && !(gotConnected && gotEvent)) {
                        val line = try { source.readUtf8Line() } catch (_: Exception) { break } ?: break
                        frames += line
                        if (line == ": connected") gotConnected = true
                        if (line.startsWith("event:")) gotEvent = true
                    }
                    assertTrue("': connected' not received; frames=$frames", gotConnected)
                    assertTrue("no event frame; frames=$frames", gotEvent)
                }
                canaryBodies += frames.joinToString("\n").take(4000)
                passed("SSE /events/stream ': connected' + replayed frames / clean close")
            } finally {
                sseClient.dispatcher.executorService.shutdown()
                sseClient.connectionPool.evictAll()
            }

            // ---------------- 设备列表 + 模型列表 raw canary 取样
            val devices = api.listDevices()
            canaryBodies += devices.toString()
            assertTrue(devices.any { it.id == link.deviceId && it.name == "emulator-sscode35" })
            val modelsResp = rawClient.newCall(
                Request.Builder()
                    .url("$base/models")
                    .header("Authorization", "Bearer ${session.accessTokenBlocking()}")
                    .build(),
            ).execute()
            val modelsBody = modelsResp.body?.string().orEmpty()
            modelsResp.close()
            assertEquals(200, modelsResp.code)
            assertTrue(modelsBody.contains("gpt-5.5"))
            canaryBodies += modelsBody
            passed("listDevices / GET /models in session mode")

            // ---------------- (g) 撤销设备
            api.revokeDevice(link.deviceId) // 自助撤销：DELETE /v1/auth/devices/:id
            try {
                api.me()
                fail("revoked session accepted")
            } catch (e: ApiException) {
                assertEquals(401, e.httpStatus)
            }
            assertEquals(SessionManager.State.EXPIRED, session.state.value)
            passed("device revoked / subsequent call 401 / SessionManager EXPIRED")

            // ---------------- (h) Key 泄露金丝雀
            val leaked = canaryBodies.filter { it.contains(apiKey) }
            assertTrue("apiKey leaked into ${leaked.size} responses", leaked.isEmpty())
            passed("canary: apiKey absent from all ${canaryBodies.size} captured responses")
        }
    }

    private companion object {
        const val TAG = "SessionAuthAcceptance"
    }
}
