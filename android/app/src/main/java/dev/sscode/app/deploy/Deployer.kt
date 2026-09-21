package dev.sscode.app.deploy

import android.content.Context
import dev.sscode.app.api.SscodeApi
import dev.sscode.app.ssh.ExecResult
import dev.sscode.app.ssh.SshSession
import java.io.File

enum class DeployStage {
    CHECK,
    NODE,
    UPLOAD,
    SERVICE,
    START,
    TOKEN,
}

/** 部署失败：携带失败阶段与可复制的错误摘要（需求 4.4）。 */
class DeployException(
    val stage: DeployStage,
    message: String,
    cause: Throwable? = null,
) : Exception("[$stage] $message", cause)

/**
 * 分阶段在服务器用户目录下部署 sscode-server，可重复执行（已完成阶段自动跳过）。
 * 成功后返回从 journalctl 提取的 API auth token。
 */
class Deployer(private val context: Context) {

    companion object {
        private const val NODE_VERSION = "v24.9.0"
        private const val REMOTE_PORT = 7823
        private const val SERVICE_NAME = "sscode-server"
        private const val ASSET_NAME = "sscode-server.tar"

        private val SERVICE_FILE = """
            [Unit]
            Description=SScode companion service
            After=network-online.target

            [Service]
            Type=simple
            Environment=SSCODE_DATA_DIR=%h/.sscode
            Environment=SSCODE_PORT=$REMOTE_PORT
            ExecStart=%h/.local/opt/node-current/bin/node %h/sscode/app/src/index.ts
            Restart=on-failure
            RestartSec=3

            [Install]
            WantedBy=default.target
        """.trimIndent()
    }

    suspend fun deploy(
        session: SshSession,
        onProgress: (stage: DeployStage, message: String) -> Unit,
    ): String {
        // ① 探测现状，决定跳过哪些阶段
        onProgress(DeployStage.CHECK, "检查现有环境")
        val nodeInstalled = run(session, "\"\$HOME/.local/opt/node-current/bin/node\" --version 2>/dev/null || node --version 2>/dev/null || true")
            .stdout.trim().startsWith("v")
        val serviceActive = run(session, "systemctl --user is-active $SERVICE_NAME 2>/dev/null || true")
            .stdout.trim() == "active"
        if (serviceActive) {
            val token = connectExisting(session)
            val port = session.startLocalForward(remotePort = REMOTE_PORT)
            val api = SscodeApi("http://127.0.0.1:$port/v1", token)
            val activeStates = setOf("queued", "running", "awaiting_input", "awaiting_approval", "stopping")
            for (project in api.listProjects()) {
                if (api.listTasks(project.id).any { it.state in activeStates }) {
                    throw DeployException(DeployStage.CHECK, "服务器仍有活动任务，请等待完成或停止任务后再更新服务")
                }
            }
        }

        // ② Node.js
        if (nodeInstalled) {
            onProgress(DeployStage.NODE, "Node.js 已就绪，跳过")
        } else {
            onProgress(DeployStage.NODE, "下载并安装 Node.js $NODE_VERSION（用户目录）")
            mustRun(
                session, DeployStage.NODE,
                """
                set -e
                mkdir -p "${'$'}HOME/.local/opt"
                arch=$(uname -m)
                case "${'$'}arch" in
                  aarch64|arm64) pkg=node-$NODE_VERSION-linux-arm64 ;;
                  *) pkg=node-$NODE_VERSION-linux-x64 ;;
                esac
                curl -fsSL -o /tmp/sscode-node.tar.xz "https://cdn.npmmirror.com/binaries/node/$NODE_VERSION/${'$'}pkg.tar.xz"
                tar -xJf /tmp/sscode-node.tar.xz -C "${'$'}HOME/.local/opt"
                ln -sfn "${'$'}HOME/.local/opt/${'$'}pkg" "${'$'}HOME/.local/opt/node-current"
                rm -f /tmp/sscode-node.tar.xz
                "${'$'}HOME/.local/opt/node-current/bin/node" --version
                """.trimIndent(),
                timeoutSec = 600,
            )
        }

        // ③ 上传并解压配套服务
        onProgress(DeployStage.UPLOAD, "上传 sscode-server")
        val tmp = File(context.cacheDir, "sscode-server-upload.tar.gz")
        try {
            context.assets.open(ASSET_NAME).use { input ->
                tmp.outputStream().use { output -> input.copyTo(output) }
            }
            try {
                session.upload(tmp.absolutePath, "/tmp/$ASSET_NAME")
            } catch (e: Exception) {
                throw DeployException(DeployStage.UPLOAD, "SFTP 上传失败: ${e.message}", e)
            }
        } finally {
            tmp.delete()
        }
        mustRun(
            session, DeployStage.UPLOAD,
            "set -e; mkdir -p \"\$HOME/sscode/app\"; " +
                "tar -xf /tmp/$ASSET_NAME -C \"\$HOME/sscode/app\"; rm -f /tmp/$ASSET_NAME",
        )

        // ④ systemd 用户服务
        onProgress(DeployStage.SERVICE, "写入 systemd 用户服务")
        mustRun(
            session, DeployStage.SERVICE,
            buildString {
                appendLine("set -e")
                appendLine("mkdir -p \"\$HOME/.config/systemd/user\"")
                appendLine("cat > \"\$HOME/.config/systemd/user/$SERVICE_NAME.service\" <<'SSCODE_SERVICE_EOF'")
                appendLine(SERVICE_FILE)
                appendLine("SSCODE_SERVICE_EOF")
            },
        )

        // ⑤ 启动并等待健康检查
        onProgress(DeployStage.START, "启动服务并等待健康检查")
        val start = mustRun(
            session, DeployStage.START,
            """
            set -e
            systemctl --user daemon-reload
            systemctl --user enable --now $SERVICE_NAME
            systemctl --user restart $SERVICE_NAME
            ok=no
            for i in $(seq 1 20); do
              if curl -fsS "http://127.0.0.1:$REMOTE_PORT/v1/health" >/dev/null 2>&1; then ok=yes; break; fi
              sleep 1
            done
            echo "HEALTH_${'$'}ok"
            """.trimIndent(),
            timeoutSec = 120,
        )
        if (!start.stdout.contains("HEALTH_yes")) {
            val log = run(session, "journalctl --user -u $SERVICE_NAME --no-pager -n 30 2>/dev/null || true").stdout
            throw DeployException(DeployStage.START, "服务健康检查未通过。最近日志:\n$log")
        }
        if (serviceActive && nodeInstalled) {
            onProgress(DeployStage.START, "服务已在运行，已完成重启")
        }

        // ⑥ 提取 API token
        onProgress(DeployStage.TOKEN, "获取 API 访问令牌")
        val token = connectExisting(session)
        onProgress(DeployStage.TOKEN, "部署完成")
        return token
    }

