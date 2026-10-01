package dev.sscode.app.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * 敏感凭据（SSH 密码 / 私钥 PEM / 私钥口令 / API token）统一存 EncryptedSharedPreferences。
 * 数据库存 credentialRef，真实值只在这里。
 */
class CredentialStore(private val context: Context) {

    companion object {
        private const val FILE_NAME = "sscode_credentials"

        const val KEY_SSH_PASSWORD = "ssh-password"
        const val KEY_PRIVATE_KEY_PEM = "private-key-pem"
        const val KEY_KEY_PASSPHRASE = "key-passphrase"
        const val KEY_API_TOKEN = "api-token"
        const val KEY_REFRESH_TOKEN = "refresh-token"
        const val KEY_DEVICE_ID = "device-id"

        fun apiTokenRef(serverId: Long) = "api-token-$serverId"
        fun refreshTokenRef(serverId: Long) = "refresh-token-$serverId"
        fun deviceIdRef(serverId: Long) = "device-id-$serverId"
    }

    @Volatile
    private var prefs: SharedPreferences? = null

    private fun prefs(): SharedPreferences {
        prefs?.let { return it }
        synchronized(this) {
            prefs?.let { return it }
            val created = try {
                createPrefs()
            } catch (e: Exception) {
                // Keystore 密钥失效 / 加密存储损坏：删除后重建（旧凭据无法恢复，要求用户重新输入）
                context.deleteSharedPreferences(FILE_NAME)
                createPrefs()
            }
            prefs = created
            return created
        }
    }

    private fun createPrefs(): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun set(ref: String, key: String, value: String) {
        prefs().edit().putString("$ref:$key", value).apply()
    }

    fun get(ref: String?, key: String): String? {
        if (ref == null) return null
        return prefs().getString("$ref:$key", null)
    }

    fun deleteAll(ref: String?) {
        if (ref == null) return
        val editor = prefs().edit()
        prefs().all.keys
            .filter { it.startsWith("$ref:") }
            .forEach { editor.remove(it) }
        editor.apply()
    }
}
