# DroneScanner

ESP32 无人机 Remote ID 侦测器 —— 基于 Wi-Fi 混杂模式监听周边无人机广播的 Remote ID 信号（兼容大疆 DJI 私有协议与 ASTM F3411 标准格式），实时解析无人机的位置、高度、速度、序列号等信息，并自动识别大疆机型。

## 功能特性

- 监听 NAN action frame 与 RID Beacon 两类 Remote ID 广播帧
- 自动识别大疆机型（Mavic / Mini / Air / Avata / Neo / FPV / Matrice 等约 30 种）及类别（消费级 / 穿越机 / 行业级）
- RSSI 测距估算（支持校准）、广播速率统计、RSSI 变化趋势、飞行轨迹历史
- USB CDC 串口 + 低功耗蓝牙（Nordic UART Service）双通道控制，自动切换
- 板载 WS2812 RGB 状态灯：模式 / 亮度 / 颜色 / 轮换速度可调，设置保存于 NVS 掉电不丢
- 配套网页控制台（Web Serial / Web Bluetooth）：目标列表、系统状态、灯效设置

## 目录结构

```
DroneScanner-main/
├── DroneScanner/          # 历史版本固件（含伪造发射功能）
├── web/                   # 历史版本网页控制台
└── clean/                 # ★ 清理版（已移除全部伪造发射功能，仅保留侦测）
    ├── DroneScanner/      #   清理后固件源码（Arduino 工程）
    └── web/               #   清理后网页控制台
```

## 硬件要求

- ESP32-C3 或 ESP32-S3 开发板（如 S3 SuperMini、DevKitC-1）
- 板载 RGB 灯默认引脚：GPIO8（S3 SuperMini）/ GPIO48（S3 DevKitC-1），其它型号请修改源码中 `RGB_PIN_A` / `RGB_PIN_B`

## 编译烧录（Arduino IDE）

1. 安装 [Arduino IDE 2.x](https://www.arduino.cc/en/software)
2. 「开发板管理器」中安装 **esp32 by Espressif Systems**
3. 打开 `clean/DroneScanner/DroneScanner.ino`
4. 工具菜单选择开发板（如 **ESP32C3 Dev Module** 或对应 S3 型号）
5. 启用 **USB CDC On Boot: Enabled**，Flash Size 按实际板载 Flash 选择
6. 选择端口，点击上传；串口监视器波特率 **115200**

> 无需额外第三方库，Wi-Fi / BLE / RMT / 温度传感器驱动均为 esp32 核心自带。

## 使用方法

1. **上电**：绿灯常亮表示侦测模式就绪；开机 5 秒内若未收到任何 USB 命令，会自动打开蓝牙广播供手机直连
2. **连接设备**：
   - USB 方式：电脑 Chrome/Edge 打开网页 → 点击「连接设备」→ 选择 ESP32 串口
   - 蓝牙方式：手机浏览器通过 Web Bluetooth 直连（无需数据线）
   - 注意：Web Serial / Web Bluetooth 需要 HTTPS 或 localhost 环境。可将 `web/` 目录部署到 GitHub Pages，或本地起一个静态服务器访问
3. **侦测**：「侦测」页实时显示周边无人机的坐标、高度、速度、机型、信号强度与距离估算
4. **校准**：「状态」页的校准入口可设置 1 米处信号强度 P0 与衰减系数 n，提高测距精度
5. **状态**：「状态」页查看 CPU 占用、内存、芯片温度、射频功率等运行信息

### 串口命令参考

单行 ASCII 命令，回车结束，不分大小写；回复为一行 `JSON:` + JSON：

| 命令 | 说明 |
|---|---|
| `PING` | 连通性测试 |
| `SYS` | 系统状态 JSON |
| `DRONES` | 侦测目标列表 JSON |
| `CLEAR` | 清空目标列表 |
| `PRUNE` | 删除失联目标 |
| `CAL` | 查询校准参数 |
| `CAL p0=-40&n=2.5` | 设置校准参数（P0/衰减系数） |
| `CAL reset=1` | 恢复默认校准 |
| `LED` | 查询灯效配置 |
| `LED mode=1&r=0&g=255&b=0&bright=100` | 设置灯效（mode: 0状态联动/1单色/2轮换/3关闭） |
| `BTON` / `BTOFF` | 手动开 / 关蓝牙 |

## 许可证

CC BY-NC-ND 4.0（署名-非商业性使用-禁止演绎）

本项目采用知识共享 署名-非商业性使用-禁止演绎 4.0 国际许可协议进行许可：

- **署名（BY）**：使用或分发时必须注明原作者及来源
- **非商业性使用（NC）**：不得将本作品用于商业目的
- **禁止演绎（ND）**：不得修改、转换或基于本作品二次创作，仅可原样分发

许可证全文：<https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode>

> 注：源码中内嵌的 OpenDroneID 相关文件（`opendroneid.c/.h`、`odid_wifi.h` 等）仍遵循其原始 Apache-2.0 许可证。
