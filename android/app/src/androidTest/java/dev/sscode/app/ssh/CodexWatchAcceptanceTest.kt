package dev.sscode.app.ssh

import androidx.test.platform.app.InstrumentationRegistry
import dev.sscode.app.AppContainer
import dev.sscode.app.api.ApiException
import dev.sscode.app.api.SscodeApi
import dev.sscode.app.data.CredentialStore
import dev.sscode.app.data.ServerEntity
import dev.sscode.app.deploy.Deployer
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Opt-in Codex watch acceptance (project scope) through the actual Android SSH/API clients.
 * Requires a saved server running sscode-server with Codex watch support, trusted fingerprint
 * via instrumentation args, and projectPath matching an existing project on that server.
 * Hosts without Codex Desktop/CLI data exercise only the degraded (available=false) contract.
 * No credentials are logged.
 */
class CodexWatchAcceptanceTest {
    private val args = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private fun passed(step: String) = android.util.Log.i("CodexWatchAcceptance", "PASS $step")

    private suspend fun server(): ServerEntity {
        val id = args.getString("serverId")?.toLongOrNull()
        assumeTrue("Explicit saved server required", id != null)
        val dao = AppContainer.database(context).serverDao()
        val saved = requireNotNull(dao.getById(id!!))
        val expected = requireNotNull(args.getString("fingerprint"))
        val ref = saved.credentialRef ?: "codex-watch-acceptance-$id"
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

    @Test fun codexWatchProjectScopeThroughSsh(): Unit = runBlocking {
        val path = requireNotNull(args.getString("projectPath"))
        val server = server()
        AppContainer.ssh(context).connect(server).use { connection ->
            val token = Deployer(context).connectExisting(connection)
            val port = connection.startLocalForward(remotePort = 7823)
            val api = SscodeApi("http://127.0.0.1:$port/v1", token)
            passed("SSH authentication / tunnel / legacy token retrieval")
            val project = api.listProjects().single { it.path.replace('\\', '/') == path.replace('\\', '/') }
            val list = api.listCodexTasks(project.id)
            // available 字段必须存在且为布尔（DTO 非空即证明）；两种取值都合法
            passed("GET /v1/projects/:id/codex/tasks 200 / available=${list.available} / taskCount=${list.tasks.size}")
            assumeTrue("No Codex threads for this project on the host", list.available && list.tasks.isNotEmpty())
            val states = setOf("running", "paused", "failed", "queued", "done", "idle")
            list.tasks.forEach { task ->
                assertTrue("unknown progress.state: ${task.progress.state}", task.progress.state in states)
            }
            val first = list.tasks.first()
            val detail = api.getCodexTask(project.id, first.id)
            assertEquals(first.id, detail.task?.id)
            assertNotNull(detail.messages)
            assertNotNull(detail.queuedTasks)
            passed("Project task list / progress states / detail messages structure")
            try {
                api.getCodexTask(project.id, "codex-watch-nonexistent-thread")
                fail("Thread outside the project accepted")
            } catch (e: ApiException) {
                assertEquals(404, e.httpStatus)
            }
            passed("Foreign/unknown thread id returns 404")
        }
    }
}
