package dev.sscode.app.ssh

import dev.sscode.app.data.CredentialStore
import dev.sscode.app.data.ServerEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.connection.channel.direct.LocalPortForwarder
import net.schmizz.sshj.connection.channel.direct.Parameters
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.UserAuthException
import net.schmizz.sshj.userauth.password.PasswordUtils
import java.io.Closeable
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Security
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.bouncycastle.jce.provider.BouncyCastleProvider

// ------------------------------------------------------------------ 异常分类

/**
 * Android 系统自带的 "BC" provider 是被裁剪的 BouncyCastle，缺 X25519 等算法，
 * SSHJ 的 curve25519 密钥交换与加密私钥解密会因此失败。替换为依赖里完整的 bcprov。
 * TLS 走 Conscrypt，不受影响；该替换仅作用于本进程。
 */
private fun installFullBouncyCastle() {
    synchronized(Security::class.java) {
        // Android 系统裁剪版 BC 的类名也含 bouncycastle（com.android.org.bouncycastle…），必须精确匹配完整版类名
        if (Security.getProvider("BC")?.javaClass?.name != "org.bouncycastle.jce.provider.BouncyCastleProvider") {
            Security.removeProvider("BC")
            Security.addProvider(BouncyCastleProvider())
        }
    }
}

/** 连接失败的统一基类，便于 UI 区分提示（需求 13）。 */
open class SshConnectException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** 认证失败：密码错误、私钥错误、口令错误或未保存凭据。 */
class AuthenticationException(message: String, cause: Throwable? = null) : SshConnectException(message, cause)

/** 网络失败：无法连通、超时、被重置等。 */
class NetworkException(message: String, cause: Throwable? = null) : SshConnectException(message, cause)

/** 主机指纹与已记录不一致：阻断连接，需用户重新核验（需求 4.2）。 */
class HostKeyChangedException(
    val host: String,
    val expectedFingerprint: String,
    val actualFingerprint: String,
) : SshConnectException("host key changed for $host")

// ------------------------------------------------------------------ 结果类型

data class ExecResult(val exitCode: Int, val stdout: String, val stderr: String)

// ------------------------------------------------------------------ 会话

