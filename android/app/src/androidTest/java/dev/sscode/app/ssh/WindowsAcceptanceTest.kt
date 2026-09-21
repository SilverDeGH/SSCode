package dev.sscode.app.ssh

import androidx.test.platform.app.InstrumentationRegistry
import dev.sscode.app.AppContainer
import dev.sscode.app.api.*
import dev.sscode.app.data.CredentialStore
import dev.sscode.app.data.ServerEntity
import dev.sscode.app.deploy.Deployer
import dev.sscode.app.deploy.EnvDetector
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** Opt-in Windows acceptance through the actual Android SSH/API clients.
 * Requires a dedicated disposable Git project (projectPath), saved server and trusted fingerprint.
 * No credentials are logged. Optional key provision is read once from app-private storage and deleted.
 */
class WindowsAcceptanceTest {
    private val args = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private fun passed(step: String) = android.util.Log.i("WindowsAcceptance", "PASS $step")

    private suspend fun server(): ServerEntity {
        val id = args.getString("serverId")?.toLongOrNull()
        assumeTrue("Explicit saved Windows server required", id != null)
        val dao = AppContainer.database(context).serverDao()
        val saved = requireNotNull(dao.getById(id!!))
        val expected = requireNotNull(args.getString("fingerprint"))
        val ref = saved.credentialRef ?: "windows-acceptance-$id"
        val provision = File(context.filesDir, "acceptance-key.pem")
        if (provision.exists()) {
            try { AppContainer.credentials(context).set(ref, CredentialStore.KEY_PRIVATE_KEY_PEM, provision.readText()) }
            finally { check(provision.delete()) }
        }
        val updated = saved.copy(port = args.getString("port")?.toInt() ?: saved.port,
            hostFingerprint = expected, credentialRef = ref)
        // Persist corrected endpoint only after authenticating the pinned host.
        AppContainer.ssh(context).connect(updated).use { assertEquals(expected, it.hostFingerprint) }
        dao.update(updated)
        return updated
    }

    private suspend fun api(session: SshSession): Pair<String, String> {
        val token = Deployer(context).connectExisting(session)
        val port = session.startLocalForward(remotePort = 7823)
        return "http://127.0.0.1:$port/v1" to token
    }

