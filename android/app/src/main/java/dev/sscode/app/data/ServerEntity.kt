package dev.sscode.app.data

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Delete
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "servers")
data class ServerEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,
    val host: String,
    val port: Int = 22,
    val username: String,
    /** "password" | "key" */
    val authType: String,
    val saveCredential: Boolean,
    /** 加密存储（CredentialStore）里的 key；密码/私钥不落库 */
    val credentialRef: String? = null,
    /** OpenSSH 风格 SHA256 主机指纹，首次连接记录 */
    val hostFingerprint: String? = null,
    val lastStatus: String = "",
    val createdAt: Long = System.currentTimeMillis(),
)

@Dao
interface ServerDao {
    @Query("SELECT * FROM servers ORDER BY createdAt DESC")
    fun observeAll(): Flow<List<ServerEntity>>

    @Query("SELECT * FROM servers WHERE id = :id")
    suspend fun getById(id: Long): ServerEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(server: ServerEntity): Long

    @Update
    suspend fun update(server: ServerEntity)

    @Delete
    suspend fun delete(server: ServerEntity)

    @Query("UPDATE servers SET lastStatus = :status WHERE id = :id")
    suspend fun updateStatus(id: Long, status: String)

    @Query("UPDATE servers SET hostFingerprint = :fingerprint WHERE id = :id")
    suspend fun updateFingerprint(id: Long, fingerprint: String)
}

@Database(entities = [ServerEntity::class], version = 1, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun serverDao(): ServerDao
}