class SshSession internal constructor(
    private val ssh: SSHClient,
    /** 本次连接对端主机的 SHA256 指纹（首次连接时由调用方回存） */
    val hostFingerprint: String,
) : Closeable {

    private val closed = AtomicBoolean(false)
    private val forwarders = mutableMapOf<Pair<Int, Int>, Pair<LocalPortForwarder, Int>>()

    suspend fun exec(command: String, timeoutSec: Int = 60): ExecResult = withContext(Dispatchers.IO) {
        check(!closed.get()) { "session closed" }
        val session = ssh.startSession()
        try {
            val cmd = session.exec(command)
            val stdout = StringBuilder()
            val stderr = StringBuilder()
            val readFailure = AtomicReference<Exception?>(null)
            val outThread = thread(name = "ssh-exec-out", isDaemon = true) {
                try { cmd.inputStream.bufferedReader(Charsets.UTF_8).forEachLine { stdout.appendLine(it) } }
                catch (e: Exception) { readFailure.compareAndSet(null, e) }
            }
            val errThread = thread(name = "ssh-exec-err", isDaemon = true) {
                try { cmd.errorStream.bufferedReader(Charsets.UTF_8).forEachLine { stderr.appendLine(it) } }
                catch (e: Exception) { readFailure.compareAndSet(null, e) }
            }
            cmd.join(timeoutSec.toLong(), TimeUnit.SECONDS)
            outThread.join(5_000)
            errThread.join(5_000)
            readFailure.get()?.let { throw it }
            ExecResult(cmd.exitStatus ?: -1, stdout.toString(), stderr.toString())
        } finally {
            try {
                session.close()
            } catch (_: Exception) {
            }
        }
    }

    suspend fun upload(localPath: String, remotePath: String): Unit = withContext(Dispatchers.IO) {
        check(!closed.get()) { "session closed" }
        var sftp: SFTPClient? = null
        try {
            sftp = ssh.newSFTPClient()
            sftp.put(localPath, remotePath)
        } finally {
            try {
                sftp?.close()
            } catch (_: Exception) {
            }
        }
    }

    /**
     * 建立本地端口转发：127.0.0.1:<localPort> → 服务器 127.0.0.1:<remotePort>。
     * localPort 传 0 表示由系统分配空闲端口，返回实际端口。
     */
    suspend fun startLocalForward(localPort: Int = 0, remotePort: Int): Int = withContext(Dispatchers.IO) {
        synchronized(forwarders) {
            check(!closed.get()) { "session closed" }
            val key = localPort to remotePort
            forwarders[key]?.let { return@synchronized it.second }
            val socket = ServerSocket()
            try {
                socket.reuseAddress = true
                socket.bind(InetSocketAddress("127.0.0.1", localPort))
                val port = socket.localPort
                val params = Parameters("127.0.0.1", port, "127.0.0.1", remotePort)
                val fwd = ssh.newLocalPortForwarder(params, socket)
                forwarders[key] = fwd to port
                thread(name = "ssh-forward-$port", isDaemon = true) {
                    try {
                        fwd.listen()
                    } catch (_: IOException) {
                        // Session shutdown or transport failure.
                    } finally {
                        synchronized(forwarders) { forwarders.remove(key) }
                        runCatching { fwd.close() }
                    }
                }
                port
            } catch (e: Exception) {
                socket.close()
                throw e
            }
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val active = synchronized(forwarders) {
            forwarders.values.map { it.first }.also { forwarders.clear() }
        }
        active.forEach { runCatching { it.close() } }
        try {
            ssh.disconnect()
        } catch (_: Exception) {
        }
    }
}

// ------------------------------------------------------------------ 管理器

class SshManager(private val credentials: CredentialStore) {

    init {
        installFullBouncyCastle()
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 15_000

        /** 隧道空闲保活间隔（秒）：工作区/终端长驻页依赖长连接，心跳防止 NAT/服务端断开空闲会话。 */
        private const val KEEPALIVE_INTERVAL_SEC = 30

        /** OpenSSH 风格主机指纹："SHA256:" + Base64(SHA256(公钥 wire 格式))，无填充。 */
        fun fingerprint(key: PublicKey): String {
            val raw = Buffer.PlainBuffer().putPublicKey(key).compactData
            val digest = MessageDigest.getInstance("SHA-256").digest(raw)
            return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)
        }
    }

    /**
     * 建立 SSH 会话。
     * @param trustNewHostKey 为 true 时跳过指纹一致性校验（用户在指纹变化提示后选择"重新信任"）。
     */
    suspend fun connect(server: ServerEntity, trustNewHostKey: Boolean = false): SshSession =
        withContext(Dispatchers.IO) {
            val ssh = SSHClient()
            ssh.connectTimeout = CONNECT_TIMEOUT_MS
            ssh.timeout = CONNECT_TIMEOUT_MS
            // sshj 不在 Transport 上暴露 host key；在握手校验回调里捕获公钥，指纹由我们自行记录/比对
            val hostKey = AtomicReference<PublicKey?>()
            ssh.addHostKeyVerifier(object : HostKeyVerifier {
                override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
                    hostKey.set(key)
                    return true
                }

                override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
            })
            try {
                ssh.connect(server.host, server.port)

                val key = hostKey.get() ?: throw NetworkException("server host key unavailable")
                val fingerprint = fingerprint(key)
                val stored = server.hostFingerprint
                if (stored != null && stored != fingerprint && !trustNewHostKey) {
                    throw HostKeyChangedException(server.host, stored, fingerprint)
                }

                authenticate(ssh, server)
                ssh.connection.keepAlive.keepAliveInterval = KEEPALIVE_INTERVAL_SEC
                SshSession(ssh, fingerprint)
            } catch (e: SshConnectException) {
                closeQuietly(ssh)
                throw e
            } catch (e: UserAuthException) {
                closeQuietly(ssh)
                throw AuthenticationException("authentication failed for ${server.username}@${server.host}", e)
            } catch (e: IOException) {
                closeQuietly(ssh)
                throw NetworkException("cannot reach ${server.host}:${server.port}: ${e.message}", e)
            }
        }

    private fun authenticate(ssh: SSHClient, server: ServerEntity) {
        when (server.authType) {
            "key" -> {
                val pem = credentials.get(server.credentialRef, CredentialStore.KEY_PRIVATE_KEY_PEM)
                    ?: throw AuthenticationException("no saved private key; edit the server and save credentials")
                val passphrase = credentials.get(server.credentialRef, CredentialStore.KEY_KEY_PASSPHRASE)
                val passwordFinder = passphrase?.let { PasswordUtils.createOneOff(it.toCharArray()) }
                val keyProvider = try {
                    ssh.loadKeys(pem, null, passwordFinder)
                } catch (e: IOException) {
                    throw AuthenticationException("private key cannot be loaded (wrong passphrase or unsupported format)", e)
                }
                ssh.authPublickey(server.username, keyProvider)
            }
            else -> {
                val password = credentials.get(server.credentialRef, CredentialStore.KEY_SSH_PASSWORD)
                    ?: throw AuthenticationException("no saved password; edit the server and save credentials")
                ssh.authPassword(server.username, password)
            }
        }
    }

    private fun closeQuietly(ssh: SSHClient) {
        try {
            ssh.disconnect()
        } catch (_: Exception) {
        }
    }
}
