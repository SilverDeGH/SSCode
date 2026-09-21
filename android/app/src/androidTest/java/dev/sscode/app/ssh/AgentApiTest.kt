package dev.sscode.app.ssh

import dev.sscode.app.api.SscodeApi
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.net.ServerSocket
import kotlin.concurrent.thread

class AgentApiTest {
    @Test
    fun selectedAgentAndKeyAreSentToTheCorrectEndpoints(): Unit = runBlocking {
        ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1")).use { server ->
            val requests = java.util.concurrent.LinkedBlockingQueue<Pair<String, String>>()
            val responder = thread {
                listOf(
                    """{"id":"agent-test","name":"Test","baseUrl":"https://example.invalid/v1","model":"test-model"}""",
                    """{"models":[{"id":"agent-test","name":"Test","baseUrl":"https://example.invalid/v1","model":"test-model"}]}""",
                    """{"task":{"id":"task-test"},"deduplicated":false}""",
                ).forEach { response ->
                    server.accept().use { socket ->
                        val reader = socket.getInputStream().bufferedReader()
                        val first = reader.readLine()
                        var length = 0
                        while (true) {
                            val line = reader.readLine()
                            if (line.isEmpty()) break
                            if (line.startsWith("Content-Length:", true)) length = line.substringAfter(':').trim().toInt()
                        }
                        val chars = CharArray(length)
                        var read = 0
                        while (read < length) read += reader.read(chars, read, length - read)
                        requests.put(first to String(chars))
                        val bytes = response.toByteArray()
                        socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray() + bytes)
                    }
                }
            }
            val api = SscodeApi("http://127.0.0.1:${server.localPort}/v1", "test-token")
            val agent = api.createAgent("Test", "https://example.invalid/v1", "test-model", "synthetic-key")
            assertEquals(agent.id, api.listAgents().single().id)
            api.submitTask("project", "session", "test", "request", agent.id)
            responder.join(5000)
            val create = requests.take()
            assertTrue(create.first.startsWith("POST /v1/models "))
            assertEquals("synthetic-key", Json.parseToJsonElement(create.second).jsonObject["apiKey"]!!.jsonPrimitive.content)
            assertTrue(requests.take().first.startsWith("GET /v1/models "))
            val task = requests.take()
            assertEquals("agent-test", Json.parseToJsonElement(task.second).jsonObject["modelConfigId"]!!.jsonPrimitive.content)
        }
    }
}
