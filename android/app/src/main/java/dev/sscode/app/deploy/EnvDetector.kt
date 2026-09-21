package dev.sscode.app.deploy

import dev.sscode.app.api.SscodeApi
import dev.sscode.app.ssh.SshSession
import java.util.Base64
import kotlinx.serialization.json.*

/** 服务器环境检测报告（需求 4.3），全部为只读探测，解析容错。 */
data class EnvReport(
    val osPrettyName: String? = null,
    val arch: String? = null,
    val cpuCores: Int? = null,
    val memTotalBytes: Long? = null,
    val diskFreeHomeBytes: Long? = null,
    val nodeVersion: String? = null,
    val gitOk: Boolean = false,
    val tmuxOk: Boolean = false,
    val systemdUserOk: Boolean = false,
    val lingerOk: Boolean = false,
    val codeServerVersion: String? = null,
    val sscodeServiceActive: Boolean = false,
    /** /v1/health 探测结果：服务端已运行（Windows 手动启动 / Linux systemd 均覆盖） */
    val serviceHealthy: Boolean = false,
    /** health 上报的宿主平台（win32 / linux / darwin），null 表示旧版服务端或服务未运行 */
    val platform: String? = null,
    /** health 上报的终端后端（tmux / persist / spawn…） */
    val terminalBackend: String? = null,
) {
    /** 完整工作区可运行的最小条件 */
    val workspaceReady: Boolean
        get() = nodeVersion != null && sscodeServiceActive

    /** 「连接已有服务」可用：health 通过即够（不依赖 systemd 探测） */
    val existingServiceReady: Boolean
        get() = serviceHealthy || workspaceReady

    /** 宿主为 Windows（health 上报 win32） */
    val isWindowsHost: Boolean
        get() = platform == "win32"
}

class EnvDetector {

    private suspend fun probe(session: SshSession, command: String): String = try {
        session.exec(command, timeoutSec = 20).stdout.trim()
    } catch (_: Exception) {
        ""
    }

    /** 平台显示名 */
    fun platformName(platform: String?): String? = when (platform) {
        null -> null
        "win32" -> "Windows"
        "linux" -> "Linux"
        "darwin" -> "macOS"
        else -> platform
    }

