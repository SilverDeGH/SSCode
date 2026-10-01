package dev.sscode.app

import android.content.Context
import androidx.room.Room
import dev.sscode.app.api.SessionManager
import dev.sscode.app.data.AppDatabase
import dev.sscode.app.data.CredentialStore
import dev.sscode.app.ssh.SshManager

/** 轻量依赖容器（单例），供各界面取用 db / 凭据 / SSH。 */
object AppContainer {

    @Volatile
    private var database: AppDatabase? = null

    @Volatile
    private var credentialStore: CredentialStore? = null

    @Volatile
    private var sshManager: SshManager? = null

    fun database(context: Context): AppDatabase =
        database ?: synchronized(this) {
            database ?: Room.databaseBuilder(
                context.applicationContext,
                AppDatabase::class.java,
                "sscode.db",
            ).build().also { database = it }
        }

    fun credentials(context: Context): CredentialStore =
        credentialStore ?: synchronized(this) {
            credentialStore ?: CredentialStore(context.applicationContext).also { credentialStore = it }
        }

    fun ssh(context: Context): SshManager =
        sshManager ?: synchronized(this) {
            sshManager ?: SshManager(credentials(context)).also { sshManager = it }
        }

    private val sessionManagers = HashMap<Long, SessionManager>()

    /** 每台服务器一个 SessionManager，UI 与 API 客户端共享同一会话状态。 */
    fun sessionManager(context: Context, serverId: Long): SessionManager =
        sessionManager(credentials(context), serverId)

    fun sessionManager(credentials: CredentialStore, serverId: Long): SessionManager =
        synchronized(this) {
            sessionManagers.getOrPut(serverId) { SessionManager(serverId, credentials) }
        }
}
