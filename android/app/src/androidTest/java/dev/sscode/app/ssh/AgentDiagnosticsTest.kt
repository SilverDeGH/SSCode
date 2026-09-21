package dev.sscode.app.ssh

import androidx.test.platform.app.InstrumentationRegistry
import dev.sscode.app.AppContainer
import dev.sscode.app.ui.connectToApi
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.Assume.assumeTrue

/** Explicit opt-in; never logs keys or credential storage. */
class AgentDiagnosticsTest {
    @Test fun diagnoseSavedGpt6(): Unit = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val serverId = args.getString("serverId")?.toLongOrNull()
        assumeTrue(serverId != null)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val server = AppContainer.database(context).serverDao().getById(serverId!!) ?: error("Saved server not found")
        check(server.hostFingerprint != null)
        val conn = connectToApi(AppContainer.ssh(context), AppContainer.credentials(context), server)
        try {
            val agents = conn.api.listAgents().filter { it.model.contains("gpt", true) || it.name.contains("gpt", true) }
            android.util.Log.i("AgentDiagnostics", "GPT configurations: ${agents.size}")
            for (agent in agents) {
                val uri = java.net.URI(agent.baseUrl)
                android.util.Log.i("AgentDiagnostics", "endpoint=${uri.scheme}://${uri.host}:${uri.port}${uri.path}")
                if (uri.scheme in listOf("http", "https") && uri.userInfo == null && uri.query == null && !agent.baseUrl.contains("'")) {
                    val probe = conn.session.exec("curl -I -sS --connect-timeout 10 --max-time 15 '${agent.baseUrl}' 2>&1", 20)
                    android.util.Log.i("AgentDiagnostics", "network probe exit=${probe.exitCode}: ${probe.stdout.take(1200)}")
                }
                val result = conn.api.testAgent(agent.id)
                android.util.Log.i("AgentDiagnostics", "model=${agent.model} ok=${result.ok} detail=${result.detail}")
            }
        } finally { conn.close() }
    }
}