    suspend fun detect(session: SshSession): EnvReport {
        // health 探测优先（需求 4.3 的跨平台口径）：转发 7823 后调 /v1/health，
        // 服务运行中即得 platform/terminalBackend；不在运行时对端拒绝、快速失败
        val health = try {
            val port = session.startLocalForward(localPort = 0, remotePort = 7823)
            SscodeApi("http://127.0.0.1:$port/v1", "").health()
        } catch (_: Exception) {
            null
        }

        if (health?.platform == "win32") {
            // Works with both cmd and PowerShell as OpenSSH's default shell.
            val script = """
                [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
                ${'$'}os = Get-CimInstance Win32_OperatingSystem
                ${'$'}drive = [IO.Path]::GetPathRoot(${'$'}env:USERPROFILE).TrimEnd('\')
                ${'$'}disk = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + ${'$'}drive + "'")
                ${'$'}node = if (Get-Command node -ErrorAction SilentlyContinue) { & node --version }
                [ordered]@{
                    osPrettyName = ${'$'}os.Caption
                    arch = ${'$'}env:PROCESSOR_ARCHITECTURE
                    cpuCores = [Environment]::ProcessorCount
                    memTotalBytes = [long]${'$'}os.TotalVisibleMemorySize * 1024
                    diskFreeHomeBytes = ${'$'}disk.FreeSpace
                    nodeVersion = ${'$'}node
                    gitOk = [bool](Get-Command git -ErrorAction SilentlyContinue)
                } | ConvertTo-Json -Compress
            """.trimIndent()
            val encoded = Base64.getEncoder().encodeToString(script.toByteArray(Charsets.UTF_16LE))
            val data = try {
                Json.parseToJsonElement(probe(session,
                    "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded")).jsonObject
            } catch (_: Exception) { null }
            fun field(name: String) = data?.get(name)?.jsonPrimitive
            return EnvReport(
                osPrettyName = field("osPrettyName")?.contentOrNull ?: "Windows",
                arch = field("arch")?.contentOrNull,
                cpuCores = field("cpuCores")?.intOrNull,
                memTotalBytes = field("memTotalBytes")?.longOrNull,
                diskFreeHomeBytes = field("diskFreeHomeBytes")?.longOrNull,
                nodeVersion = field("nodeVersion")?.contentOrNull,
                gitOk = field("gitOk")?.booleanOrNull == true,
                sscodeServiceActive = true,
                serviceHealthy = true,
                platform = health.platform,
                terminalBackend = health.terminalBackend,
            )
        }

        val os = probe(session, "cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME=' | cut -d= -f2- | tr -d '\"'")
            .ifBlank { null }

        val arch = probe(session, "uname -m 2>/dev/null").ifBlank { null }

        val cpuCores = probe(session, "nproc 2>/dev/null").toIntOrNull()

        val memTotal = probe(session, "free -b 2>/dev/null | awk '/^Mem:/ {print \$2}'").toLongOrNull()

        val diskFree = probe(session, "df -B1 ~ 2>/dev/null | awk 'NR==2 {print \$4}'").toLongOrNull()

        val tools = probe(
            session,
            "for c in node git tmux systemctl; do " +
                "command -v \$c >/dev/null 2>&1 && echo \"\$c=yes\" || echo \"\$c=no\"; done",
        )
        val toolMap = tools.lines()
            .mapNotNull {
                val idx = it.indexOf('=')
                if (idx > 0) it.substring(0, idx) to (it.substring(idx + 1) == "yes") else null
            }
            .toMap()

        val nodeVersion = if (toolMap["node"] == true) {
            probe(session, "node --version 2>/dev/null").ifBlank { null }
        } else {
            // 可能装在 ~/.local（之前部署过但 PATH 未包含）
            probe(session, "\$HOME/.local/opt/node-current/bin/node --version 2>/dev/null").ifBlank { null }
        }

        val systemdState = if (toolMap["systemctl"] == true) {
            probe(session, "systemctl --user is-system-running 2>/dev/null")
        } else {
            ""
        }
        val systemdUserOk = systemdState == "running" || systemdState == "degraded"

        val linger = probe(session, "loginctl show-user \"\$USER\" -p Linger 2>/dev/null")
        val lingerOk = linger.lines().any { it.trim() == "Linger=yes" }

        // 与服务端 ideManager 的探测口径一致：PATH 之外还有 ~/.local/opt 用户目录安装。
        // 输出形如 "4.106.3 <hash> with Code 1.106.3"，只取首个字段的版本号。
        val codeServerVersion = probe(
            session,
            "(code-server --version 2>/dev/null || \"\$HOME/.local/opt/code-server-current/bin/code-server\" --version 2>/dev/null)" +
                " | head -n 1 | cut -d' ' -f1",
        ).ifBlank { null }

        val sscodeActive = if (toolMap["systemctl"] == true) {
            probe(session, "systemctl --user is-active sscode-server 2>/dev/null") == "active"
        } else {
            false
        }

        return EnvReport(
            osPrettyName = os,
            arch = arch,
            cpuCores = cpuCores,
            memTotalBytes = memTotal,
            diskFreeHomeBytes = diskFree,
            nodeVersion = nodeVersion,
            gitOk = toolMap["git"] == true,
            tmuxOk = toolMap["tmux"] == true,
            systemdUserOk = systemdUserOk,
            lingerOk = lingerOk,
            codeServerVersion = codeServerVersion,
            sscodeServiceActive = sscodeActive || health != null,
            serviceHealthy = health != null,
            platform = health?.platform,
            terminalBackend = health?.terminalBackend,
        )
    }
}
