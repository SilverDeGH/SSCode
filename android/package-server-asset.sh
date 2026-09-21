#!/usr/bin/env bash
# 把 server/ 打成 assets 载荷，供 Deployer 经 SFTP 上传到服务器。
set -euo pipefail
cd "$(dirname "$0")/../server"
mkdir -p ../android/app/src/main/assets
tar --exclude=node_modules --exclude=test -cf ../android/app/src/main/assets/sscode-server.tar .
echo "wrote android/app/src/main/assets/sscode-server.tar"
