package dev.sscode.app.ssh

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import dev.sscode.app.AppContainer
import dev.sscode.app.deploy.EnvDetector
import dev.sscode.app.deploy.Deployer
import dev.sscode.app.api.FilesApi
import dev.sscode.app.api.FileListResponse
import dev.sscode.app.api.SscodeApi
import dev.sscode.app.api.IdeApi
import kotlinx.serialization.json.Json
import kotlinx.coroutines.runBlocking
import java.net.HttpURLConnection
import java.net.URL

/** Opt-in integration check using an existing emulator server and its encrypted credentials. */
@Suppress("DEPRECATION")
class SshConnectionTest {
    @Test
    fun fileListAcceptsFractionalAndIntegerTimestamps() {
        val result = Json.decodeFromString<FileListResponse>(
            """{"entries":[{"name":"existing.py","mtime":1789732013048.5527},{"name":"new.py","mtime":1789732013048}]}""",
        )
        assertEquals(2, result.entries.size)
        assertEquals(1789732013048L, result.entries.first().mtime.toLong())
        assertEquals(1789732013048L, result.entries.last().mtime.toLong())
    }

    @Test
    fun testSavedServerConnection(): Unit = runBlocking {
        val serverId = InstrumentationRegistry.getArguments().getString("serverId")?.toLongOrNull()
        assumeTrue("Pass -e serverId <saved server id> to run the remote integration test", serverId != null)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val server = AppContainer.database(context).serverDao().getById(serverId!!)
            ?: error("Configure the test server in the app first")
        check(server.hostFingerprint != null) { "Trust the server fingerprint in the app first" }
        AppContainer.ssh(context).connect(server).use { session ->
            android.util.Log.i("SshConnectionTest", "SSH authentication passed")
            val result = session.exec("printf sscode-ssh-ok", 10)
            assertEquals(0, result.exitCode)
            assertEquals("sscode-ssh-ok", result.stdout.trim())
            android.util.Log.i("SshConnectionTest", "SSH exec passed")
            val report = EnvDetector().detect(session)
            assertNotNull(report.osPrettyName)
            android.util.Log.i("SshConnectionTest", "Environment detection passed")
            val port = session.startLocalForward(remotePort = 7823)
            val connection = URL("http://127.0.0.1:$port/v1/health").openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 10000
                connection.readTimeout = 10000
                assertEquals(200, connection.responseCode)
                android.util.Log.i("SshConnectionTest", "SSH tunnel health passed")
            } finally {
                connection.disconnect()
            }
            val token = Deployer(context).connectExisting(session)
            assertEquals(64, token.length)
            android.util.Log.i("SshConnectionTest", "Existing service authorization passed")
            val base = "http://127.0.0.1:$port/v1"
            val agentApi = SscodeApi(base, token)
            if (InstrumentationRegistry.getArguments().getString("catalog") == "true") {
                val agent = agentApi.listAgents().first { it.isDefault }
                val models = agentApi.modelCatalog(agent.id).models
                assertTrue(models.isNotEmpty())
                val unchanged = agentApi.selectModel(agent.id, agent.model)
                assertEquals(agent.id, unchanged.id)
                android.util.Log.i("SshConnectionTest", "Model catalog and selection passed: ${models.size} models")
            }
            val idePort = session.startLocalForward(remotePort = 8080)
            assertEquals(port, session.startLocalForward(remotePort = 7823))
            assertEquals(idePort, session.startLocalForward(remotePort = 8080))
            SscodeApi(base, token).listProjects()
            val ideStatus = IdeApi(base, token).status()
            if (ideStatus.running) {
                val ideConnection = URL("http://127.0.0.1:$idePort/").openConnection() as HttpURLConnection
                try {
                    ideConnection.connectTimeout = 10000
                    ideConnection.readTimeout = 10000
                    assertEquals(200, ideConnection.responseCode)
                } finally { ideConnection.disconnect() }
            }
            SscodeApi(base, token).health()
            android.util.Log.i("SshConnectionTest", "Concurrent API and IDE tunnels passed; IDE running=${ideStatus.running}")
            InstrumentationRegistry.getArguments().getString("projectPath")?.let { path ->
                val apiPort = session.startLocalForward(remotePort = 7823)
                val baseUrl = "http://127.0.0.1:$apiPort/v1"
                val project = SscodeApi(baseUrl, token).listProjects().single { it.path == path }
                val files = FilesApi(baseUrl, token).list(project.id, "")
                assertTrue("Expected existing project files", files.isNotEmpty())
                android.util.Log.i("SshConnectionTest", "Existing project file list passed: ${files.size} entries")
            }
        }
    }
}
