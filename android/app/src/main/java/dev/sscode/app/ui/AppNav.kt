package dev.sscode.app.ui

import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import dev.sscode.app.AppContainer
import dev.sscode.app.api.SessionManager

object Routes {
    const val SERVERS = "servers"
    const val SERVER_EDIT = "server/edit?serverId={serverId}"
    const val SERVER_DETAIL = "server/{serverId}"
    const val PROJECTS = "server/{serverId}/projects"
    const val WORKSPACE = "server/{serverId}/project/{projectId}/{projectName}?role={role}"
    const val BIND_DEVICE = "server/{serverId}/bind"
    const val DEVICE_SESSIONS = "server/{serverId}/devices"
    const val PROJECT_MEMBERS = "server/{serverId}/project/{projectId}/members"

    fun serverEdit(serverId: Long = -1L) = "server/edit?serverId=$serverId"
    fun serverDetail(serverId: Long) = "server/$serverId"
    fun projects(serverId: Long) = "server/$serverId/projects"
    fun workspace(serverId: Long, projectId: String, projectName: String, role: String = "owner") =
        "server/$serverId/project/$projectId/${Uri.encode(projectName)}?role=$role"
    fun bindDevice(serverId: Long) = "server/$serverId/bind"
    fun deviceSessions(serverId: Long) = "server/$serverId/devices"
    fun projectMembers(serverId: Long, projectId: String) = "server/$serverId/project/$projectId/members"
}

/**
 * 会话不可恢复（刷新失败）时跳回绑定页，并弹出当前页避免返回键死循环。
 */
@Composable
private fun ObserveSessionExpiry(nav: NavHostController, serverId: Long, popRoute: String) {
    val context = LocalContext.current
    val sessionManager = remember(serverId) { AppContainer.sessionManager(context, serverId) }
    val state by sessionManager.state.collectAsState()
    LaunchedEffect(state) {
        if (state == SessionManager.State.EXPIRED && sessionManager.hasRefreshToken) {
            nav.navigate(Routes.bindDevice(serverId)) {
                popUpTo(popRoute) { inclusive = true }
            }
        }
    }
}

/**
 * 界面内"重新绑定"入口：弹出到服务器详情页之上再进绑定页。
 * 无论当前页是从详情页还是项目列表进入，返回键都落回详情页（详情页无过期观察器，不会死循环）。
 */
private fun NavHostController.navigateToRebind(serverId: Long) {
    navigate(Routes.bindDevice(serverId)) {
        popUpTo(Routes.SERVER_DETAIL) { inclusive = false }
    }
}