    @Test fun windowsWorkspaceThroughSsh(): Unit = runBlocking {
        val path = requireNotNull(args.getString("projectPath"))
        val server = server()
        var connection = AppContainer.ssh(context).connect(server)
        val sockets = mutableListOf<TerminalProbe>()
        try {
            assertEquals(0, connection.exec("echo sscode-windows-ssh-ok", 10).exitCode)
            passed("SSH authentication / pinned host / Windows exec")
            val env = EnvDetector().detect(connection)
            assertEquals("win32", env.platform)
            assertEquals("persist", env.terminalBackend)
            assertTrue(env.existingServiceReady)
            assertNotNull(env.nodeVersion)
            assertTrue(env.gitOk)
            assertTrue((env.cpuCores ?: 0) > 0)
            passed("Windows environment detection / existing service readiness")
            var (base, token) = api(connection)
            AppContainer.credentials(context).set(CredentialStore.apiTokenRef(server.id), CredentialStore.KEY_API_TOKEN, token)
            var api = SscodeApi(base, token)
            assertEquals("win32", api.health().platform)
            try { SscodeApi(base, "invalid-test-token").listProjects(); fail("Unauthorized request accepted") }
            catch (e: ApiException) { assertEquals(401, e.httpStatus) }
            passed("SSH token retrieval / tunnel health / 401 rejection")
            val project = api.listProjects().find { it.path.replace('\\', '/') == path.replace('\\', '/') }
                ?: api.createProject("Windows E2E acceptance", path)
            val suffix = UUID.randomUUID().toString().take(8)
            val files = FilesApi(base, token)
            val dir = "验收-$suffix"
            files.create(project.id, dir, "dir")
            files.create(project.id, "$dir/原始.txt", "file")
            val original = files.content(project.id, "$dir/原始.txt")
            files.write(project.id, "$dir/原始.txt", "Windows 中文 😀\n", original.hash)
            assertEquals("Windows 中文 😀\n", files.content(project.id, "$dir/原始.txt").content)
            try { files.write(project.id, "$dir/原始.txt", "stale", original.hash); fail("Stale write accepted") }
            catch (e: ApiException) { assertEquals(409, e.httpStatus) }
            files.rename(project.id, "$dir/原始.txt", "重命名.txt")
            files.move(project.id, "$dir/重命名.txt", "")
            assertTrue(files.list(project.id, "").any { it.name == "重命名.txt" })
            files.delete(project.id, "重命名.txt")
            files.delete(project.id, dir)
            passed("Files create / UTF-8 read-write / 409 conflict / rename / move / delete")
            val git = GitApi(base, token)
            assertTrue(git.status(project.id).isRepo)
            val branch = "acceptance-$suffix"
            git.createBranch(project.id, branch)
            git.checkout(project.id, branch)
            val filename = "acceptance-$suffix.txt"
            files.create(project.id, filename, "file")
            files.write(project.id, filename, "Git Windows 中文\n", null)
            assertTrue(git.status(project.id).files.any { it.path == filename })
            git.stage(project.id, listOf(filename))
            assertTrue(git.diff(project.id, filename, true).diff.contains("Git Windows"))
            git.unstage(project.id, listOf(filename))
            git.stage(project.id, listOf(filename))
            git.commit(project.id, "Windows Android SSH acceptance $suffix")
            assertTrue(git.status(project.id).files.none { it.path == filename })
            assertEquals(branch, git.status(project.id).branch)
            passed("Git status / branch / stage / diff / unstage / commit")
            val first = TerminalProbe(base, token, project.id).also { sockets.add(it) }
            first.ready()
            first.input("\$sscodeAcceptance='$suffix'; Write-Output ('中文-' + \$sscodeAcceptance)\r\n")
            first.outputContaining("中文-$suffix")
            passed("Terminal WebSocket / real PowerShell execution / UTF-8")
            // Drop the entire SSH tunnel, not just the WebSocket. Shell must survive.
            connection.close()
            first.close()
            delay(1000)
            connection = AppContainer.ssh(context).connect(server)
            val reconnected = api(connection)
            base = reconnected.first; token = reconnected.second
            api = SscodeApi(base, token)
            assertTrue(api.listProjects().any { it.id == project.id })
            val second = TerminalProbe(base, token, project.id).also { sockets.add(it) }
            second.ready()
            second.outputContaining("中文-$suffix")
            second.input("Write-Output ('RESUMED-' + \$sscodeAcceptance)\r\n")
            second.outputContaining("RESUMED-$suffix")
            second.input("exit\r\n")
            passed("Full SSH disconnect / REST reconnect / terminal replay / same shell variable survives")
            val ide = IdeApi(base, token).status()
            val access = IdeApi(base, token).access()
            assertTrue(access.wsl)
            assertNull(access.password)
            if (ide.running) {
                passed("WSL IDE status and access DTO")
            } else {
                assertTrue(ide.hostUnsupported)
                passed("Windows IDE unavailable / explicit WSL guidance status")
            }
            passed("PROJECT_ID=${project.id}")
        } finally {
            sockets.forEach { it.close() }
            connection.close()
        }
    }

