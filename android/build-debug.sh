#!/usr/bin/env bash
# SScode Android 调试包构建脚本（Git Bash）
# 工具链位于 tools/（JDK 17 + Android SDK + Gradle 8.10），不依赖系统安装。
set -e
cd "$(dirname "$0")"
export JAVA_HOME=E:/SSCode/tools/jdk
printf 'sdk.dir=E:/SSCode/tools/android-sdk\n' > local.properties
E:/SSCode/tools/gradle/bin/gradle assembleDebug "$@"
echo "APK: $(ls -la app/build/outputs/apk/debug/app-debug.apk)"
