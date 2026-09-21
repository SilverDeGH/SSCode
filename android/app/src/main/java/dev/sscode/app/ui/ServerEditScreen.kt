package dev.sscode.app.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.sscode.app.AppContainer
import dev.sscode.app.R
import dev.sscode.app.data.CredentialStore
import dev.sscode.app.data.ServerEntity
import kotlinx.coroutines.launch
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerEditScreen(serverId: Long, onDone: () -> Unit) {
    val context = LocalContext.current
    val dao = remember { AppContainer.database(context).serverDao() }
    val credentials = remember { AppContainer.credentials(context) }
    val scope = rememberCoroutineScope()

    val isNew = serverId <= 0
    var existing by remember { mutableStateOf<ServerEntity?>(null) }
    var loaded by remember { mutableStateOf(isNew) }

    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("22") }
    var username by remember { mutableStateOf("") }
    var authType by remember { mutableStateOf("password") }
    var password by remember { mutableStateOf("") }
    var privateKeyPem by remember { mutableStateOf("") }
    var passphrase by remember { mutableStateOf("") }
    var saveCredential by remember { mutableStateOf(true) }

    // 无条件注册 launcher：挂接到 Activity 的 ActivityResultRegistry，
    // 避免随 authType 分支切换而反复注册/注销。
    val importLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri != null) {
            runCatching {
                context.contentResolver.openInputStream(uri)?.use { input ->
                    privateKeyPem = input.bufferedReader().readText()
                }
            }
        }
    }

    LaunchedEffect(serverId) {
        if (!isNew) {
            dao.getById(serverId)?.let { s ->
                existing = s
                name = s.name
                host = s.host
                port = s.port.toString()
                username = s.username
                authType = s.authType
                saveCredential = s.saveCredential
            }
            loaded = true
        }
    }

    fun save() {
        val portNum = port.toIntOrNull() ?: 22
        val keepRef = existing?.credentialRef
        val credentialRef = when {
            !saveCredential -> null
            keepRef != null -> keepRef
            else -> "ssh-${UUID.randomUUID()}"
        }
        val entity = ServerEntity(
            id = existing?.id ?: 0,
            name = name.trim().ifBlank { host.trim() },
            host = host.trim(),
            port = portNum,
            username = username.trim(),
            authType = authType,
            saveCredential = saveCredential,
            credentialRef = credentialRef,
            hostFingerprint = existing?.hostFingerprint,
            lastStatus = existing?.lastStatus ?: "",
            createdAt = existing?.createdAt ?: System.currentTimeMillis(),
        )
        scope.launch {
            if (existing == null) {
                dao.insert(entity)
            } else {
                dao.update(entity)
            }
            if (!saveCredential) {
                credentials.deleteAll(keepRef)
            } else if (credentialRef != null) {
                if (password.isNotBlank()) {
                    credentials.set(credentialRef, CredentialStore.KEY_SSH_PASSWORD, password)
                }
                if (privateKeyPem.isNotBlank()) {
                    credentials.set(credentialRef, CredentialStore.KEY_PRIVATE_KEY_PEM, privateKeyPem)
                }
                if (passphrase.isNotBlank()) {
                    credentials.set(credentialRef, CredentialStore.KEY_KEY_PASSPHRASE, passphrase)
                }
            }
            onDone()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(if (isNew) R.string.add_server else R.string.edit_server)) },
                navigationIcon = {
                    IconButton(onClick = onDone) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    val canSave = host.isNotBlank() && username.isNotBlank()
                    TextButton(onClick = { save() }, enabled = canSave && loaded) {
                        Text(stringResource(R.string.save))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        ) {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.field_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = host,
                onValueChange = { host = it },
                label = { Text(stringResource(R.string.field_host)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )
            OutlinedTextField(
                value = port,
                onValueChange = { port = it.filter(Char::isDigit) },
                label = { Text(stringResource(R.string.field_port)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text(stringResource(R.string.field_username)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )

            Text(
                stringResource(R.string.auth_type),
                modifier = Modifier.padding(top = 20.dp, bottom = 8.dp),
            )
            Row {
                FilterChip(
                    selected = authType == "password",
                    onClick = { authType = "password" },
                    label = { Text(stringResource(R.string.auth_password)) },
                    modifier = Modifier.padding(end = 8.dp),
                )
                FilterChip(
                    selected = authType == "key",
                    onClick = { authType = "key" },
                    label = { Text(stringResource(R.string.auth_key)) },
                )
            }

            if (authType == "password") {
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text(stringResource(R.string.field_password)) },
                    supportingText = {
                        if (existing?.credentialRef != null) {
                            Text(stringResource(R.string.credential_keep_hint))
                        }
                    },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                )
            } else {
                // 从文件导入私钥（需求 4.2：手机输入 PEM 不现实）
                OutlinedTextField(
                    value = privateKeyPem,
                    onValueChange = { privateKeyPem = it },
                    label = { Text(stringResource(R.string.field_private_key)) },
                    supportingText = {
                        if (existing?.credentialRef != null) {
                            Text(stringResource(R.string.credential_keep_hint))
                        }
                    },
                    minLines = 4,
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                )
                TextButton(
                    onClick = { importLauncher.launch(arrayOf("*/*")) },
                    modifier = Modifier.padding(top = 4.dp),
                ) {
                    Text(stringResource(R.string.import_key_file))
                }
                OutlinedTextField(
                    value = passphrase,
                    onValueChange = { passphrase = it },
                    label = { Text(stringResource(R.string.field_key_passphrase)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                )
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
            ) {
                Text(
                    stringResource(R.string.save_credential),
                    modifier = Modifier.weight(1f),
                )
                Switch(checked = saveCredential, onCheckedChange = { saveCredential = it })
            }
        }
    }
}