    @Test fun aiSurvivesDisconnect(): Unit = runBlocking {
        val model = args.getString("modelId")
        assumeTrue("Explicit model required (report whether provider is real or scripted)", model != null)
        val server = server()
        var connection = AppContainer.ssh(context).connect(server)
        try {
            var (base, token) = api(connection)
            var api = SscodeApi(base, token)
            val path = requireNotNull(args.getString("projectPath"))
            val project = api.listProjects().single { it.path.replace('\\', '/') == path.replace('\\', '/') }
            val session = api.createSession(project.id, "Windows ${args.getString("providerKind") ?: "real"} AI acceptance")
            val suffix = UUID.randomUUID().toString().take(8)
            val filename = "ai-$suffix.txt"
            val prompt = "Windows acceptance test. Only in this project, create $filename with exact UTF-8 content WINDOWS_AI_OK_$suffix 中文. Read it back, then run a command to verify the file exists. Do not modify anything else. Finish with a short summary."
            val request = UUID.randomUUID().toString()
            val task = api.submitTask(project.id, session.id, prompt, request, model, "full").task
            assertEquals(task.id, api.submitTask(project.id, session.id, prompt, request, model, "full").task.id)
            val cursor = api.getEvents(0, project.id).cursor
            connection.close()
            delay(10000)
            connection = AppContainer.ssh(context).connect(server)
            val newApi = api(connection)
            base = newApi.first; token = newApi.second
            api = SscodeApi(base, token)
            val deadline = System.currentTimeMillis() + 180000
            var result = api.getTask(task.id)
            while (result.state in listOf("queued", "running") && System.currentTimeMillis() < deadline) {
                delay(1000); result = api.getTask(task.id)
            }
            assertEquals("AI task did not finish: ${result.state}", "completed", result.state)
            assertTrue(result.toolCalls.any { it.tool == "run_command" && it.state == "done" })
            assertTrue(FilesApi(base, token).content(project.id, filename).content.contains("WINDOWS_AI_OK_$suffix 中文"))
            assertTrue(api.getEvents(cursor, project.id).events.isNotEmpty())
            passed("AI provider=${args.getString("providerKind") ?: "real"} / idempotent submit / tools / command / offline continuation / events replay / UTF-8 file")
            passed("AI_TASK_ID=${task.id}")
        } finally { connection.close() }
    }

    @Test fun gitLocalRemoteRoundTrip(): Unit = runBlocking {
        val server = server()
        AppContainer.ssh(context).connect(server).use { connection ->
            val (base, token) = api(connection)
            val path = requireNotNull(args.getString("projectPath"))
            val project = SscodeApi(base, token).listProjects().single {
                it.path.replace('\\', '/') == path.replace('\\', '/')
            }
            // Only run against the explicitly prepared local bare test repository.
            assumeTrue(args.getString("localGitRemote") == "true")
            val git = GitApi(base, token)
            assertTrue(git.push(project.id).ok)
            assertTrue(git.pull(project.id).ok)
            assertEquals(0, git.status(project.id).ahead)
            assertEquals(0, git.status(project.id).behind)
            passed("Git push / pull through SSH against isolated local bare remote")
        }
    }

    private class TerminalProbe(base: String, token: String, project: String) {
        private val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.SECONDS).build()
        private val queue = LinkedBlockingQueue<JsonObject>()
        private val output = StringBuilder()
        private val ws = client.newWebSocket(Request.Builder()
            .url(base.replaceFirst("http://", "ws://") + "/terminal/ws?projectId=$project")
            .header("Authorization", "Bearer $token").build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) { queue.offer(Json.parseToJsonElement(text).jsonObject) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                queue.offer(buildJsonObject { put("type", "failure"); put("message", t.javaClass.simpleName) })
            }
        })
        private fun next(): JsonObject = requireNotNull(queue.poll(20, TimeUnit.SECONDS)) { "Timed out waiting for terminal" }
        fun ready() {
            while (true) {
                val m = next()
                val type = m["type"]?.jsonPrimitive?.content
                if (type == "output") output.append(m["data"]!!.jsonPrimitive.content)
                if (type == "ready") { assertEquals("persist", m["backend"]!!.jsonPrimitive.content); return }
                check(type !in listOf("failure", "error", "exit")) { "Terminal closed before ready" }
            }
        }
        fun input(command: String) { check(ws.send(buildJsonObject { put("type", "input"); put("data", command) }.toString())) }
        fun outputContaining(marker: String) {
            val deadline = System.currentTimeMillis() + 20000
            while (!output.contains(marker) && System.currentTimeMillis() < deadline) {
                val m = next()
                check(m["type"]?.jsonPrimitive?.content !in listOf("failure", "error", "exit")) { "Terminal closed before output" }
                if (m["type"]?.jsonPrimitive?.content == "output") output.append(m["data"]!!.jsonPrimitive.content)
            }
            assertTrue("Expected terminal marker $marker", output.contains(marker))
        }
        fun close() { ws.cancel(); client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll() }
    }
}
