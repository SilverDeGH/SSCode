package dev.sscode.app.ui

import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument

object Routes {
    const val SERVERS = "servers"
    const val SERVER_EDIT = "server/edit?serverId={serverId}"
    const val SERVER_DETAIL = "server/{serverId}"
    const val PROJECTS = "server/{serverId}/projects"
    const val WORKSPACE = "server/{serverId}/project/{projectId}/{projectName}"

    fun serverEdit(serverId: Long = -1L) = "server/edit?serverId=$serverId"
    fun serverDetail(serverId: Long) = "server/$serverId"
    fun projects(serverId: Long) = "server/$serverId/projects"
    fun workspace(serverId: Long, projectId: String, projectName: String) =
        "server/$serverId/project/$projectId/${Uri.encode(projectName)}"
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
            )
        }
        composable(
            Routes.PROJECTS,
            arguments = listOf(navArgument("serverId") { type = NavType.LongType }),
        ) { entry ->
            val serverId = entry.arguments?.getLong("serverId") ?: return@composable
            ProjectListScreen(
                serverId = serverId,
                onBack = { nav.popBackStack() },
                onOpenProject = { projectId, projectName ->
                    nav.navigate(Routes.workspace(serverId, projectId, projectName))
                },
            )
        }
        composable(
            Routes.WORKSPACE,
            arguments = listOf(
                navArgument("serverId") { type = NavType.LongType },
                navArgument("projectId") { type = NavType.StringType },
                navArgument("projectName") { type = NavType.StringType },
            ),
        ) { entry ->
            val serverId = entry.arguments?.getLong("serverId") ?: return@composable
            val projectId = entry.arguments?.getString("projectId") ?: return@composable
            val projectName = entry.arguments?.getString("projectName") ?: ""
            WorkspaceScreen(
                serverId = serverId,
                projectId = projectId,
                projectName = projectName,
                onBack = { nav.popBackStack() },
            )
        }
    }
}