@Composable
fun AppNav() {
    val nav = rememberNavController()
    NavHost(navController = nav, startDestination = Routes.SERVERS) {
        composable("appearance") { AppearanceScreen(onBack = { nav.popBackStack() }) }
        composable(Routes.SERVERS) {
            ServerListScreen(
                onAdd = { nav.navigate(Routes.serverEdit()) },
                onEdit = { id -> nav.navigate(Routes.serverEdit(id)) },
                onConnect = { id -> nav.navigate(Routes.serverDetail(id)) },
                onSettings = { nav.navigate("appearance") },
            )
        }
        composable(
            Routes.SERVER_EDIT,
            arguments = listOf(navArgument("serverId") { type = NavType.LongType; defaultValue = -1L }),
        ) { entry ->
            ServerEditScreen(
                serverId = entry.arguments?.getLong("serverId") ?: -1L,
                onDone = { nav.popBackStack() },
            )
        }
        composable(
            Routes.SERVER_DETAIL,
            arguments = listOf(navArgument("serverId") { type = NavType.LongType }),
        ) { entry ->
            val serverId = entry.arguments?.getLong("serverId") ?: return@composable
            ServerDetailScreen(
                serverId = serverId,
                onBack = { nav.popBackStack() },
                onOpenProjects = { id -> nav.navigate(Routes.projects(id)) },
                onBind = { id -> nav.navigate(Routes.bindDevice(id)) },
                onOpenDevices = { id -> nav.navigate(Routes.deviceSessions(id)) },
            )
        }
        composable(
            Routes.BIND_DEVICE,
            arguments = listOf(navArgument("serverId") { type = NavType.LongType }),
        ) { entry ->
            val serverId = entry.arguments?.getLong("serverId") ?: return@composable
            BindDeviceScreen(
                serverId = serverId,
                onBack = { nav.popBackStack() },
                onBound = { id ->
                    nav.navigate(Routes.projects(id)) {
                        popUpTo(Routes.SERVERS)
                    }
                },
            )
        }
        composable(
            Routes.DEVICE_SESSIONS,
            arguments = listOf(navArgument("serverId") { type = NavType.LongType }),
        ) { entry ->
            val serverId = entry.arguments?.getLong("serverId") ?: return@composable
            ObserveSessionExpiry(nav, serverId, Routes.DEVICE_SESSIONS)
            DeviceSessionsScreen(
                serverId = serverId,
                onBack = { nav.popBackStack() },
                onSignedOut = {
                    nav.navigate(Routes.serverDetail(serverId)) {
                        popUpTo(Routes.SERVERS)
                    }
                },
                onRebind = { nav.navigateToRebind(serverId) },
            )
        }
        composable(
            Routes.PROJECTS,
            arguments = listOf(navArgument("serverId") { type = NavType.LongType }),
        ) { entry ->
            val serverId = entry.arguments?.getLong("serverId") ?: return@composable
            ObserveSessionExpiry(nav, serverId, Routes.PROJECTS)
            ProjectListScreen(
                serverId = serverId,
                onBack = { nav.popBackStack() },
                onOpenProject = { projectId, projectName, role ->
                    nav.navigate(Routes.workspace(serverId, projectId, projectName, role))
                },
                onOpenMembers = { projectId ->
                    nav.navigate(Routes.projectMembers(serverId, projectId))
                },
                onOpenDevices = { nav.navigate(Routes.deviceSessions(serverId)) },
            )
        }
        composable(
            Routes.PROJECT_MEMBERS,
            arguments = listOf(
                navArgument("serverId") { type = NavType.LongType },
                navArgument("projectId") { type = NavType.StringType },
            ),
        ) { entry ->
            val serverId = entry.arguments?.getLong("serverId") ?: return@composable
            val projectId = entry.arguments?.getString("projectId") ?: return@composable
            // 与 WORKSPACE 同理：过期时连同项目列表一起弹出，避免项目页观察器把返回键弹回绑定页
            ObserveSessionExpiry(nav, serverId, Routes.PROJECTS)
            ProjectMembersScreen(
                serverId = serverId,
                projectId = projectId,
                onBack = { nav.popBackStack() },
                onRebind = { nav.navigateToRebind(serverId) },
            )
        }
        composable(
            Routes.WORKSPACE,
            arguments = listOf(
                navArgument("serverId") { type = NavType.LongType },
                navArgument("projectId") { type = NavType.StringType },
                navArgument("projectName") { type = NavType.StringType },
                navArgument("role") { type = NavType.StringType; defaultValue = "owner" },
            ),
        ) { entry ->
            val serverId = entry.arguments?.getLong("serverId") ?: return@composable
            val projectId = entry.arguments?.getString("projectId") ?: return@composable
            val projectName = entry.arguments?.getString("projectName") ?: ""
            val role = entry.arguments?.getString("role") ?: "owner"
            // 过期后弹出到绑定页时连同项目列表一起移除，避免返回键触发"项目页→绑定页"死循环
            ObserveSessionExpiry(nav, serverId, Routes.PROJECTS)
            WorkspaceScreen(
                serverId = serverId,
                projectId = projectId,
                projectName = projectName,
                projectRole = role,
                onBack = { nav.popBackStack() },
            )
        }
    }
}