    /** Retrieve the existing service credential over authenticated SSH; verify before saving. */
    suspend fun connectExisting(session: SshSession): String {
        val token = extractAuthToken(session)
            ?: throw DeployException(
                DeployStage.TOKEN,
                "无法获取 auth token：未找到 ~/.sscode/auth-token 文件，也无法从服务日志提取（服务是否已启动？）",
            )
        val port = session.startLocalForward(remotePort = REMOTE_PORT)
        SscodeApi("http://127.0.0.1:$port/v1", token).listProjects()
        return token
    }

    /**
     * 依次尝试三种取 token 途径：
     * ① cat token 文件（Linux / PowerShell 均有 cat）
     * ② cmd 的 type（Windows OpenSSH 默认 shell 可能是 cmd）
     * ③ journalctl 日志（旧 Linux systemd 部署）
     */
    private suspend fun extractAuthToken(session: SshSession): String? {
        val attempts = listOf(
            "cat ~/.sscode/auth-token 2>/dev/null || true",
            "type \"%USERPROFILE%\\.sscode\\auth-token\" 2>nul",
            "journalctl --user -u $SERVICE_NAME --no-pager -n 500 2>/dev/null | grep 'auth token' | tail -n 1 || true",
        )
        for (command in attempts) {
            val out = try {
                run(session, command, timeoutSec = 15).stdout.trim()
            } catch (_: Exception) {
                continue
            }
            for (line in out.lines().map { it.trim() }.filter { it.isNotEmpty() }.asReversed()) {
                val token = line.substringAfterLast(':').trim().replace("\"", "").trim()
                if (token.matches(Regex("[a-fA-F0-9]{64}"))) return token
            }
        }
        return null
    }

    private suspend fun run(session: SshSession, command: String, timeoutSec: Int = 60): ExecResult =
        session.exec(command, timeoutSec)

    private suspend fun mustRun(
        session: SshSession,
        stage: DeployStage,
        command: String,
        timeoutSec: Int = 180,
    ): ExecResult {
        val result = try {
            session.exec(command, timeoutSec)
        } catch (e: Exception) {
            throw DeployException(stage, "命令执行失败: ${e.message}", e)
        }
        if (result.exitCode != 0) {
            throw DeployException(stage, "退出码 ${result.exitCode}。输出:\n${result.stderr.ifBlank { result.stdout }}")
        }
        return result
    }
}
